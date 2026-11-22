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
 * fall back on shorter ones, so a step that will not converge gives up sooner.
 */
const MAX_DIVIDED_STEP_ITERATIONS = 10;

/**
 * How closely Newton must return to the solution of two or three iterations before, next
 * to how far it moved in the last one, to count as going around in a circle. A step that
 * does so will not converge within its iterations: a clamp inside positive feedback flips
 * on and off like this until the step is short enough. An oscillation that does die out
 * comes this close only when it shrinks by less than a tenth per iteration, too slowly to
 * settle in the iterations a step gets.
 */
const CYCLE_RATIO = 0.1;

/**
 * How many times shorter a step that fails is retried, and how many times longer each
 * one after a step that succeeds may be, up to the set step.
 */
const STEP_DIVISIONS = 4;

/**
 * How many times shorter each cached inner simulation steps than the one before it. The
 * steps through a breakpoint are the longest of these lengths an element allows, so
 * finer lengths waste less of it than `STEP_DIVISIONS` would.
 */
const CHAIN_DIVISIONS = 2;

/**
 * The shortest step a divided one is made of, in seconds. Positive feedback, as in a
 * comparator with hysteresis, snaps over in nanoseconds, and a step only converges
 * through it once it is shorter.
 */
const MIN_DIVIDED_STEP = 1e-12;

/**
 * A step toward a breakpoint stops short of it by at most this part of the way, and at
 * least half a crossing step, so the next step crosses it. The prediction it lands by is
 * a straight line, and a step longer than a crossing step that runs past a breakpoint
 * fails.
 */
const LANDING_DIVISIONS = 16;

/**
 * Within that, a step toward a breakpoint stops short of it by this many times how far
 * the prediction moved since the step before: a straight approach, as an op-amp slewing
 * to its limit, lands a crossing step away in one.
 */
const LANDING_DRIFTS = 2;

/**
 * How many times a landing step may fail at the same length from the same time before
 * the landings from that time are shortened like any other failed step. A landing's
 * length comes from the prediction alone, so without this one that keeps failing is
 * retried forever.
 */
const MAX_LANDING_RETRIES = 8;

/** How close two step lengths must be, relative to them, to count as the same. */
const LENGTH_TOLERANCE = 1e-9;

/** Newton iterations allowed for one DC solve at a given source level. */
const MAX_DC_ITERATIONS = 200;

const SINGULAR_MESSAGE =
  "The circuit has no unique solution. Look for a voltage source shorted by a wire, or a loop of voltage sources, wires and inductors.";

const CONVERGENCE_MESSAGE =
  "The simulation did not converge. Check for unrealistic component values.";

/** True when `element` does something in `hook`; wires and the like keep the empty default. */
function overrides(
  element: CircuitElement,
  hook: "stamp" | "startStep" | "stampStep" | "finishStep" | "timeToBreakpoint",
) {
  return element[hook] !== CircuitElement.prototype[hook];
}

/**
 * The posts of some elements, read once so solves write their voltages directly: post
 * `posts[entry]` of the `volts` at `volts[entry]` takes the voltage of node
 * `nodes[entry]`.
 */
type PostVoltages = {
  volts: number[][];
  posts: Int32Array;
  nodes: Int32Array;
};

/** Returns the posts of `elements`, one entry per post. */
function postVoltagesOf(elements: readonly CircuitElement[]): PostVoltages {
  const volts: number[][] = [];
  const posts: number[] = [];
  const nodes: number[] = [];

  for (const element of elements) {
    element.nodes.forEach((node, post) => {
      volts.push(element.volts);
      posts.push(post);
      nodes.push(node);
    });
  }

  return {
    volts,
    posts: Int32Array.from(posts),
    nodes: Int32Array.from(nodes),
  };
}

/** One voltage source of an element and the unknown that holds its current. */
type Branch = {
  element: CircuitElement;
  /** Counts from the element's first branch. */
  index: number;
  unknown: number;
};

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

/**
 * One wire network's spanning tree: its points from `first` up to `end` in the flat
 * lists of `ConductorCurrents`, and the ground at its root if there is one.
 */
type Tree = {
  first: number;
  end: number;
  ground: CircuitElement | null;
};

