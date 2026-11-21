import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { browseDirectory } from '../plugins/workspace/src/browse.ts';
import { AorkError } from '@aork/sdk';
import { FILE_LIMITS, browseDirectoryInputSchema, browseDirectorySchema } from '@aork/contracts/workspace';

async function browseFailure(path: string): Promise<AorkError> {
  try { await browseDirectory(path); } catch (error) { return error as AorkError; }
  throw new Error(`expected browseDirectory(${JSON.stringify(path)}) to fail`);
}

let root: string | undefined;

async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'aork-browse-'));
  return root;
}

test('browse lists a single directory level as metadata entries, directories first', async () => {
  const dir = await makeRoot();
  await mkdir(join(dir, 'notes'));
  await writeFile(join(dir, 'a.txt'), 'hello');
  await writeFile(join(dir, 'z.md'), 'x');
  await writeFile(join(dir, 'notes', 'nested.txt'), 'deeper');

  const result = await browseDirectory(dir);

  expect(result.home).toBe(homedir());
  expect(result.path).toBe(dir);
  expect(result.truncated).toBe(false);
  expect(result.entries.map(entry => [entry.name, entry.kind, entry.size])).toEqual([
    ['notes', 'directory', expect.any(Number)],
    ['a.txt', 'file', 5],
    ['z.md', 'file', 1],
  ]);
  expect(result.entries.map(entry => entry.path)).toEqual([join(dir, 'notes'), join(dir, 'a.txt'), join(dir, 'z.md')]);
  // Single level only: the nested file must not leak into this listing.
  expect(result.entries.some(entry => entry.name === 'nested.txt')).toBe(false);
});

afterEach(async () => { if (root) { await rm(root, { recursive: true, force: true }); root = undefined; } });

test('symlink entries are annotated by kind and never followed into subtrees', async () => {
  const dir = await makeRoot();
  await mkdir(join(dir, 'real-dir'));
  await writeFile(join(dir, 'real.txt'), 'x');
  await symlink(join(dir, 'real-dir'), join(dir, 'link-dir'));
  await symlink(join(dir, 'real.txt'), join(dir, 'link-file'));
  await symlink(join(dir, 'missing-target'), join(dir, 'dangling'));

  const result = await browseDirectory(dir);

  expect(result.entries.find(entry => entry.name === 'link-dir')).toMatchObject({ kind: 'symlink' });
  expect(result.entries.find(entry => entry.name === 'link-file')).toMatchObject({ kind: 'symlink' });
  // A dangling symlink is still an entry with symlink kind, not an error.
  expect(result.entries.find(entry => entry.name === 'dangling')).toMatchObject({ kind: 'symlink' });
});

test('dotfiles are returned as-is; hiding is client-side', async () => {
  const dir = await makeRoot();
  await writeFile(join(dir, '.hidden-file'), 'x');
  await mkdir(join(dir, '.hidden-dir'));

  const result = await browseDirectory(dir);

  expect(result.entries.find(entry => entry.name === '.hidden-file')).toMatchObject({ kind: 'file' });
  expect(result.entries.find(entry => entry.name === '.hidden-dir')).toMatchObject({ kind: 'directory' });
});

test('browse results conform to the workspace browse contract', async () => {
  const dir = await makeRoot();
  await writeFile(join(dir, 'note.txt'), 'x');

  const result = await browseDirectory(dir);

  expect(browseDirectorySchema.parse(result)).toEqual(result);
  expect(browseDirectoryInputSchema.parse({ path: dir })).toEqual({ path: dir });
});

test('a missing directory or a dangling path fails in place without system detail', async () => {
  const dir = await makeRoot();
  const missing = await browseFailure(join(dir, 'absent'));
  expect(missing.code).toBe('WORKSPACE_BROWSE_DIRECTORY_INVALID');
  expect(missing.status).toBe(404);
  expect(missing.message).toBe('The directory does not exist');
  // A dangling symlink as the browsed path itself is equally missing.
  await symlink(join(dir, 'nope'), join(dir, 'dangling-root'));
  const dangling = await browseFailure(join(dir, 'dangling-root'));
  expect(dangling.code).toBe('WORKSPACE_BROWSE_DIRECTORY_INVALID');
});

test('browsing a file path fails as not a directory', async () => {
  const dir = await makeRoot();
  await writeFile(join(dir, 'plain.txt'), 'x');
  const error = await browseFailure(join(dir, 'plain.txt'));
  expect(error.code).toBe('WORKSPACE_BROWSE_DIRECTORY_INVALID');
  expect(error.status).toBe(400);
  expect(error.message).toBe('The path is not a directory');
});

test('relative paths, parent components, empty and malformed paths are rejected', async () => {
  const dir = await makeRoot();
  for (const path of ['', 'relative/path', 'relative', '../elsewhere', `${dir}/../outside`, `${dir}/inner/../sibling`, '/a/\0/b', 'x'.repeat(4097)]) {
    const error = await browseFailure(path);
    expect(error.code).toBe('WORKSPACE_BROWSE_DIRECTORY_INVALID');
    expect(error.status).toBe(400);
  }
  // A normalized path that merely does not exist is missing, not rejected.
  const missing = await browseFailure(join(dir, '..', 'elsewhere-normalized'));
  expect(missing.code).toBe('WORKSPACE_BROWSE_DIRECTORY_INVALID');
  expect(missing.status).toBe(404);
});

test('listings stop at the 500 entry cap with truncated set', async () => {
  const dir = await makeRoot();
  for (let i = 0; i < FILE_LIMITS.entries + 5; i++) await writeFile(join(dir, `f${String(i).padStart(3, '0')}`), 'x');

  const result = await browseDirectory(dir);

  expect(result.entries.length).toBe(FILE_LIMITS.entries);
  expect(result.truncated).toBe(true);
});

test('very large encoded listings truncate on the byte budget as well', async () => {
  const dir = await makeRoot();
  // JSON-escaped control characters make each encoded entry far larger than a plain name.
  for (let i = 0; i < 300; i++) await writeFile(join(dir, `${String(i).padStart(3, '0')}${'\u0001'.repeat(250)}`), 'x');

  const result = await browseDirectory(dir);

  expect(result.truncated).toBe(true);
  expect(result.entries.length).toBeGreaterThan(0);
  expect(result.entries.length).toBeLessThan(300);
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test.skipIf(isRoot)('a directory without read permission fails as denied', async () => {
  const dir = await makeRoot();
  await writeFile(join(dir, 'inside.txt'), 'x');
  await chmod(dir, 0o000);
  try {
    const error = await browseFailure(dir);
    expect(error.code).toBe('WORKSPACE_BROWSE_DIRECTORY_DENIED');
    expect(error.status).toBe(403);
    expect(error.message).toBe('The directory is not permitted');
  } finally { await chmod(dir, 0o700); }
});
