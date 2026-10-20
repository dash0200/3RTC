/**
 * Relay tree for local video files, kept by the owner of the file.
 *
 * tree: Map<viewerId, { parent: viewerId | null, canRelay: boolean }>
 *   parent null  = fed by the owner directly
 *   parent id    = fetches blocks from that viewer, which relays them
 *
 * The owner feeds at most RELAY_FANOUT viewers itself; after that each new viewer gets the
 * shallowest viewer that can relay (a computer, not a phone) and has room for another child.
 * When a viewer leaves or stops, its children fall back to the owner on their own; detach()
 * keeps the owner's picture in line with that.
 */

export const RELAY_FANOUT = 2; // viewers fed directly by the owner, or by one relaying viewer

export interface TreeNode {
  parent: string | null;
  canRelay: boolean;
}

export type StreamTree = Map<string, TreeNode>;

const childCount = (tree: StreamTree, id: string | null, except?: string): number => {
  let n = 0;
  for (const [viewerId, node] of tree) {
    if (viewerId !== except && node.parent === id) n++;
  }
  return n;
};

const depthOf = (tree: StreamTree, id: string): number => {
  let depth = 0;
  const seen = new Set<string>();
  for (let cur = tree.get(id)?.parent; cur && !seen.has(cur); cur = tree.get(cur)?.parent) {
    seen.add(cur);
    depth++;
  }
  return depth;
};

const isUnder = (tree: StreamTree, id: string, ancestor: string): boolean => {
  const seen = new Set<string>();
  for (let cur = tree.get(id)?.parent; cur && !seen.has(cur); cur = tree.get(cur)?.parent) {
    if (cur === ancestor) return true;
    seen.add(cur);
  }
  return false;
};

/**
 * Where a viewer asking for the stream should fetch from: a parent viewer id, or null for the
 * owner. `isReachable(id)` says whether that viewer is still connected to us.
 */
export function chooseParent(
  tree: StreamTree,
  viewerId: string,
  isReachable: (id: string) => boolean = () => true
): string | null {
  if (childCount(tree, null, viewerId) < RELAY_FANOUT) return null;
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const [id, node] of tree) {
    if (id === viewerId || !node.canRelay || !isReachable(id)) continue;
    if (isUnder(tree, id, viewerId)) continue; // never under its own child
    if (childCount(tree, id, viewerId) >= RELAY_FANOUT) continue;
    const depth = depthOf(tree, id);
    if (depth < bestDepth) {
      best = id;
      bestDepth = depth;
    }
  }
  return best; // null: nobody can take it, the owner serves it directly
}

/** A viewer joins (or re-joins) the tree. Returns its parent (null = owner). */
export function addViewer(
  tree: StreamTree,
  viewerId: string,
  canRelay: boolean,
  isReachable: (id: string) => boolean = () => true
): string | null {
  detachViewer(tree, viewerId);
  const parent = chooseParent(tree, viewerId, isReachable);
  tree.set(viewerId, { parent, canRelay: Boolean(canRelay) });
  return parent;
}

/** A viewer left or stopped: its children now fetch from the owner. */
export function detachViewer(tree: StreamTree, viewerId: string): void {
  if (!tree.has(viewerId)) return;
  tree.delete(viewerId);
  for (const node of tree.values()) {
    if (node.parent === viewerId) node.parent = null;
  }
}

/** A viewer is asking the owner directly (it fell back from its parent). */
export function markDirect(tree: StreamTree, viewerId: string): void {
  const node = tree.get(viewerId);
  if (node) node.parent = null;
}