/**
 * Wires and closed switches merge nodes, so the solve never sees their current. This
 * finds it from the currents of the other elements at each point, along a spanning tree
 * of each wire network; wires that close a loop carry none. The trees depend only on the
 * netlist, so they are built once, into flat lists, and each update only sums currents.
 */
class ConductorCurrents {
  private readonly trees: Tree[] = [];
  /**
   * Conductors and grounds, the elements whose current only this class finds, that no
   * tree gives a current: wires that close a loop, and grounds a wire joins to another.
   */
  private readonly unused: CircuitElement[];
  /**
   * Every tree's points, tree by tree: the posts at point `p` are entries
   * `postStart[p]` to `postStart[p + 1]` of `postElements` and `postIndices`.
   */
  private readonly postStart: Int32Array;
  private readonly postElements: CircuitElement[] = [];
  private readonly postIndices: Int32Array;
  /** Each point's parent in the flat lists, and the conductor that joins them. */
  private readonly parents: Int32Array;
  private readonly edges: (CircuitElement | null)[] = [];
  /** 1 where the conductor's start is at the parent. */
  private readonly startsAtParent: Uint8Array;
  /** Current entering each point's subtree, reused by every update. */
  private readonly totals: Float64Array;

  constructor(elements: readonly CircuitElement[]) {
    const edges = new Map<string, ConductorEdge[]>();
    const posts = new Map<string, PostRef[]>();
    const grounds = new Map<string, CircuitElement>();
    const labelPoints: string[] = [];
    const owned: CircuitElement[] = [];

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

        owned.push(element);

        if (start && end && start !== end) {
          listAt(edges, start).push({ element, other: end, isStart: true });
          listAt(edges, end).push({ element, other: start, isStart: false });
        }

        continue;
      }

      if (element.isGround() && keys[0]) {
        owned.push(element);
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
    const allPoints: TreePoint[] = [];

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

      const first = allPoints.length;
      const ground = grounds.get(root) ?? null;

      for (const point of points) {
        const isRoot = point.parent < 0;

        allPoints.push({
          // Only a ground reads what enters the root, so without one it is not summed.
          posts: isRoot && !ground ? [] : point.posts,
          parent: isRoot ? -1 : first + point.parent,
          edge: point.edge,
          isStartAtParent: point.isStartAtParent,
        });
      }

      this.trees.push({ first, end: allPoints.length, ground });
    }

    const postIndices: number[] = [];

    this.postStart = new Int32Array(allPoints.length + 1);
    this.parents = new Int32Array(allPoints.length);
    this.startsAtParent = new Uint8Array(allPoints.length);
    allPoints.forEach((point, index) => {
      this.postStart[index] = postIndices.length;
      this.parents[index] = point.parent;
      this.edges.push(point.edge);
      this.startsAtParent[index] = point.isStartAtParent ? 1 : 0;

      for (const { element, post } of point.posts) {
        this.postElements.push(element);
        postIndices.push(post);
      }
    });
    this.postStart[allPoints.length] = postIndices.length;
    this.postIndices = Int32Array.from(postIndices);
    this.totals = new Float64Array(allPoints.length);

    const used = new Set<CircuitElement | null>([
      ...this.edges,
      ...this.trees.map(({ ground }) => ground),
    ]);

