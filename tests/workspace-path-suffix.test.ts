import { expect, test } from 'vitest';
import { distinguishingPathSuffixes } from '../plugins/sessions/src/path-suffix.ts';

const entry = (id: string, name: string, directory: string) => ({ id, name, directory });

test('unambiguous names need no suffix', () => {
  const suffixes = distinguishingPathSuffixes([
    entry('a', 'alpha', '/home/me/alpha'),
    entry('b', 'beta', '/home/me/beta'),
  ]);
  expect(suffixes.get('a')).toBe('');
  expect(suffixes.get('b')).toBe('');
});

test('same-named workspaces are told apart by the shortest unique trailing segment run', () => {
  const suffixes = distinguishingPathSuffixes([
    entry('a', 'app', '/home/me/work/app'),
    entry('b', 'app', '/home/you/work/app'),
    entry('c', 'app', '/home/you/other/app'),
  ]);
  // One trailing segment (`app`) is shared by all three; two still collide for a and b,
  // while `other/app` already tells c apart from both.
  expect(suffixes.get('a')).toBe('me/work/app');
  expect(suffixes.get('b')).toBe('you/work/app');
  expect(suffixes.get('c')).toBe('other/app');
});

test('nested twins fall back to their whole directory when only the root differs', () => {
  const suffixes = distinguishingPathSuffixes([
    entry('a', 'repo', '/a/repo'),
    entry('b', 'repo', '/b/repo'),
  ]);
  expect(suffixes.get('a')).toBe('a/repo');
  expect(suffixes.get('b')).toBe('b/repo');
});
