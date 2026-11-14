import { CircuitElement } from "./element";
import { pointKey } from "./geometry";
import { type AnalysisMode, MnaSystem } from "./mna-system";
import { buildNetlist, type Netlist } from "./netlist";

/**
 * Conductance from every node to ground, as SPICE's GMIN. Parts still being wired float,
 * and without it their nodes have no solution.
 */
const NODE_GMIN = 1e-12;

/**
 * Newton iterations allowed for one time step before it counts as failed and is solved
 * in smaller steps. Like SPICE's ITL4, it stays low: a step stuck cycling between pieces
 * of a model gets through sooner in smaller steps than by iterating on.
 */
const MAX_STEP_ITERATIONS = 20;

/**
 * Newton iterations allowed for a step that is part of a divided one. These steps already
 * fall back on smaller ones, so a step that will not converge gives up sooner: a
 * comparator snapping over fails each division until the steps are short enough.
 */
const MAX_DIVIDED_STEP_ITERATIONS = 10;

/** How many equal parts a time step that fails to converge is retried in. */
const STEP_DIVISIONS = 4;

/**
 * The smallest step a failed one is divided into, in seconds. Steps divide down to this
 * however large the set step is: positive feedback, as in a comparator with hysteresis,
 * snaps over in nanoseconds, and a step only converges through it once it is shorter.
 */
const MIN_DIVIDED_STEP = 1e-12;

/** Newton iterations allowed for one DC solve at a given source level. */
const MAX_DC_ITERATIONS = 200;

const SINGULAR_MESSAGE =
  "The circuit has no unique solution. Look for a voltage source shorted by a wire, or a loop of voltage sources, wires and inductors.";

const CONVERGENCE_MESSAGE =
  "The simulation did not converge. Check for unrealistic component values.";

/** True when `element` does something in `hook`; wires and the like keep the empty default. */
function overrides(
  element: CircuitElement,
  hook: "startStep" | "stampStep" | "finishStep",
) {
  return element[hook] !== CircuitElement.prototype[hook];
}

/** An element's `nodes` and `volts`, read once so solves write its voltages directly. */
type PostVoltages = {
  nodes: readonly number[];
  volts: number[];
};

/** Returns the `nodes` and `volts` of each of `elements`. */
function postVoltagesOf(elements: readonly CircuitElement[]): PostVoltages[] {
  return elements.map(({ nodes, volts }) => ({ nodes, volts }));
}

/** A wire-like element's place in the wire network around one point. */
type ConductorEdge = {
  element: CircuitElement;
  other: string;
  isStart: boolean;
};

/** A post of an element that draws current from the node at its point. */
type PostRef = {
  element: CircuitElement;
  post: number;
};

/** One point of a wire network's spanning tree, in breadth-first order from its root. */
type TreePoint = {
  /** The elements' posts at this point, whose currents enter the network here. */
  posts: readonly PostRef[];
  /** Index of the parent point in the tree's order; -1 for the root. */
  parent: number;
  /** The conductor that joins it to its parent; null for the root. */
  edge: CircuitElement | null;
  /** True when the conductor's start is at the parent. */
  isStartAtParent: boolean;
};

/** One wire network's spanning tree, and the ground at its root if there is one. */
type Tree = {
  points: readonly TreePoint[];
  ground: CircuitElement | null;
};

/**
 * Wires and closed switches merge nodes, so the solve never sees their current. This
 * finds it from the currents of the other elements at each point, along a spanning tree
 * of each wire network; wires that close a loop carry none. The trees depend only on the
 * netlist, so they are built once and each update only sums currents.
 */
class ConductorCurrents {
  private readonly trees: Tree[] = [];
  /** Conductors and grounds: the elements whose current only this class finds. */
  private readonly owned: CircuitElement[] = [];
  /** Current entering each tree point's subtree, reused by every update. */
  private readonly totals: Float64Array;

