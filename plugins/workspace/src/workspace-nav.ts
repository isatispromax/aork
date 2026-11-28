import type { Workspace } from '@aork/contracts/workspace';

/** Pure logic of the Workspace browser, in the shape of deepseek-harness's ui-workspace
 * (tree.ts / WorkspaceBrowser; MIT). Hierarchies use registered canonical paths only: a parent is
 * the registered Workspace whose directory is the nearest segment-boundary path prefix. Nothing
 * here draws or writes; that is left to the view and the commands. */

export type NavWorkspace = Pick<Workspace, 'id' | 'name' | 'directory'> & { order?: number | undefined };

/** True when `ancestor` is `path` itself prefixed at a segment boundary: `/a/b` is an
 * ancestor of `/a/b/c` but never of `/a/bc`. Paths are `/`-separated canonical directories. */
export function isPathAncestor(ancestor: string, path: string): boolean {
  if (ancestor === '/') return path.length > 1;
  return path.length > ancestor.length && path.startsWith(ancestor) && path[ancestor.length] === '/';
}

/** The registered Workspace whose directory is the nearest ancestor of `workspace`'s own, or
 * undefined at the root. Longest prefix wins; the Workspace is never its own parent. */
export function owningParent(workspace: NavWorkspace, registered: readonly NavWorkspace[]): NavWorkspace | undefined {
  let nearest: NavWorkspace | undefined;
  for (const candidate of registered) {
    if (candidate.id === workspace.id) continue;
    if (!isPathAncestor(candidate.directory, workspace.directory)) continue;
    if (!nearest || candidate.directory.length > nearest.directory.length) nearest = candidate;
  }
  return nearest;
}

/** Workspaces in display order: `order` first (ascending), then registration order — the
 * order of the input. Records the server has not ordered yet stay in their insertion place. */
export function orderedWorkspaces<T extends NavWorkspace>(workspaces: readonly T[]): T[] {
  return workspaces
    .map((workspace, at) => ({ workspace, at }))
    .sort((left, right) => (left.workspace.order ?? Number.MAX_SAFE_INTEGER) - (right.workspace.order ?? Number.MAX_SAFE_INTEGER) || left.at - right.at)
    .map(item => item.workspace);
}

/** Every Workspace id in display order: the complete sequence a reorder write sends. */
export function completeOrder<T extends NavWorkspace>(workspaces: readonly T[]): string[] {
  return orderedWorkspaces(workspaces).map(workspace => workspace.id);
}

/** One Workspace group of the browser: its header row, then its child groups, then its own Session rows. */
export interface NavNode<T extends NavWorkspace = NavWorkspace> {
  workspace: T;
  /** Nested groups in display order; empty outside tree mode. */
  children: NavNode<T>[];
  /** False only where the user folded this Workspace. A fold hides the children and the rows. */
  expanded: boolean;
}

/** The groups to draw, in display order. List mode is one flat run; tree mode nests each Workspace
 * under its nearest registered ancestor, ancestors expanded unless the saved fold says otherwise.
 * The saved fold is the only truth: it hides a selected descendant until the view reveals it. */
export function navTree<T extends NavWorkspace>(workspaces: readonly T[], tree: boolean, collapsed: ReadonlySet<string>): NavNode<T>[] {
  const sorted = orderedWorkspaces(workspaces);
  const node = (workspace: T): NavNode<T> => ({ workspace, children: [], expanded: !collapsed.has(workspace.id) });
  if (!tree) return sorted.map(node);
  const nodes = new Map(sorted.map(workspace => [workspace.id, node(workspace)]));
  const roots: NavNode<T>[] = [];
  for (const workspace of sorted) {
    const parent = owningParent(workspace, sorted);
    if (parent) nodes.get(parent.id)!.children.push(nodes.get(workspace.id)!);
    else roots.push(nodes.get(workspace.id)!);
  }
  return roots;
}

/** The registered ancestors of `workspace`, nearest first (its own id excluded). */
export function ancestorIds(workspace: NavWorkspace, registered: readonly NavWorkspace[]): string[] {
  const chain: string[] = [];
  let at: NavWorkspace | undefined = workspace;
  while (at) {
    const parent = owningParent(at, registered);
    if (!parent) break;
    chain.push(parent.id);
    at = registered.find(item => item.id === parent.id);
  }
  return chain;
}

/** True when `ancestorId`'s registered directory contains `id`'s: `id` nests below it in tree mode. */
export function isDescendant(ancestorId: string, id: string, registered: readonly NavWorkspace[]): boolean {
  return ancestorIds(find(registered, id), registered).includes(ancestorId);
}

function find(registered: readonly NavWorkspace[], id: string): NavWorkspace {
  return registered.find(item => item.id === id) ?? { id, name: id, directory: '' };
}

const parentOf = (id: string, registered: readonly NavWorkspace[]) => owningParent(find(registered, id), registered)?.id;

/** Whether a dragged Workspace may land next to `id`: anywhere in list mode, beside a sibling in
 * tree mode. That is dsh's rule — dragging reorders siblings, and a drop over a descendant's rows
 * is resolved by walking up to the first sibling. */
export function isDropSibling(draggedId: string, id: string, registered: readonly NavWorkspace[], tree: boolean): boolean {
  return draggedId !== id && (!tree || parentOf(draggedId, registered) === parentOf(id, registered));
}

/** The complete sequence after moving `draggedId` in front of `anchorId` — or to the end of its
 * siblings when there is no anchor. Siblings reorder among the positions they already held, so
 * Workspaces outside the sibling set never move. An unchanged sequence comes back undefined. */
export function movedOrder(workspaces: readonly NavWorkspace[], draggedId: string, anchorId: string | undefined, tree: boolean): string[] | undefined {
  const complete = completeOrder(workspaces);
  if (!complete.includes(draggedId)) return undefined;
  const parent = tree ? parentOf(draggedId, workspaces) : undefined;
  const siblings = tree ? complete.filter(id => parentOf(id, workspaces) === parent) : complete;
  const moved = siblings.filter(id => id !== draggedId);
  const at = anchorId === undefined ? -1 : moved.indexOf(anchorId);
  if (anchorId !== undefined && at === -1) return undefined;
  if (at === -1) moved.push(draggedId); else moved.splice(at, 0, draggedId);
  if (moved.every((id, index) => id === siblings[index])) return undefined;
  let next = 0;
  return complete.map(id => siblings.includes(id) ? moved[next++]! : id);
}

/** The Workspace that follows `id` among its siblings in display order, or undefined at the end. */
export function siblingAfter(workspaces: readonly NavWorkspace[], id: string, tree: boolean): string | undefined {
  const parent = tree ? parentOf(id, workspaces) : undefined;
  const siblings = completeOrder(workspaces).filter(candidate => !tree || parentOf(candidate, workspaces) === parent);
  return siblings[siblings.indexOf(id) + 1];
}
