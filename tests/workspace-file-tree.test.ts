import { expect, test } from 'vitest';
import { ancestorsOf, baseName, compareEntries, isHiddenEntry, matchRanges, parentOf, searchItems, treeItems, visibleEntries } from '../plugins/workspace/src/file-tree.ts';
import type { FileEntry } from '@aork/contracts/workspace';
import type { Level, TreeItem } from '../plugins/workspace/src/file-tree.ts';

const file = (path: string): FileEntry => ({ path, name: baseName(path), kind: 'file', size: 0 });
const directory = (path: string): FileEntry => ({ path, name: baseName(path), kind: 'directory', size: 0 });
const ready = (entries: FileEntry[], truncated = false): Level => ({ status: 'ready', entries, truncated });
/** Every drawn line by what it names: an entry's path, or a note or failure. */
const lines = (items: TreeItem[]): string[] => items.map(item => item.kind === 'entry' ? item.entry.path : `${item.kind}:${item.kind === 'note' ? item.note : item.error}`);

test('a level lists directories first, then names in natural, case-insensitive order', () => {
  const entries = [file('b10.txt'), file('B2.txt'), directory('zed'), file('a.md'), directory('alpha'), file('a1.md')];
  const expected = ['alpha', 'zed', 'a.md', 'a1.md', 'B2.txt', 'b10.txt'];
  expect(entries.sort(compareEntries).map(entry => entry.name)).toEqual(expected);
  // The order does not depend on the order the entries arrived in, nor on their case.
  expect([...entries].reverse().sort(compareEntries).map(entry => entry.name)).toEqual(expected);
  expect(compareEntries(file('Alpha'), file('alpha'))).toBe(0);
});

test('dot entries are hidden until asked for, and hiding leaves the caller\'s array alone', () => {
  expect([isHiddenEntry('.git'), isHiddenEntry('notes.md'), isHiddenEntry('.config/x')]).toEqual([true, false, true]);
  const entries = [file('b.txt'), directory('.config'), file('.env'), file('a.txt')];
  expect(visibleEntries(entries, false).map(entry => entry.name)).toEqual(['a.txt', 'b.txt']);
  expect(visibleEntries(entries, true).map(entry => entry.name)).toEqual(['.config', '.env', 'a.txt', 'b.txt']);
  expect(entries.map(entry => entry.name)).toEqual(['b.txt', '.config', '.env', 'a.txt']);
});

test('paths split into parent, base name and the chain of directories above them', () => {
  expect(parentOf('sources/a/notes.md')).toBe('sources/a');
  expect(parentOf('notes.md')).toBe('');
  expect(baseName('sources/a/notes.md')).toBe('notes.md');
  expect(baseName('notes.md')).toBe('notes.md');
  expect(ancestorsOf('sources/a/deep/notes.md')).toEqual(['sources', 'sources/a', 'sources/a/deep']);
  expect(ancestorsOf('notes.md')).toEqual([]);
});

test('match ranges find each occurrence case-insensitively and never overlapping, at the text\'s own positions', () => {
  expect(matchRanges('NOTES-notes.md', 'notes')).toEqual([[0, 5], [6, 11]]);
  expect(matchRanges('aaa', 'aa')).toEqual([[0, 2]]);
  expect(matchRanges('notes.md', '')).toEqual([]);
  expect(matchRanges('notes.md', 'zzz')).toEqual([]);
  // A character whose lower-case form is longer must not shift what follows it.
  const text = 'İx-notes';
  const range = matchRanges(text, 'notes')[0];
  expect(text.slice(range![0], range![1])).toBe('notes');
});

test('the tree draws each expanded level under its directory and says what a level holds', () => {
  const levels = new Map<string, Level>([
    ['', ready([file('README.md'), directory('src'), directory('.hidden')])],
    ['src', ready([directory('src/deep'), file('src/index.ts')])],
    ['src/deep', ready([])],
  ]);
  // A collapsed directory is one line; what it holds is not drawn.
  expect(lines(treeItems(levels, new Set(), false))).toEqual(['src', 'README.md']);
  const items = treeItems(levels, new Set(['src', 'src/deep']), false);
  expect(lines(items)).toEqual(['src', 'src/deep', 'note:empty', 'src/index.ts', 'README.md']);
  expect(items.map(item => item.depth)).toEqual([0, 1, 2, 1, 0]);
  // Hidden entries stay hidden however far the tree is open; asking for them shows them.
  expect(lines(treeItems(levels, new Set(), true))).toEqual(['.hidden', 'src', 'README.md']);
  const opened = treeItems(levels, new Set(['src', '.hidden']), true);
  expect(lines(opened)).toEqual(['.hidden', 'note:loading', 'src', 'src/deep', 'src/index.ts', 'README.md']);
  expect(opened[1]?.depth).toBe(1);
});

test('a level says when it is empty, when only its hidden entries are left out, and when it was cut short', () => {
  expect(lines(treeItems(new Map([['', ready([])]]), new Set(), false))).toEqual(['note:empty']);
  expect(lines(treeItems(new Map([['', ready([file('.env')])]]), new Set(), false))).toEqual(['note:hidden']);
  // The cap is worth a line only beside entries that were shown.
  expect(lines(treeItems(new Map([['', ready([file('a')], true)]]), new Set(), false))).toEqual(['a', 'note:truncated']);
});

test('a level that could not be read names its failure, and keeps entries it showed before', () => {
  expect(lines(treeItems(new Map([['', { status: 'failed', error: 'gone' }]]), new Set(), false))).toEqual(['failure:gone']);
  expect(lines(treeItems(new Map([['', { ...ready([file('a')]), status: 'failed', error: 'gone' }]]), new Set(), false))).toEqual(['a', 'failure:gone']);
});

test('search matches are drawn as a tree pruned to them, every level open, a returned directory a match itself', () => {
  const matches = [file('b/z.md'), file('a/deep/notes.md'), directory('a'), file('README.md'), file('.env')];
  const shown = searchItems(matches, false);
  expect(shown.map(item => item.kind === 'entry' ? `${item.entry.path}${item.matched ? '*' : ''}` : item.kind)).toEqual(['a*', 'a/deep', 'a/deep/notes.md*', 'b', 'b/z.md*', 'README.md*']);
  expect(shown.map(item => item.depth)).toEqual([0, 1, 2, 0, 1, 0]);
  // Dot entries join only when the reader asked for hidden entries.
  expect(lines(searchItems(matches, true))).toEqual(['a', 'a/deep', 'a/deep/notes.md', 'b', 'b/z.md', '.env', 'README.md']);
  expect(searchItems([], false)).toEqual([]);
});
