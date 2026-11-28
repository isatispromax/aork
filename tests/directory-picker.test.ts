import { expect, test } from 'vitest';
import { breadcrumbSegments, confirmSelection, expandHomePath, filterHiddenEntries, normalizeDirectoryPath, parentPath, quickAccessTargets } from '../plugins/workspace/src/directory-picker.tsx';
import type { FileEntry } from '@aork/contracts/workspace';

const entry = (name: string, path: string, kind: FileEntry['kind']): FileEntry => ({ name, path, kind, size: 0 });
const HOME = '/Users/yang';

test('expandHomePath expands `~` and `~/...` against the known home and leaves other inputs alone', () => {
  expect(expandHomePath('~', HOME)).toBe(HOME);
  expect(expandHomePath('~/Desktop', HOME)).toBe(`${HOME}/Desktop`);
  expect(expandHomePath('~/.config/aork', HOME)).toBe(`${HOME}/.config/aork`);
  // Non-`~` inputs pass through untouched; the server rejects what it cannot browse.
  expect(expandHomePath('/Users/yang/Projects', HOME)).toBe('/Users/yang/Projects');
  expect(expandHomePath('relative/path', HOME)).toBe('relative/path');
  // Only a leading bare `~` (or `~/`) is the user's home; `~other` is left for the server to reject.
  expect(expandHomePath('~other/shared', HOME)).toBe('~other/shared');
});

test('expandHomePath reports `~` inputs as unavailable before the first browse reveals home', () => {
  expect(expandHomePath('~', undefined)).toBeNull();
  expect(expandHomePath('~/Desktop', undefined)).toBeNull();
  // Absolute paths never depend on home knowledge.
  expect(expandHomePath('/tmp/aork', undefined)).toBe('/tmp/aork');
});

test('normalizeDirectoryPath strips trailing slashes but always keeps the root', () => {
  expect(normalizeDirectoryPath('/Users/yang/')).toBe('/Users/yang');
  expect(normalizeDirectoryPath('/Users/yang//')).toBe('/Users/yang');
  expect(normalizeDirectoryPath('/')).toBe('/');
  expect(normalizeDirectoryPath('//')).toBe('/');
  expect(normalizeDirectoryPath('/Users/yang/Projects/')).toBe('/Users/yang/Projects');
});

test('parentPath returns the parent directory and null at the root', () => {
  expect(parentPath('/')).toBeNull();
  expect(parentPath('/Users')).toBe('/');
  expect(parentPath('/Users/yang')).toBe('/Users');
  expect(parentPath('/Users/yang/Projects')).toBe('/Users/yang');
  expect(parentPath('/Users/yang/Projects/')).toBe('/Users/yang');
});

test('breadcrumbSegments yields the root plus one clickable segment per directory level', () => {
  expect(breadcrumbSegments('/')).toEqual([{ name: '/', path: '/' }]);
  expect(breadcrumbSegments('/Users/yang')).toEqual([
    { name: '/', path: '/' },
    { name: 'Users', path: '/Users' },
    { name: 'yang', path: '/Users/yang' },
  ]);
  // Trailing slashes must not invent an empty trailing segment.
  expect(breadcrumbSegments('/Users/yang/')).toEqual(breadcrumbSegments('/Users/yang'));
});

test('filterHiddenEntries hides dotfiles by default and reveals everything when toggled on', () => {
  const entries = [entry('.hidden', '/Users/yang/.hidden', 'file'), entry('Notes', '/Users/yang/Notes', 'directory'), entry('.config', '/Users/yang/.config', 'directory'), entry('z.md', '/Users/yang/z.md', 'file')];
  expect(filterHiddenEntries(entries, false).map(item => item.name)).toEqual(['Notes', 'z.md']);
  expect(filterHiddenEntries(entries, true).map(item => item.name)).toEqual(['.hidden', 'Notes', '.config', 'z.md']);
  // Pure client-side filter: the server listing must not be mutated.
  expect(entries.map(item => item.name)).toEqual(['.hidden', 'Notes', '.config', 'z.md']);
});

test('confirmSelection confirms a selected directory, or the current directory when nothing is selected', () => {
  expect(confirmSelection(null, '/Users/yang')).toEqual({ enabled: true, path: '/Users/yang' });
  expect(confirmSelection(entry('Projects', '/Users/yang/Projects', 'directory'), '/Users/yang')).toEqual({ enabled: true, path: '/Users/yang/Projects' });
});

test('confirmSelection is disabled while a non-directory row (file, symlink, other) is selected', () => {
  expect(confirmSelection(entry('z.md', '/Users/yang/z.md', 'file'), '/Users/yang')).toEqual({ enabled: false, path: null });
  expect(confirmSelection(entry('link', '/Users/yang/link', 'symlink'), '/Users/yang')).toEqual({ enabled: false, path: null });
  expect(confirmSelection(entry('socket', '/Users/yang/socket', 'other'), '/Users/yang')).toEqual({ enabled: false, path: null });
});

test('quickAccessTargets maps the four static entries onto the discovered home', () => {
  expect(quickAccessTargets(HOME)).toEqual([
    { label: '主目录', path: HOME },
    { label: '桌面', path: `${HOME}/Desktop` },
    { label: '文稿', path: `${HOME}/Documents` },
    { label: '下载', path: `${HOME}/Downloads` },
  ]);
});
