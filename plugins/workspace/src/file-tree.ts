import type { FileEntry } from '@aork/contracts/workspace';

/** Pure logic of the Files view's tree, in the shape of deepseek-harness's file tree
 * (ui-sidebar-files; MIT). Workspace paths are `/`-separated and relative to the root, which is
 * the empty path. Nothing here reads a directory or draws: that is left to the view. */

/** What a tab's file tree holds for one directory: its listing, or the state of reading it. */
export interface Level {
  status: 'loading' | 'ready' | 'failed';
  entries?: FileEntry[] | undefined;
  truncated?: boolean | undefined;
  /** Set while a listing already shown is being read again. */
  refreshing?: boolean | undefined;
  error?: string | undefined;
  /** The read in flight and what it settles the level to; a second reader waits for it rather than asking again. */
  pending?: Promise<Level> | undefined;
}

/** A reader hides dot entries until asked for them. */
export function isHiddenEntry(name: string): boolean { return name.startsWith('.'); }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const directoriesFirst = (entry: FileEntry): number => entry.kind === 'directory' ? 0 : 1;
/** Directories first, then names in natural, case-insensitive order: `a2` before `a10`, `B` beside `b`. */
export function compareEntries(left: FileEntry, right: FileEntry): number {
  return directoriesFirst(left) - directoriesFirst(right) || collator.compare(left.name, right.name);
}

/** The entries a reader sees at a level, in the order they are drawn. */
export function visibleEntries(entries: readonly FileEntry[], showHidden: boolean): FileEntry[] {
  return (showHidden ? [...entries] : entries.filter(entry => !isHiddenEntry(entry.name))).sort(compareEntries);
}

/** The part of a path before its last `/`; the root for a top-level entry. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** The part of a path after its last `/`. */
export function baseName(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }

/** A path's directories from the root down, nearest last; a top-level path has none. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const chain: string[] = [];
  for (let depth = 1; depth < parts.length; depth++) chain.push(parts.slice(0, depth).join('/'));
  return chain;
}

/** Where `query` occurs in `text`, as [start, end) pairs that never overlap. Case-insensitive, and
 * read from the text itself so that a lower-case form of another length cannot move them. */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const needle = query.toLocaleLowerCase();
  if (!needle) return ranges;
  for (let at = 0; at + needle.length <= text.length; at++) {
    if (text.slice(at, at + needle.length).toLocaleLowerCase() === needle) {
      ranges.push([at, at + needle.length]);
      at += needle.length - 1;
    }
  }
  return ranges;
}

/** One drawn line of the tree. Notes and failures belong to the directory drawn above them. */
export type TreeItem =
  | { kind: 'entry'; entry: FileEntry; depth: number; matched: boolean }
  | { kind: 'note'; depth: number; path: string; note: 'loading' | 'empty' | 'hidden' | 'truncated' }
  | { kind: 'failure'; depth: number; path: string; error: string };

/** The visible lines of a lazily listed tree: each expanded level's entries, and what is known
 * about a level that is not simply a list of entries. */
export function treeItems(levels: ReadonlyMap<string, Level>, expanded: ReadonlySet<string>, showHidden: boolean): TreeItem[] {
  const items: TreeItem[] = [];
  const walk = (path: string, depth: number): void => {
    const level = levels.get(path);
    if (!level || (level.status !== 'ready' && level.status !== 'failed')) { items.push({ kind: 'note', depth, path, note: 'loading' }); return; }
    const entries = level.entries;
    if (entries) {
      const visible = visibleEntries(entries, showHidden);
      for (const entry of visible) {
        items.push({ kind: 'entry', entry, depth, matched: false });
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
      if (!visible.length) items.push({ kind: 'note', depth, path, note: entries.length ? 'hidden' : 'empty' });
      else if (level.truncated) items.push({ kind: 'note', depth, path, note: 'truncated' });
    }
    // A listing that was shown and then failed to be read again stays, with the failure under it.
    if (level.status === 'failed') items.push({ kind: 'failure', depth, path, error: level.error ?? '读取失败' });
  };
  walk('', 0);
  return items;
}

interface MatchNode { entry: FileEntry; matched: boolean; children: MatchNode[] }

/** Search matches as a tree pruned to them: every level of each match's path is kept, all are
 * drawn expanded, and a directory is itself a match where the search returned it. */
export function searchItems(matches: readonly FileEntry[], showHidden: boolean): TreeItem[] {
  const nodes = new Map<string, MatchNode>();
  const node = (path: string, kind: FileEntry['kind']): MatchNode => {
    let found = nodes.get(path);
    if (!found) { found = { entry: { path, name: baseName(path), kind, size: 0 }, matched: false, children: [] }; nodes.set(path, found); }
    return found;
  };
  const root = node('', 'directory');
  for (const match of matches) {
    if (!showHidden && match.path.split('/').some(isHiddenEntry)) continue;
    let parent = root;
    for (const directory of ancestorsOf(match.path)) {
      const next = node(directory, 'directory');
      if (!parent.children.includes(next)) parent.children.push(next);
      parent = next;
    }
    const found = node(match.path, match.kind);
    found.entry = match; found.matched = true;
    if (!parent.children.includes(found)) parent.children.push(found);
  }
  const items: TreeItem[] = [];
  const walk = (branch: MatchNode, depth: number): void => {
    for (const child of branch.children.sort((left, right) => compareEntries(left.entry, right.entry))) {
      items.push({ kind: 'entry', entry: child.entry, depth, matched: child.matched });
      if (child.children.length) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return items;
}
