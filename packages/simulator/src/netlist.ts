import type { CircuitElement } from "./element";
import { pointKey } from "./geometry";
import type { AnalysisMode } from "./mna-system";
import { wireThrough } from "./wiring";

/** Stands for the ground node in the union-find before nodes are numbered. */
const GROUND_KEY = "ground";

/** Union-find over point keys, joining posts that share a node. */
class PointSets {
  private readonly parents = new Map<string, string>();

  add(key: string) {
    if (!this.parents.has(key)) {
      this.parents.set(key, key);
    }
  }

  /** Returns the root of `key`'s set and points `key` straight at it. */
  find(key: string): string {
    const parent = this.parents.get(key) ?? key;

    if (parent === key) {
      return key;
    }

    const root = this.find(parent);

    this.parents.set(key, root);

    return root;
  }

  union(a: string, b: string) {
    this.add(a);
    this.add(b);

    const rootA = this.find(a);
    const rootB = this.find(b);

    if (rootA === rootB) {
      return;
    }

    // Ground stays the root of its set, so finding it is cheap.
    if (rootB === GROUND_KEY) {
      this.parents.set(rootA, rootB);
    } else {
      this.parents.set(rootB, rootA);
    }
  }
}

/** What results call a node and whether they list it. */
export type NodeInfo = {
  /** `0` for ground, a net label's text, or `n` and its number. */
  name: string;
  /** True when a net label names it, so results show it first. */
  isLabeled: boolean;
  /** True for nodes inside an element, which results leave out. */
  isInternal: boolean;
};

/**
 * The nodes of a circuit: which node every post belongs to and what each node is called.
 * Node 0 is ground. Building it assigns `nodes` and `firstBranch` on every element.
 */
export type Netlist = {
  nodeCount: number;
  branchCount: number;
  /** Node of each post, by point key. */
  nodeOfPoint: Map<string, number>;
  nodes: NodeInfo[];
};

/**
 * Returns the post that becomes ground when no element references ground: the first
 * source's first post, else the first part's.
 */
function fallbackReference(elements: readonly CircuitElement[]) {
  const source = elements.find((element) => element.isSource());

  const reference =
    source ??
    elements.find(
      (element) => !element.isConductor() && element.posts().length > 0,
    );

  return reference?.posts()[0];
}

/**
 * Builds the netlist for `mode`. Posts join when they share a point, a conductor, a
 * ground symbol or a net label name; probes read the net beneath them. It assigns
 * `nodes`, `volts` and `firstBranch` on every element.
 */
export function buildNetlist(
  elements: readonly CircuitElement[],
  mode: AnalysisMode,
): Netlist {
  const sets = new PointSets();
  const labels = new Map<string, string>();

  sets.add(GROUND_KEY);

  // Join posts through conductors, ground symbols and net labels with the same name.
  for (const element of elements) {
    const keys = element.posts().map(pointKey);

    for (const key of keys) {
      sets.add(key);
    }

    if (element.isConductor()) {
      const [first, second] = element.conductorPosts();
      const a = keys[first];
      const b = keys[second];

      if (a && b) {
        sets.union(a, b);
      }
    }

    if (element.isGround() && keys[0]) {
      sets.union(GROUND_KEY, keys[0]);
    }

    const name = element.netName();

    if (name !== null && keys[0]) {
      const first = labels.get(name);

      if (first) {
        sets.union(first, keys[0]);
      } else {
        labels.set(name, keys[0]);
      }
    }
  }

  // Ground one post when nothing else sets the 0 V reference.
  if (!elements.some((element) => element.referencesGround())) {
    const reference = fallbackReference(elements);

    if (reference) {
      sets.union(GROUND_KEY, pointKey(reference));
    }
  }

  // Number each set in the order its posts appear; ground is node 0.
  const nodeOfRoot = new Map<string, number>([[GROUND_KEY, 0]]);
  const nodeOfPoint = new Map<string, number>();

  for (const element of elements) {
    element.nodes = element.posts().map((post) => {
      const key = pointKey(post);
      const root = sets.find(key);
      let node = nodeOfRoot.get(root);

      if (node === undefined) {
        node = nodeOfRoot.size;
        nodeOfRoot.set(root, node);
      }

      nodeOfPoint.set(key, node);

      return node;
    });
  }

  // A probe takes the node beneath its point: a post's there, else a wire's through it.
  // Over nothing, it has no node.
  for (const element of elements) {
    const point = element.probePoint();

    if (!point) {
      continue;
    }

    const atPost = nodeOfPoint.get(pointKey(point));

    const wire =
      atPost === undefined ? wireThrough(elements, point) : undefined;

    const node = atPost ?? (wire && nodeOfPoint.get(pointKey(wire.start)));

    element.nodes = node === undefined ? [] : [node];
  }

  // Name each node; a net label renames its node unless the node is ground.
  const nodes: NodeInfo[] = Array.from(
    { length: nodeOfRoot.size },
    (_, node) => ({
      name: node === 0 ? "0" : `n${node}`,
      isLabeled: false,
      isInternal: false,
    }),
  );

  for (const [text, key] of labels) {
    const node = nodes[nodeOfPoint.get(key) ?? 0];

    if (node && node.name !== "0") {
      node.name = text;
      node.isLabeled = true;
    }
  }

  // Add internal nodes after the post nodes and size each element's `volts` to match.
  for (const element of elements) {
    for (let index = 0; index < element.internalNodeCount(); index += 1) {
      element.nodes.push(nodes.length);
      nodes.push({
        name: `${element.designator}#${index}`,
        isLabeled: false,
        isInternal: true,
      });
    }

    if (element.volts.length !== element.nodes.length) {
      element.volts = element.nodes.map(
        (_, index) => element.volts[index] ?? 0,
      );
    }
  }

  let branchCount = 0;

  for (const element of elements) {
    element.firstBranch = branchCount;
    branchCount += element.branchCount(mode);
  }

  return { nodeCount: nodes.length, branchCount, nodeOfPoint, nodes };
}
