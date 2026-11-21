import { opendir, lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AorkError } from '@aork/sdk';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { BrowseDirectory, FileEntry } from '@aork/contracts/workspace';

const fail = (code: string, message: string, status = 400): never => { throw new AorkError(code, message, status); };
const INVALID = 'WORKSPACE_BROWSE_DIRECTORY_INVALID';
const DENIED = 'WORKSPACE_BROWSE_DIRECTORY_DENIED';
const MESSAGES = { missing: 'The directory does not exist', denied: 'The directory is not permitted', notDirectory: 'The path is not a directory', broken: 'The directory path is broken', unbrowsable: 'The directory cannot be browsed' } as const;
/** In-place errors only: never leak system details beyond missing / not permitted / not a directory. */
function browseFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return fail(INVALID, MESSAGES.missing, 404);
  if (code === 'EACCES' || code === 'EPERM') return fail(DENIED, MESSAGES.denied, 403);
  if (code === 'ENOTDIR') return fail(INVALID, MESSAGES.notDirectory);
  if (code === 'ELOOP') return fail(INVALID, MESSAGES.broken);
  return fail(INVALID, MESSAGES.unbrowsable);
}

function entry(directory: string, name: string, facts: Stats): FileEntry {
  return { name, path: join(directory, name), kind: facts.isSymbolicLink() ? 'symlink' : facts.isDirectory() ? 'directory' : facts.isFile() ? 'file' : 'other', size: Number(facts.size) };
}

/** The server never accepts `~` or relative paths; clients expand `~` with the response `home` field. */
function validate(path: string): string {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4096 || path.includes('\0') || !isAbsolute(path) || path.split('/').includes('..')) fail(INVALID, 'Browse requires an absolute server directory path');
  return path;
}

/** Single-level, browse-only directory listing for the directory picker. Metadata only:
 * no file contents are read, symlink entries are annotated rather than followed into subtrees. */
export async function browseDirectory(requestedPath: string): Promise<BrowseDirectory> {
  const path = validate(requestedPath);
  let directory;
  try { directory = await opendir(path); } catch (error) { return browseFailure(error); }
  const entries: FileEntry[] = []; let truncated = false; let encodedBytes = 0;
  try { let item; while ((item = await directory.read())) {
    if (entries.length >= FILE_LIMITS.entries) { truncated = true; break; }
    let facts: Stats;
    try { facts = await lstat(join(path, item.name)); } catch (error) {
      // Entries may vanish between listing and stat; a vanished entry is simply not part of this snapshot.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return browseFailure(error);
    }
    const next = entry(path, item.name, facts);
    // Same encoded-response budget as the Workspace file listing; an entry that would exceed it is dropped.
    encodedBytes += Buffer.byteLength(JSON.stringify(next));
    if (encodedBytes > 750 * 1024) { truncated = true; break; }
    entries.push(next);
  } } finally { await directory.close(); }
  entries.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
  return { home: homedir(), path, entries, truncated };
}