    this.unused = owned.filter((element) => !used.has(element));
  }

  /** Sets the current of every conductor and ground from the other elements' currents. */
  update() {
    const { totals, postStart, postElements, postIndices } = this;
    const { parents, edges, startsAtParent, unused, trees } = this;

    for (let index = 0; index < unused.length; index += 1) {
      const element = unused[index];

      if (element !== undefined) {
        element.current = 0;
      }
    }

    // Sum the current that the other elements push into each point.
    for (let point = 0; point < totals.length; point += 1) {
      const postEnd = postStart[point + 1] ?? 0;
      let total = 0;

      for (let entry = postStart[point] ?? 0; entry < postEnd; entry += 1) {
        total -=
          postElements[entry]?.currentIntoPost(postIndices[entry] ?? 0) ?? 0;
      }

      totals[point] = total;
    }

    for (let index = 0; index < trees.length; index += 1) {
      const tree = trees[index];

      if (tree === undefined) {
        continue;
      }

      const { first, end, ground } = tree;

      // Walk leaves first: each subtree's net current flows through its edge to the parent.
      for (let point = end - 1; point > first; point -= 1) {
        const edge = edges[point];
        const total = totals[point] ?? 0;
        const parent = parents[point] ?? first;

        if (edge) {
          edge.current = startsAtParent[point] ? -total : total;
          totals[parent] = (totals[parent] ?? 0) + total;
        }
      }

      if (ground) {
        ground.current = totals[first] ?? 0;
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
   * When false, steps leave idle elements for `updateIdleElements`: the voltages of the
   * ones no step hook visits (wires, grounds, net labels), the readings of the ones that
   * only read their voltages (resistors), and the currents through wires. The interactive
   * run calls it once a frame and the transient analysis once per recorded step.
   */
  updatesIdleElements = true;
  private readonly conductorCurrents: ConductorCurrents;
  /** The solution before the step being solved, to go back to when it fails. */
  private readonly previousSolution: Float64Array;
  /** The solutions of the last three Newton iterations, to tell when they go in a circle. */
  private lastIterate: Float64Array;
  private earlierIterate: Float64Array;
  private earliestIterate: Float64Array;
  /**
   * The simulations that take the shorter steps a divided step is made of: the one at
   * index k steps 1 / 2^k as long as this one. Each is built when first needed.
   */
  private readonly shorter: (Simulation | undefined)[] = [];
  /**
   * Takes the steps of any other length, which end on a breakpoint or at the end of a
   * divided step. It is stamped again for each new length.
   */
  private anyLength: Simulation | null = null;
  /**
   * When the soonest breakpoint was last predicted to come, the time that prediction
   * was made at, and how far it moved from the one before; Infinity until it is known.
   */
  private breakpointAt = Number.POSITIVE_INFINITY;
  private predictedAt = Number.NaN;
  private predictionDrift = Number.POSITIVE_INFINITY;
  /** True for a simulation that takes another's shorter steps: it only tries each one. */
  private isInner = false;
  /** Newton iterations a step may take before it counts as failed. */
  private maxStepIterations = MAX_STEP_ITERATIONS;
  /** True when a step that fails may be retried in shorter ones. */
  private isDivisible: boolean;
  /** The elements that tell their breakpoints. */
  private readonly breaking: readonly CircuitElement[];
  /**
   * The elements that do something in each hook. Steps visit only these, so the wires
   * that make up most of a schematic cost nothing per step. Linear elements stamp a step
   * once; nonlinear ones stamp every Newton iteration.
   */
  private readonly stamped: readonly CircuitElement[];
  private readonly starting: readonly CircuitElement[];
  private readonly linear: readonly CircuitElement[];
  private readonly nonlinear: readonly CircuitElement[];
  private readonly finishing: readonly CircuitElement[];
  /** The idle elements that finish a step from their voltages, whenever those are given. */
  private readonly idleFinishing: readonly CircuitElement[];
  private readonly branches: readonly Branch[];
  /** The nonlinear elements whose linearization point moved in the latest iteration. */
  private readonly unsettled: CircuitElement[] = [];
  private unsettledCount = 0;
  /**
   * Voltages solves write: every iteration for nonlinear elements, after each step for
   * the others that take part in it, and on request for idle ones.
   */
  private readonly iteratedVoltages: PostVoltages;
  private readonly steppedVoltages: PostVoltages;
  private readonly idleVoltages: PostVoltages;
  private readonly idleElements: ReadonlySet<CircuitElement>;
  /**
   * The list `updateIdleElementsAmong` was last given, whether it needs every wire
   * current, and which of it is idle.
   */
  private among: readonly CircuitElement[] | null = null;
  private amongNeedsAll = false;
  private amongIdle: CircuitElement[] = [];

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
    this.isDivisible = timeStep / STEP_DIVISIONS >= MIN_DIVIDED_STEP;
    this.conductorCurrents = new ConductorCurrents(elements);
    this.previousSolution = new Float64Array(this.system.solution.length);
    this.lastIterate = new Float64Array(this.system.solution.length);
    this.earlierIterate = new Float64Array(this.system.solution.length);
    this.earliestIterate = new Float64Array(this.system.solution.length);
    this.stamped = elements.filter((element) => overrides(element, "stamp"));
    this.breaking =
      mode === "transient"
        ? elements.filter((element) => overrides(element, "timeToBreakpoint"))
        : [];
    this.starting = elements.filter((element) =>
      overrides(element, "startStep"),
    );

    const stamping = elements.filter((element) =>
      overrides(element, "stampStep"),
    );

    this.linear = stamping.filter((element) => !element.isNonlinear());
    this.nonlinear = stamping.filter((element) => element.isNonlinear());

    const branched = elements.filter(
      (element) => element.branchCount(mode) > 0,
    );

    // An element that only reads its voltages afterwards takes part in no step.
    const stepping = new Set([...this.starting, ...stamping, ...branched]);

    const finishing = elements.filter((element) =>
      overrides(element, "finishStep"),
    );

    this.finishing = finishing.filter(
      (element) => stepping.has(element) || !element.finishesFromVoltages(),
    );
    this.idleFinishing = finishing.filter(
      (element) => !this.finishing.includes(element),
    );

    this.branches = branched.flatMap((element) =>
      Array.from({ length: element.branchCount(mode) }, (_, index) => ({
        element,
        index,
        unknown: this.system.branchUnknown(element.firstBranch + index),
      })),
    );

    const iterated = new Set(this.nonlinear);

    const stepped = new Set(
      [...stepping, ...this.finishing].filter(
        (element) => !iterated.has(element),
      ),
    );

    this.idleElements = new Set(
      elements.filter(
        (element) => !iterated.has(element) && !stepped.has(element),
      ),
    );
    this.iteratedVoltages = postVoltagesOf(this.nonlinear);
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

    for (const element of this.stamped) {
      element.stamp(this.system);
    }

    for (let node = 1; node < this.netlist.nodeCount; node += 1) {
      this.system.stampConductance(node, 0, NODE_GMIN);
    }

    this.system.finishBase();
  }

  /** Copies node voltages from the solution onto the posts of `elements`. */
  private applySolution({ volts, posts, nodes }: PostVoltages) {
    const { solution } = this.system;

    for (let entry = 0; entry < nodes.length; entry += 1) {
      const target = volts[entry];
      const node = nodes[entry] ?? 0;

      if (target !== undefined) {
        target[posts[entry] ?? 0] = node > 0 ? (solution[node] ?? 0) : 0;
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

  /**
   * Runs Newton iterations at the current time and source level; false when they fail.
   * With `givesUpOnCycles` they also fail as soon as they go around in a circle, for
   * steps that are then retried in smaller ones.
   */
  private iterate(maxIterations: number, givesUpOnCycles: boolean) {
    const { system, linear, nonlinear, unsettled } = this;

    system.beginStep();

    for (let index = 0; index < linear.length; index += 1) {
      linear[index]?.stampStep(system);
    }

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let unsettledCount = 0;

      system.iteration = iteration;
      system.beginIteration();

      // Stamp each element and note the ones whose linearization point still moves.
      for (let index = 0; index < nonlinear.length; index += 1) {
        const element = nonlinear[index];

        if (element === undefined) {
          continue;
        }

        system.converged = true;
        element.stampStep(system);

        if (!system.converged) {
          unsettled[unsettledCount] = element;
          unsettledCount += 1;
        }
      }

      this.unsettledCount = unsettledCount;

      // The last solution already solves every element's equations.
      if (
        this.hasExactConvergenceTests &&
        unsettledCount === 0 &&
        iteration > 0
      ) {
        return true;
      }

      if (!system.solve()) {
        this.error = SINGULAR_MESSAGE;
        this.faults =
          system.lu.singularColumn < 0
            ? []
            : this.elementsAt(system.lu.singularColumn + 1);

        return false;
      }

      this.applySolution(this.iteratedVoltages);

      if (!this.hasNonlinear || (unsettledCount === 0 && iteration > 0)) {
        return true;
      }

      if (givesUpOnCycles && iteration > 0 && this.isCycling(iteration)) {
        break;
      }
    }

    this.error = CONVERGENCE_MESSAGE;
    this.faults = unsettled.slice(0, this.unsettledCount);

    return false;
  }

  /**
   * Keeps the solution of Newton iteration `iteration`, and returns true when it is back
   * where the one two or three iterations before was while the last one is elsewhere.
   */
  private isCycling(iteration: number) {
    const { solution } = this.system;
    const { lastIterate, earlierIterate, earliestIterate } = this;
    let lastDistance = 0;
    let earlierDistance = 0;
    let earliestDistance = 0;

    this.lastIterate = earliestIterate;
    this.earlierIterate = lastIterate;
    this.earliestIterate = earlierIterate;

    // A step's first solutions have nothing from the same step to be compared with yet.
    if (iteration < 3) {
      for (let index = 1; index < solution.length; index += 1) {
        earliestIterate[index] = solution[index] ?? 0;
      }

      return false;
    }

    for (let index = 1; index < solution.length; index += 1) {
      const value = solution[index] ?? 0;

      lastDistance = Math.max(
        lastDistance,
        Math.abs(value - (lastIterate[index] ?? 0)),
      );
      earlierDistance = Math.max(
        earlierDistance,
        Math.abs(value - (earlierIterate[index] ?? 0)),
      );
      earliestDistance = Math.max(
        earliestDistance,
        Math.abs(value - (earliestIterate[index] ?? 0)),
      );
      // The oldest solution makes room for this one.
      earliestIterate[index] = value;
    }

    const reach = CYCLE_RATIO * lastDistance;

    return (
      earlierDistance <= reach || (iteration >= 4 && earliestDistance <= reach)
    );
  }

  /**
   * Gives elements their voltages and branch currents and finishes their step, then
   * brings the idle elements up to date unless they wait for `updateIdleElements`.
   */
  private finish() {
    const { system, branches, finishing } = this;
    const { solution } = system;

    this.applySolution(this.steppedVoltages);

    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];

      if (branch === undefined) {
        continue;
      }

      branch.element.setBranchCurrent(
        branch.index,
        solution[branch.unknown] ?? 0,
      );
    }

    for (let index = 0; index < finishing.length; index += 1) {
      finishing[index]?.finishStep(system);
    }

    if (this.updatesIdleElements) {
      this.updateIdleElements();
    }
  }

  /**
   * Gives the idle elements their voltages from the latest step, finishes the ones that
   * read theirs, and finds wire currents.
   */
  updateIdleElements() {
    this.applySolution(this.idleVoltages);

    for (const element of this.idleFinishing) {
      element.finishStep(this.system);
    }

    this.conductorCurrents.update();
  }

  /**
   * Brings just `elements` up to date after a step that left idle elements waiting. A
   * wire, switch or ground needs every wire current, so that updates them all; other idle
   * elements only need their own voltages.
   */
  updateIdleElementsAmong(elements: readonly CircuitElement[]) {
    // Callers pass the same list every step, so what it needs is worked out once.
    if (elements !== this.among) {
      this.among = elements;
      this.amongNeedsAll = elements.some(
        (element) => element.isConductor() || element.isGround(),
      );
      this.amongIdle = elements.filter((element) =>
        this.idleElements.has(element),
      );
    }

    if (this.amongNeedsAll) {
      this.updateIdleElements();

      return;
    }

    const { system, amongIdle } = this;
    const { solution } = system;

    for (let index = 0; index < amongIdle.length; index += 1) {
      const element = amongIdle[index];

      if (element === undefined) {
        continue;
      }

      const { nodes, volts } = element;

      for (let post = 0; post < nodes.length; post += 1) {
        const node = nodes[post] ?? 0;

        volts[post] = node > 0 ? (solution[node] ?? 0) : 0;
      }

      element.finishStep(system);
    }
  }

  /**
   * Advances one time step; false once the circuit cannot be solved. A step with a
   * breakpoint inside, or one Newton cannot solve, as when a comparator snaps over, is
   * made of shorter steps instead.
   */
  step() {
    if (this.error) {
      return false;
    }

    const { system } = this;

    if (!this.isInner && this.isDivisible && this.breaking.length > 0) {
      const untilBreakpoint = this.timeToBreakpoint();

      this.notePrediction(this.time, untilBreakpoint);

      if (untilBreakpoint < system.timeStep) {
        return this.stepThrough(system.timeStep);
      }
    }

    if (this.tryStep()) {
      this.time = system.time;

      return true;
    }

    if (
      this.isInner ||
      !this.isDivisible ||
      this.error !== CONVERGENCE_MESSAGE
    ) {
      return false;
    }

    // A failed step changes no stored state, so the shorter ones start from before it.
    // Only the elements that stamp had voltages from its iterations.
    system.solution.set(this.previousSolution);
    this.applySolution(this.iteratedVoltages);

    return this.stepThrough(system.timeStep / STEP_DIVISIONS);
  }

  /** Solves one step of this simulation's length and finishes it; false when it fails. */
  private tryStep() {
    const { system, starting, previousSolution } = this;
    const { solution } = system;

    system.time = this.time + system.timeStep;

    for (let index = 1; index < solution.length; index += 1) {
      previousSolution[index] = solution[index] ?? 0;
    }

    for (let index = 0; index < starting.length; index += 1) {
      starting[index]?.startStep(system);
    }

    if (!this.iterate(this.maxStepIterations, this.isDivisible)) {
      return false;
    }

    this.finish();

    return true;
  }

  /** Returns the seconds to the soonest breakpoint any element sees ahead. */
  private timeToBreakpoint() {
    const { breaking } = this;
    let soonest = Number.POSITIVE_INFINITY;

    for (let index = 0; index < breaking.length; index += 1) {
      const element = breaking[index];
      const until = element?.timeToBreakpoint() ?? Number.POSITIVE_INFINITY;

      if (until < soonest) {
        soonest = until;
      }
    }

    return soonest;
  }

  /**
   * Notes the soonest breakpoint as predicted at `time`, `untilBreakpoint` away, and how
   * far it moved from the prediction made at an earlier time.
   */
  private notePrediction(time: number, untilBreakpoint: number) {
    if (time === this.predictedAt) {
      return;
    }

    const at = time + untilBreakpoint;

    this.predictionDrift = Math.abs(at - this.breakpointAt);
    this.breakpointAt = at;
    this.predictedAt = time;
  }

  /**
   * Returns the step that crosses a breakpoint: the longest of this one's shorter steps
   * that every element with a breakpoint inside this step allows. The others have nothing
   * to cross yet.
   */
  private breakpointStep() {
    const { timeStep } = this.system;
    let longest = timeStep / STEP_DIVISIONS;

    for (const element of this.breaking) {
      if (element.timeToBreakpoint() < timeStep) {
        longest = Math.min(longest, element.breakpointStep());
      }
    }

    return this.shorterWithin(longest);
  }

  /** Returns the longest of this one's shorter steps that is no longer than `length`. */
  private shorterWithin(length: number) {
    let shorter = this.system.timeStep / CHAIN_DIVISIONS;

    while (shorter > length && shorter / CHAIN_DIVISIONS >= MIN_DIVIDED_STEP) {
      shorter /= CHAIN_DIVISIONS;
    }

    return shorter;
  }

  /**
   * Solves this step as shorter ones, the first at most `first` long. A step that fails
   * is retried 4 times shorter, and each that succeeds lets the next be 4 times longer.
   * Steps land within a crossing step of the next breakpoint, cross it in one, and stay
   * that short while an element snaps over. Those short steps say nothing about the
   * circuit between breakpoints, so they leave the longest step allowed as it was: once
   * the element settles, steps go straight back to it. False when the shortest steps
   * fail too.
   */
  private stepThrough(first: number) {
    const { system } = this;
    const end = this.time + system.timeStep;
    let time = this.time;
    let next = first;
    /**
     * The step that failed last, and how many times in a row it has; true once landings
     * from that time have failed too often and are shortened.
     */
    let failedAt = Number.NaN;
    let failedLength = Number.NaN;
    let retries = 0;
    let shortensLandings = false;

    this.error = null;
    this.faults = [];

    while (time < end) {
      const remaining = end - time;
      const untilBreakpoint = this.timeToBreakpoint();
      // An element may allow longer crossing steps as it snaps over.
      const crossing = this.breakpointStep();
      let length = Math.min(next, remaining);

      this.notePrediction(time, untilBreakpoint);

      if (untilBreakpoint <= crossing) {
        length = Math.min(crossing, next, remaining);
      } else if (untilBreakpoint < length + crossing) {
        const most = untilBreakpoint / LANDING_DIVISIONS;

        // A drift of NaN, from no breakpoint before, fails the test.
        const margin =
          this.predictionDrift < most
            ? Math.min(most, LANDING_DRIFTS * this.predictionDrift)
            : most;

        length = untilBreakpoint - Math.max(crossing / 2, margin);

        if (time === failedAt && shortensLandings) {
          length = Math.min(length, next);
        }
      } else {
        length = this.alignedLength(length, remaining);
      }

      const inner = this.simulationFor(length);

      inner.system.solution.set(system.solution);
      inner.time = time;
      // Idle elements read only the voltages, so the end of the whole step updates them.
      inner.updatesIdleElements = false;

      if (inner.step()) {
        system.solution.set(inner.system.solution);
        // What rounding leaves of the step is no step at all: one that short would
        // stamp companion conductances too large to solve.
        time = remaining - length < MIN_DIVIDED_STEP ? end : time + length;
        next = Math.max(next, length * STEP_DIVISIONS);
        continue;
      }

      const { error, faults } = inner;

      inner.error = null;
      inner.faults = [];

      if (
        error !== CONVERGENCE_MESSAGE ||
        length / STEP_DIVISIONS < MIN_DIVIDED_STEP
      ) {
        this.error = error;
        this.faults = faults;

        return false;
      }

      // Back to where the failed step started, as above. The prediction it went by was
      // off, so the next landing keeps the widest margin.
      this.applySolution(this.iteratedVoltages);
      this.predictionDrift = Number.POSITIVE_INFINITY;
      next = length / STEP_DIVISIONS;
      retries = time === failedAt && length === failedLength ? retries + 1 : 1;
      shortensLandings =
        (time === failedAt && shortensLandings) ||
        retries >= MAX_LANDING_RETRIES;
      failedAt = time;
      failedLength = length;
    }

    system.time = end;
    this.time = end;

    if (this.updatesIdleElements) {
      this.updateIdleElements();
    }

    return true;
  }

  /**
   * Returns `length`, or a shorter step that fits a whole number of times into what is
   * left: steps of the lengths this one divides into need no new stamp.
   */
  private alignedLength(length: number, remaining: number) {
    const shorter = this.shorterWithin(length);
    const count = remaining / shorter;

    return Math.abs(count - Math.round(count)) <= LENGTH_TOLERANCE * count
      ? shorter
      : length;
  }

  /** Returns the inner simulation that takes steps `length` long. */
  private simulationFor(length: number) {
    const { timeStep } = this.system;

    const divisions = Math.round(
      Math.log(timeStep / length) / Math.log(CHAIN_DIVISIONS),
    );

    const shorter = timeStep / CHAIN_DIVISIONS ** divisions;

    if (
      divisions >= 1 &&
      Math.abs(shorter - length) <= LENGTH_TOLERANCE * length
    ) {
      return (this.shorter[divisions] ??= this.innerSimulation(shorter));
    }

    if (this.anyLength === null) {
      this.anyLength = this.innerSimulation(length);
    } else if (this.anyLength.system.timeStep !== length) {
      this.anyLength.restamp(length);
    }

    return this.anyLength;
  }

  /** Builds a simulation that takes this one's shorter steps of `length`. */
  private innerSimulation(length: number) {
    const inner = new Simulation(this.elements, this.mode, length);

    inner.isInner = true;
    inner.maxStepIterations = MAX_DIVIDED_STEP_ITERATIONS;
    inner.system.outerTimeStep = this.system.timeStep;

    return inner;
  }

  /** Takes steps of `timeStep` from now on: the base holds companion models stamped for it. */
  private restamp(timeStep: number) {
    this.system.retime(timeStep);
    this.isDivisible = timeStep / STEP_DIVISIONS >= MIN_DIVIDED_STEP;
  }

  /**
   * Solves the DC operating point. When Newton's method fails from a cold start, the
   * sources ramp up from zero in steps so each solve starts near the next.
   */
  solveOperatingPoint() {
    this.system.time = 0;
    this.system.sourceScale = 1;

    if (this.iterate(MAX_DC_ITERATIONS, false)) {
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

      if (!this.iterate(MAX_DC_ITERATIONS, false)) {
        return false;
      }
    }

    this.finish();

    return true;
  }
}
