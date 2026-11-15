import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants, accessSync, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, opendirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { AorkError } from '@aork/sdk';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { FileEntry, FilePreview, Workspace, WorkspaceFileService, WorkspaceService, WorkspaceWriterParticipant } from '@aork/contracts/workspace';

const fail = (code: string, message: string, status = 400): never => { throw new AorkError(code, message, status); };
function filesystem<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof AorkError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const reasons: Record<string, string> = { ENOENT: 'File or directory no longer exists', EACCES: 'The server denied filesystem access', EPERM: 'The server denied filesystem access', ENOSPC: 'The server disk is full', EROFS: 'The server filesystem is read-only', EISDIR: 'Choose a regular file', ENOTDIR: 'A path component is not a directory', EEXIST: 'A file already exists at this path', EFBIG: 'The server rejected the file size' };
    return fail('WORKSPACE_FILE_FAILED', reasons[code ?? ''] ?? 'The filesystem operation failed; verify directory access and available storage', code === 'ENOENT' ? 404 : 400);
  }
}
/** Reject aliases below the registered root. The requested root alias itself must still identify the saved root. */
function validateRoot(workspace: Workspace, write = false) {
  return filesystem(() => {
    const root = realpathSync(workspace.requestedDirectory); const facts = statSync(root, { bigint: true });
    if (root !== workspace.directory || workspace.scope.root !== root || !workspace.scope.recursive || !facts.isDirectory() || facts.dev.toString() !== workspace.directoryIdentity.device || facts.ino.toString() !== workspace.directoryIdentity.inode) fail('WORKSPACE_DIRECTORY_CHANGED', 'The registered directory identity or access range changed', 409);
    if (write && workspace.access !== 'read-write') fail('WORKSPACE_READ_ONLY', 'This Workspace is read-only', 403);
    accessSync(root, constants.R_OK | constants.X_OK | (write ? constants.W_OK : 0)); return root;
  });
}
function pathParts(path: string, allowRoot = false) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || (!path && !allowRoot)) fail('WORKSPACE_PATH_INVALID', 'Use a relative path inside the Workspace');
  const parts = path ? path.split('/') : [];
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) fail('WORKSPACE_PATH_INVALID', 'Empty, dot and parent path components are not allowed');
  return parts;
}
/** Only an absent directory entry is missing; lstat preserves dangling symlinks for rejection. */
function lstatIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function removeIfPresent(path: string) {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function resolvePath(workspace: Workspace, path: string, options: { root?: boolean; missingLeaf?: boolean; write?: boolean } = {}) {
  const parts = pathParts(path, options.root); const root = validateRoot(workspace, options.write); let target = root;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    const facts = options.missingLeaf && index === parts.length - 1 ? lstatIfPresent(target) : lstatSync(target);
    if (!facts) continue;
    if (facts.isSymbolicLink()) fail('WORKSPACE_SYMLINK_REJECTED', 'Symbolic links are not followed by the Workspace file service', 403);
    if (index < parts.length - 1 && !facts.isDirectory()) fail('WORKSPACE_PATH_INVALID', 'A path component is not a directory');
  }
  const parent = parts.length ? dirname(target) : target;
  const actualParent = realpathSync(parent); const inside = relative(root, actualParent);
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) fail('WORKSPACE_PATH_OUTSIDE', 'Path leaves the registered directory', 403);
  return target;
}
const revision = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function entry(path: string, name: string, facts: Stats): FileEntry {
  return { name, path, kind: facts.isSymbolicLink() ? 'symlink' : facts.isDirectory() ? 'directory' : facts.isFile() ? 'file' : 'other', size: Number(facts.size) };
}
function read(workspace: Workspace, path: string, limit: number) {
  return filesystem(() => {
    const target = resolvePath(workspace, path); const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const facts = fstatSync(fd); if (!facts.isFile()) fail('WORKSPACE_NOT_FILE', 'Choose a regular file');
      if (facts.size > limit) fail('WORKSPACE_FILE_TOO_LARGE', `File exceeds the ${limit} byte limit`, 413);
      const bytes = Buffer.alloc(Math.min(limit + 1, facts.size + 1)); let length = 0;
      while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
      if (length > limit || length !== facts.size) fail('WORKSPACE_FILE_CHANGED', 'The file changed while it was being read; reload it', 409);
      const checked = resolvePath(workspace, path); const current = lstatSync(checked); const after = fstatSync(fd);
      if (current.dev !== facts.dev || current.ino !== facts.ino || after.mtimeMs !== facts.mtimeMs || after.size !== facts.size) fail('WORKSPACE_FILE_CHANGED', 'The file changed while it was being read; reload it', 409);
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  });
}
export function createWriteCoordinator(requireWorkspace: (id: string) => Workspace) {
  const held = new Map<symbol, string>(); let participant: WorkspaceWriterParticipant | undefined; let authorityRequired = false;
  return {
    registerWriterParticipant(next: WorkspaceWriterParticipant) {
      if (participant || held.size) fail('WORKSPACE_WRITER_AUTHORITY_CONFLICT', 'Writer authority cannot change during a write or replace an active authority', 409);
      participant = next; authorityRequired = true;
      return () => { if (participant === next) participant = undefined; };
    },
    async withWritePermission<T>(id: string, operation: (workspace: Workspace) => T | Promise<T>): Promise<T> {
      const workspace = requireWorkspace(id); const root = validateRoot(workspace, true);
      for (const other of held.values()) {
        const a = relative(root, other); const b = relative(other, root);
        if (!a || (!a.startsWith('../') && a !== '..' && !isAbsolute(a)) || (!b.startsWith('../') && b !== '..' && !isAbsolute(b))) fail('WORKSPACE_WRITE_BUSY', 'Another writer holds this directory or an overlapping Workspace', 409);
      }
      // No managed-writer subsystem is installed yet. Once registered, absence is unknown, never unclaimed.
      if (authorityRequired && !participant) fail('WORKSPACE_WRITER_UNKNOWN', 'Writer ownership is unknown; restore the lifecycle service', 409);
      if (participant) {
        let state;
        try { state = participant.inspect(workspace); } catch { fail('WORKSPACE_WRITER_UNKNOWN', 'Writer ownership could not be verified', 409); }
        if (state?.state !== 'unclaimed') fail(state?.state === 'blocked' ? 'WORKSPACE_WRITE_BUSY' : 'WORKSPACE_WRITER_UNKNOWN', state && 'reason' in state ? state.reason : 'Writer ownership is unknown', 409);
      }
      const key = Symbol(); held.set(key, root);
      try { return await operation(workspace); } finally { held.delete(key); }
    },
  };
}
export function createFileService(service: WorkspaceService): WorkspaceFileService {
  const workspace = (id: string) => service.requireOpenWorkspace(id);
  function save(id: string, path: string, bytes: Uint8Array, createOnly: boolean, expectedRevision?: string) {
    return service.withWritePermission(id, current => filesystem(() => {
      if (bytes.byteLength > FILE_LIMITS.transferBytes) fail('WORKSPACE_FILE_TOO_LARGE', 'Upload exceeds the 8 MiB limit', 413);
      const target = resolvePath(current, path, { missingLeaf: true, write: true });
      const existing = lstatIfPresent(target);
      if (existing) {
        if (!existing.isFile()) fail('WORKSPACE_NOT_FILE', 'Choose a regular file');
        if (createOnly) fail('WORKSPACE_FILE_EXISTS', 'A file already exists; choose another upload name', 409);
        if (expectedRevision && revision(read(current, path, FILE_LIMITS.textBytes)) !== expectedRevision) fail('WORKSPACE_FILE_CHANGED', 'The file was changed by another writer; reload before saving', 409);
      } else if (expectedRevision) fail('WORKSPACE_FILE_CHANGED', 'The original file no longer exists; reload before saving', 409);
      const temp = join(dirname(target), `.aork-upload-${randomUUID()}`); let fd: number | undefined;
      try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        let offset = 0; while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
        fsyncSync(fd); closeSync(fd); fd = undefined;
        resolvePath(current, path, { missingLeaf: true, write: true });
        const finalEntry = lstatIfPresent(target);
        if (finalEntry && !finalEntry.isFile()) fail('WORKSPACE_NOT_FILE', 'Choose a regular file');
        if (createOnly && finalEntry) fail('WORKSPACE_FILE_EXISTS', 'A file already exists; choose another upload name', 409);
        renameSync(temp, target);
        return { path, size: bytes.byteLength, revision: revision(bytes) };
      } finally { try { if (fd !== undefined) closeSync(fd); } finally { removeIfPresent(temp); } }
    }));
  }
  return {
    list(id, path) { return filesystem(() => {
      const current = workspace(id); const target = resolvePath(current, path, { root: true }); if (!statSync(target).isDirectory()) fail('WORKSPACE_NOT_DIRECTORY', 'Choose a directory');
      const directory = opendirSync(target); const entries: FileEntry[] = []; let truncated = false; let encodedBytes = 0;
      try {
        let item; while ((item = directory.readSync())) {
          if (entries.length >= FILE_LIMITS.entries) { truncated = true; break; }
          const next = entry(path ? `${path}/${item.name}` : item.name, item.name, lstatSync(join(target, item.name)));
          encodedBytes += Buffer.byteLength(JSON.stringify(next)); if (encodedBytes > 750 * 1024) { truncated = true; break; }
          entries.push(next);
        }
      } finally { directory.closeSync(); }
      entries.sort((a, b) => a.name.localeCompare(b.name)); validateRoot(current); return { path, entries, truncated };
    }); },
    search(id, query) { return filesystem(() => {
      if (!query.trim() || query.length > 120) fail('WORKSPACE_SEARCH_INVALID', 'Enter a filename search of 1 to 120 characters');
      const current = workspace(id); const entries: FileEntry[] = []; const pending = ['']; let visited = 0; let truncated = false; let encodedBytes = 0;
      while (pending.length) {
        const path = pending.pop()!; const target = resolvePath(current, path, { root: true }); const directory = opendirSync(target);
        try {
          let next; while ((next = directory.readSync())) {
            if (++visited > FILE_LIMITS.searchEntries) { truncated = true; break; }
            const name = next.name; const child = path ? `${path}/${name}` : name; const item = entry(child, name, lstatSync(join(target, name)));
            if (child.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
              encodedBytes += Buffer.byteLength(JSON.stringify(item)); if (encodedBytes > 750 * 1024) { truncated = true; break; }
              entries.push(item); if (entries.length >= FILE_LIMITS.searchResults) { truncated = true; break; }
            }
            if (item.kind === 'directory') { if (child.split('/').length < 32) pending.push(child); else truncated = true; }
          }
        } finally { directory.closeSync(); }
        if (truncated) break;
      }
      validateRoot(current); return { entries, visited: Math.min(visited, FILE_LIMITS.searchEntries), truncated };
    }); },
    preview(id, path, startLine = 1, lines = 200): FilePreview {
      if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lines) || lines < 1 || lines > 500) fail('WORKSPACE_LINES_INVALID', 'Choose a positive starting line and 1 to 500 lines');
      const bytes = read(workspace(id), path, FILE_LIMITS.textBytes); let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) throw Error(); } catch { return fail('WORKSPACE_BINARY_FILE', 'This file is not UTF-8 text; download it instead', 415); }
      const all = text.split('\n'); const selected = all.slice(startLine - 1, startLine - 1 + lines);
      return { path, text: selected.join('\n'), startLine, totalLines: all.length, truncated: startLine > 1 || startLine - 1 + lines < all.length, revision: revision(bytes), editable: startLine === 1 && all.length <= lines };
    },
    download(id, path) { return read(workspace(id), path, FILE_LIMITS.transferBytes); },
    upload(id, path, bytes) { return save(id, path, bytes, true); },
    writeText(id, path, text, expectedRevision) {
      const bytes = Buffer.from(text, 'utf8'); if (bytes.byteLength > FILE_LIMITS.textBytes || text.includes('\0')) fail('WORKSPACE_TEXT_TOO_LARGE', 'Text must be UTF-8 without NUL and at most 256 KiB', 413);
      return save(id, path, bytes, false, expectedRevision);
    },
  };
}