  constructor(elements: readonly CircuitElement[]) {
    const edges = new Map<string, ConductorEdge[]>();
    const posts = new Map<string, PostRef[]>();
    const grounds = new Map<string, CircuitElement>();
    const labelPoints: string[] = [];

    /** Returns the list at `key`, and adds an empty one first when there is none. */
    const listAt = <T>(map: Map<string, T[]>, key: string) => {
      let list = map.get(key);

      if (!list) {
        list = [];
        map.set(key, list);
      }

      return list;
    };

    // Sort elements: conductors become edges, grounds become roots, others add posts.
    for (const element of elements) {
      const keys = element.posts().map(pointKey);

      if (element.isConductor()) {
        const [first, second] = element.conductorPosts();
        const start = keys[first];
        const end = keys[second];

        this.owned.push(element);

        if (start && end && start !== end) {
          listAt(edges, start).push({ element, other: end, isStart: true });
          listAt(edges, end).push({ element, other: start, isStart: false });
        }

        continue;
      }

      if (element.isGround() && keys[0]) {
        this.owned.push(element);
        grounds.set(keys[0], element);
        continue;
      }

      if (element.netName() !== null && keys[0]) {
        labelPoints.push(keys[0]);
      }

      keys.forEach((key, post) => listAt(posts, key).push({ element, post }));
    }

    // Current leaves a wire network at ground or a net label, so trees start there.
    const roots = [...grounds.keys(), ...labelPoints, ...edges.keys()];
    const visited = new Set<string>();
    let pointCount = 0;

    for (const root of roots) {
      if (visited.has(root)) {
        continue;
      }

      visited.add(root);

      const order = [root];

      const points: TreePoint[] = [
        {
          posts: posts.get(root) ?? [],
          parent: -1,
          edge: null,
          isStartAtParent: false,
        },
      ];

      // Walk breadth-first; an edge to a visited point closes a loop and carries none.
      for (let index = 0; index < order.length; index += 1) {
        const key = order[index] ?? root;

        for (const edge of edges.get(key) ?? []) {
          if (visited.has(edge.other)) {
            continue;
          }

          visited.add(edge.other);
          order.push(edge.other);
          points.push({
            posts: posts.get(edge.other) ?? [],
            parent: index,
            edge: edge.element,
            isStartAtParent: edge.isStart,
          });
        }
      }

      pointCount = Math.max(pointCount, points.length);
      this.trees.push({ points, ground: grounds.get(root) ?? null });
    }

    this.totals = new Float64Array(pointCount);
  }

  /** Sets the current of every conductor and ground from the other elements' currents. */
  update() {
    const { totals } = this;

    // Grounds a wire joins to another ground carry nothing of their own.
    for (const element of this.owned) {
      element.current = 0;
    }

    for (const { points, ground } of this.trees) {
      // Sum the current that the other elements push into each point.
      points.forEach(({ posts }, index) => {
        let total = 0;

        for (const { element, post } of posts) {
          total -= element.currentIntoPost(post);
        }

        totals[index] = total;
      });

      // Walk leaves first: each subtree's net current flows through its edge to the parent.
      for (let index = points.length - 1; index > 0; index -= 1) {
        const point = points[index];
        const total = totals[index] ?? 0;

        if (point?.edge) {
          point.edge.current = point.isStartAtParent ? -total : total;
          totals[point.parent] = (totals[point.parent] ?? 0) + total;
        }
      }

      if (ground) {
        ground.current = totals[0] ?? 0;
      }
    }
  }
}

/**
 * Solves one circuit over time or at its operating point. The interactive simulation
 * and every analysis share it. Elements keep their state across rebuilds, so editing a
 * running circuit picks up where it left off.
 */
export class Simulation {
  readonly elements: readonly CircuitElement[];
  readonly mode: AnalysisMode;
  readonly netlist: Netlist;
  readonly system: MnaSystem;
  readonly hasNonlinear: boolean;
  /**
   * True when every nonlinear element has an exact convergence test, so Newton stops as
   * soon as they all pass instead of solving once more to confirm.
   */
  private readonly hasExactConvergenceTests: boolean;
  time = 0;
  error: string | null = null;
  /**
   * The elements behind `error`: the ones at the node or branch that made the circuit
   * singular, or the ones still moving when Newton gave up. Empty while there is no error.
   */
  faults: readonly CircuitElement[] = [];
  /**
   * When false, steps leave the voltages of idle elements (wires, grounds, net labels:
   * the ones no step hook visits) and the currents through wires for
   * `updateIdleElements`. The interactive run calls it once a frame instead of every
   * step; analyses read every element after each step, so they keep the default.
   */
  updatesIdleElements = true;
  private isFactored = false;
  private readonly conductorCurrents: ConductorCurrents;
  /** The solution before the step being solved, to go back to when it fails. */
  private readonly previousSolution: Float64Array;
  /** Solves this one's failed steps in smaller ones; built on the first failure. */
  private finer: Simulation | null = null;
  /** Newton iterations a step may take before it counts as failed. */
  private maxStepIterations = MAX_STEP_ITERATIONS;
  /**
   * The elements that do something in each step hook or own a branch. Steps visit only
   * these, so the wires that make up most of a schematic cost nothing per step.
   */
  private readonly starting: readonly CircuitElement[];
  private readonly stamping: readonly CircuitElement[];
  private readonly finishing: readonly CircuitElement[];
  private readonly branched: readonly CircuitElement[];
  /**
   * Voltages solves write: every iteration for the elements that stamp one, after each
   * step for the others that take part in it, and on request for idle ones.
   */
  private readonly iteratedVoltages: readonly PostVoltages[];
  private readonly steppedVoltages: readonly PostVoltages[];
  private readonly idleVoltages: readonly PostVoltages[];
  private readonly idleElements: ReadonlySet<CircuitElement>;

