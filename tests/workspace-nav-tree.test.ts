import { expect, test } from 'vitest';
import { ancestorIds, completeOrder, isDescendant, isDropSibling, isPathAncestor, movedOrder, navTree, orderedWorkspaces, owningParent, siblingAfter } from '../plugins/workspace/src/workspace-nav.ts';
import type { NavWorkspace } from '../plugins/workspace/src/workspace-nav.ts';

const ws = (id: string, directory: string, order?: number): NavWorkspace => ({ id, name: id, directory, ...(order === undefined ? {} : { order }) });

test('an ancestor must be a segment-boundary prefix and never the path itself', () => {
  expect(isPathAncestor('/home/me', '/home/me/work')).toBe(true);
  expect(isPathAncestor('/home/me', '/home/me')).toBe(false);
  expect(isPathAncestor('/home/me/work', '/home/me/workplace')).toBe(false);
  expect(isPathAncestor('/', '/x')).toBe(true);
  expect(isPathAncestor('/a/b', '/a/b/c/d')).toBe(true);
});

test('the owning parent is the nearest registered ancestor, by longest prefix', () => {
  const root = ws('root', '/home/me');
  const inner = ws('inner', '/home/me/work');
  const deep = ws('deep', '/home/me/work/apps/web');
  const cousin = ws('cousin', '/home/other');
  expect(owningParent(deep, [root, inner, cousin])?.id).toBe('inner');
  expect(owningParent(inner, [root, cousin])?.id).toBe('root');
  expect(owningParent(root, [inner, cousin])).toBeUndefined();
  expect(owningParent(cousin, [root, inner])).toBeUndefined();
  // A workspace is never its own parent.
  expect(owningParent(deep, [deep, root, inner])?.id).toBe('inner');
});

test('display order puts ordered workspaces first, then registration order', () => {
  const a = ws('a', '/a');
  const b = ws('b', '/b', 0);
  const c = ws('c', '/c', 1);
  const d = ws('d', '/d');
  expect(orderedWorkspaces([a, b, c, d]).map(item => item.id)).toEqual(['b', 'c', 'a', 'd']);
  expect(orderedWorkspaces([d, c, b, a]).map(item => item.id)).toEqual(['b', 'c', 'd', 'a']);
  expect(completeOrder([d, c, b, a])).toEqual(['b', 'c', 'd', 'a']);
});

test('list mode is one flat run in display order; a fold applies there too', () => {
  const listed = navTree([ws('child', '/x/child'), ws('parent', '/x')], false, new Set(['parent']));
  expect(listed.map(node => [node.workspace.id, node.children.length, node.expanded])).toEqual([['child', 0, true], ['parent', 0, false]]);
});

test('list mode is one flat run in display order, every group expanded', () => {
  const tree = navTree([ws('child', '/x/child', 1), ws('parent', '/x'), ws('root', '/x/child/deep', 0)], false, new Set());
  expect(tree.map(node => [node.workspace.id, node.children.length, node.expanded])).toEqual([['root', 0, true], ['child', 0, true], ['parent', 0, true]]);
});

test('tree mode nests under the nearest ancestor; the saved fold state is the only truth', () => {
  const root = ws('root', '/home/me');
  const inner = ws('inner', '/home/me/work');
  const deep = ws('deep', '/home/me/work/apps');
  const cousin = ws('cousin', '/home/other');
  const all = [cousin, deep, inner, root];
  // Roots keep display order: cousin, then root with its chain below it.
  expect(navTree(all, true, new Set()).map(node => [node.workspace.id, node.children.map(child => child.workspace.id)])).toEqual([['cousin', []], ['root', ['inner']]]);
  expect(navTree(all, true, new Set())[1]!.children[0]!.children.map(node => node.workspace.id)).toEqual(['deep']);
  // A fold is recorded on the node; the model itself never overrides it, whatever is selected.
  const folded = navTree(all, true, new Set(['inner']));
  expect(folded[1]!.children[0]).toMatchObject({ expanded: false });
  expect(folded[1]!.children[0]!.children).toHaveLength(1);
  expect(ancestorIds(deep, all)).toEqual(['inner', 'root']);
  expect(ancestorIds(cousin, all)).toEqual([]);
  expect(isDescendant('root', 'deep', all)).toBe(true);
  expect(isDescendant('deep', 'root', all)).toBe(false);
  expect(isDescendant('cousin', 'deep', all)).toBe(false);
});

test('a drop lands beside a sibling: anywhere in list mode, same parent in tree mode, never on itself or a descendant', () => {
  const all = [ws('root', '/r'), ws('a', '/r/a'), ws('b', '/r/b'), ws('deep', '/r/a/deep'), ws('other', '/o')];
  for (const other of ['a', 'b', 'deep', 'other']) expect(isDropSibling('root', other, all, false)).toBe(true);
  expect(isDropSibling('root', 'root', all, false)).toBe(false);
  expect(isDropSibling('root', 'a', all, true)).toBe(false);
  expect(isDropSibling('a', 'b', all, true)).toBe(true);
  expect(isDropSibling('a', 'deep', all, true)).toBe(false);
  expect(isDropSibling('a', 'other', all, true)).toBe(false);
  expect(isDropSibling('root', 'other', all, true)).toBe(true);
});

test('moving a Workspace reorders its siblings in place and leaves every other Workspace where it was', () => {
  // Display order: root, a, deep, b, other (tree: root > [a > [deep], b]; other is a second root).
  const all = [ws('root', '/r', 0), ws('a', '/r/a', 1), ws('deep', '/r/a/deep', 2), ws('b', '/r/b', 3), ws('other', '/o', 4)];
  // List mode: anything may move anywhere, including to the end without an anchor.
  expect(movedOrder(all, 'other', 'root', false)).toEqual(['other', 'root', 'a', 'deep', 'b']);
  expect(movedOrder(all, 'root', undefined, false)).toEqual(['a', 'deep', 'b', 'other', 'root']);
  // Tree mode: only the siblings change, inside the slots the sibling set already occupied.
  expect(movedOrder(all, 'b', 'a', true)).toEqual(['root', 'b', 'deep', 'a', 'other']);
  expect(movedOrder(all, 'a', undefined, true)).toEqual(['root', 'b', 'deep', 'a', 'other']);
  // The sibling set of the two roots holds positions 0 and 4: a move that changes nothing is not a move.
  expect(movedOrder(all, 'other', undefined, true)).toBeUndefined();
  expect(movedOrder(all, 'other', 'root', true)).toEqual(['other', 'a', 'deep', 'b', 'root']);
  // An anchor that is not a sibling, the dragged row itself, or an unknown id moves nothing.
  expect(movedOrder(all, 'b', 'deep', true)).toBeUndefined();
  expect(movedOrder(all, 'a', 'a', true)).toBeUndefined();
  expect(movedOrder(all, 'missing', 'a', false)).toBeUndefined();
  expect(movedOrder(all, 'b', 'a', false)).toEqual(['root', 'b', 'a', 'deep', 'other']);
  expect(siblingAfter(all, 'a', true)).toBe('b');
  expect(siblingAfter(all, 'b', true)).toBeUndefined();
  expect(siblingAfter(all, 'b', false)).toBe('other');
});