  constructor(
    elements: readonly CircuitElement[],
    mode: AnalysisMode,
    timeStep: number,
  ) {
    this.elements = elements;
    this.mode = mode;
    this.netlist = buildNetlist(elements, mode);
    this.system = new MnaSystem(
      this.netlist.nodeCount,
      this.netlist.branchCount,
      mode,
      timeStep,
    );
    this.hasNonlinear = elements.some((element) => element.isNonlinear());
    this.hasExactConvergenceTests = elements.every(
      (element) => !element.isNonlinear() || element.hasExactConvergenceTest(),
    );
    this.conductorCurrents = new ConductorCurrents(elements);
    this.previousSolution = new Float64Array(this.system.solution.length);
    this.starting = elements.filter((element) =>
      overrides(element, "startStep"),
    );
    this.stamping = elements.filter((element) =>
      overrides(element, "stampStep"),
    );
    this.finishing = elements.filter((element) =>
      overrides(element, "finishStep"),
    );
    this.branched = elements.filter((element) => element.branchCount(mode) > 0);

    const iterated = new Set(this.stamping);

    const stepped = new Set(
      [...this.starting, ...this.finishing, ...this.branched].filter(
        (element) => !iterated.has(element),
      ),
    );

    this.idleElements = new Set(
      elements.filter(
        (element) => !iterated.has(element) && !stepped.has(element),
      ),
    );
    this.iteratedVoltages = postVoltagesOf(this.stamping);
    this.steppedVoltages = postVoltagesOf([...stepped]);
    this.idleVoltages = postVoltagesOf([...this.idleElements]);
    this.stampBase();

    // Seed the solution with the elements' last voltages for a warm start.
    for (const element of elements) {
      element.nodes.forEach((node, post) => {
        if (node > 0) {
          this.system.solution[node] = element.volts[post] ?? 0;
        }
      });
    }
  }

  /**
   * Stamps the constant base: every element, then GMIN from every node to ground.
   * Companion models keep values that depend on the time step, so a simulation stamps
   * again after one with another step has used its elements.
   */
  private stampBase() {
    this.system.beginBase();

    for (const element of this.elements) {
      element.stamp(this.system);
    }

    for (let node = 1; node < this.netlist.nodeCount; node += 1) {
      this.system.stampConductance(node, 0, NODE_GMIN);
    }

    this.isFactored = false;
  }

  /** Copies node voltages from the solution onto the posts of `elements`. */
  private applySolution(elements: readonly PostVoltages[]) {
    for (const { nodes, volts } of elements) {
      for (let post = 0; post < nodes.length; post += 1) {
        volts[post] = this.system.value(nodes[post] ?? 0);
      }
    }
  }

  /**
   * Returns the elements that stamp `unknown`: every element with a post on that node,
   * or the element that owns that branch.
   */
  private elementsAt(unknown: number) {
    const { nodeCount } = this.netlist;

    if (unknown < nodeCount) {
      return this.elements.filter(({ nodes }) => nodes.includes(unknown));
    }

    const branch = unknown - nodeCount;

    return this.elements.filter(
      (element) =>
        branch >= element.firstBranch &&
        branch < element.firstBranch + element.branchCount(this.mode),
    );
  }

  /** Runs Newton iterations at the current time and source level; false when they fail. */
  private iterate(maxIterations: number) {
    const { system } = this;
    const unsettled: CircuitElement[] = [];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      system.iteration = iteration;
      // The first solve factors the base matrix, so it needs a copy even when linear.
      system.beginStep(this.hasNonlinear || !this.isFactored);
      unsettled.length = 0;

      // Stamp each element and note the ones whose linearization point still moves.
      for (const element of this.stamping) {
        system.converged = true;
        element.stampStep(system);

        if (!system.converged) {
          unsettled.push(element);
        }
      }

      // The last solution already solves every element's equations.
      if (
        this.hasExactConvergenceTests &&
        unsettled.length === 0 &&
        iteration > 0
      ) {
        return true;
      }

      if (!system.solve(this.hasNonlinear || !this.isFactored)) {
        this.error = SINGULAR_MESSAGE;
        this.faults =
          system.lu.singularColumn < 0
            ? []
            : this.elementsAt(system.lu.singularColumn + 1);

        return false;
      }

      this.isFactored = true;
      this.applySolution(this.iteratedVoltages);

      if (!this.hasNonlinear || (unsettled.length === 0 && iteration > 0)) {
        return true;
      }
    }

    this.error = CONVERGENCE_MESSAGE;
    this.faults = unsettled;

    return false;
  }

  /**
   * Gives elements their voltages and branch currents and finishes their step, then
   * brings the idle elements up to date unless they wait for `updateIdleElements`.
   */
  private finish() {
    this.applySolution(this.steppedVoltages);

    for (const element of this.branched) {
      const count = element.branchCount(this.mode);

      for (let index = 0; index < count; index += 1) {
        element.setBranchCurrent(
          index,
          this.system.value(
            this.system.branchUnknown(element.firstBranch + index),
          ),
        );
      }
    }

    for (const element of this.finishing) {
      element.finishStep(this.system);
    }

    if (this.updatesIdleElements) {
      this.updateIdleElements();
    }
  }

  /** Gives the idle elements their voltages from the latest step and finds wire currents. */
  updateIdleElements() {
    this.applySolution(this.idleVoltages);
    this.conductorCurrents.update();
  }

  /**
   * Brings just `elements` up to date after a step that left idle elements waiting. A
   * wire, switch or ground needs every wire current, so that updates them all; other idle
   * elements only need their own voltages.
   */
  updateIdleElementsAmong(elements: readonly CircuitElement[]) {
    if (
      elements.some((element) => element.isConductor() || element.isGround())
    ) {
      this.updateIdleElements();

      return;
    }

    for (const element of elements) {
      if (this.idleElements.has(element)) {
        element.nodes.forEach((node, post) => {
          element.volts[post] = this.system.value(node);
        });
      }
    }
  }

  /**
   * Advances one time step; false once the circuit cannot be solved. A step Newton cannot
   * solve, as when a comparator snaps over, is solved in smaller steps instead.
   */
  step() {
    if (this.error) {
      return false;
    }

    this.system.time = this.time + this.system.timeStep;
    this.previousSolution.set(this.system.solution);

    for (const element of this.starting) {
      element.startStep(this.system);
    }

    if (this.iterate(this.maxStepIterations)) {
      this.finish();
    } else if (!this.canDivide() || !this.stepFiner()) {
      return false;
    }

    this.time = this.system.time;

    return true;
  }

  /** True when the failed step may be retried in smaller ones. */
  private canDivide() {
    return (
      this.error === CONVERGENCE_MESSAGE &&
      this.system.timeStep / STEP_DIVISIONS >= MIN_DIVIDED_STEP
    );
  }

  /**
   * Solves the step that just failed as `STEP_DIVISIONS` smaller ones, which divide in
   * turn when they fail. A failed step changes no stored state, so they start from the
   * solution before it. False when the smallest steps fail too.
   */
  private stepFiner() {
    const { system } = this;

    system.solution.set(this.previousSolution);
    // Only the elements that stamp had voltages from the failed iterations.
    this.applySolution(this.iteratedVoltages);
    this.error = null;
    this.faults = [];
    this.finer ??= new Simulation(
      this.elements,
      this.mode,
      system.timeStep / STEP_DIVISIONS,
    );

    const { finer } = this;

    finer.maxStepIterations = MAX_DIVIDED_STEP_ITERATIONS;
    finer.updatesIdleElements = this.updatesIdleElements;
    finer.stampBase();
    finer.system.solution.set(system.solution);
    finer.time = this.time;

    for (let part = 0; part < STEP_DIVISIONS && !finer.error; part += 1) {
      finer.step();
    }

    // Take the elements back at this simulation's time step.
    this.stampBase();
    system.solution.set(finer.system.solution);
    this.error = finer.error;
    this.faults = finer.faults;
    finer.error = null;
    finer.faults = [];

    return this.error === null;
  }

  /**
   * Solves the DC operating point. When Newton's method fails from a cold start, the
   * sources ramp up from zero in steps so each solve starts near the next.
   */
  solveOperatingPoint() {
    this.system.time = 0;
    this.system.sourceScale = 1;

    if (this.iterate(MAX_DC_ITERATIONS)) {
      this.finish();

      return true;
    }

    if (this.error === SINGULAR_MESSAGE) {
      return false;
    }

    // Reset the elements, then ramp the sources up in 20 equal steps.
    for (const element of this.elements) {
      element.reset();
    }

    for (let level = 1; level <= 20; level += 1) {
      this.error = null;
      this.faults = [];
      this.system.sourceScale = level / 20;

      if (!this.iterate(MAX_DC_ITERATIONS)) {
        return false;
      }
    }

    this.finish();

    return true;
  }
}
