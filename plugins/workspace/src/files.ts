import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access, lstat, link, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { AorkError } from '@aork/sdk';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { FileEntry, FilePreview, Workspace, WorkspaceFileService, WorkspaceService, WorkspaceWriterParticipant } from '@aork/contracts/workspace';

const fail = (code: string, message: string, status = 400): never => { throw new AorkError(code, message, status); };
async function filesystem<T>(action: () => T | Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof AorkError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const reasons: Record<string, string> = { ENOENT: 'File or directory no longer exists', EACCES: 'The server denied filesystem access', EPERM: 'The server denied filesystem access', ENOSPC: 'The server disk is full', EROFS: 'The server filesystem is read-only', EISDIR: 'Choose a regular file', ENOTDIR: 'A path component is not a directory', EEXIST: 'A file already exists at this path', EFBIG: 'The server rejected the file size' };
    return fail('WORKSPACE_FILE_FAILED', reasons[code ?? ''] ?? 'The filesystem operation failed; verify directory access and available storage', code === 'ENOENT' ? 404 : 400);
  }
}
/** Reject aliases below the registered root. The requested root alias must still identify the saved root.
 * Identity is the resolved path plus the inode: macOS renumbers a volume's device number across OS
 * updates, so the recorded device stays claim metadata and is never compared against the live stat. */
async function validateRoot(workspace: Workspace, write = false) {
  return filesystem(async () => {
    const root = await realpath(workspace.requestedDirectory); const facts = await stat(root, { bigint: true });
    if (root !== workspace.directory || workspace.scope.root !== root || !workspace.scope.recursive || !facts.isDirectory() || facts.ino.toString() !== workspace.directoryIdentity.inode) fail('WORKSPACE_DIRECTORY_CHANGED', 'The registered directory identity or access range changed', 409);
    await access(root, constants.R_OK | constants.X_OK | (write ? constants.W_OK : 0)); return root;
  });
}
export async function inspectWorkspaceDirectory(workspace: Workspace): Promise<import('@aork/contracts/workspace').WorkspaceDirectoryStatus> {
  try { await validateRoot(workspace, true); return { status: 'available' }; }
  catch { return { status: 'unavailable', reason: 'directory-unavailable' }; }
}
function pathParts(path: string, allowRoot = false) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || (!path && !allowRoot)) fail('WORKSPACE_PATH_INVALID', 'Use a relative path inside the Workspace');
  const parts = path ? path.split('/') : [];
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) fail('WORKSPACE_PATH_INVALID', 'Empty, dot and parent path components are not allowed');
  return parts;
}
/** Only an absent directory entry is missing; lstat preserves dangling symlinks for rejection. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function removeIfPresent(path: string) {
  try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function resolvePath(workspace: Workspace, path: string, options: { root?: boolean; missingLeaf?: boolean; write?: boolean } = {}) {
  const parts = pathParts(path, options.root); const root = await validateRoot(workspace, options.write); let target = root;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    const facts = options.missingLeaf && index === parts.length - 1 ? await lstatIfPresent(target) : await lstat(target);
    if (!facts) continue;
    if (facts.isSymbolicLink()) fail('WORKSPACE_SYMLINK_REJECTED', 'Symbolic links are not followed by the Workspace file service', 403);
    if (index < parts.length - 1 && !facts.isDirectory()) fail('WORKSPACE_PATH_INVALID', 'A path component is not a directory');
  }
  const parent = parts.length ? dirname(target) : target; const actualParent = await realpath(parent); const inside = relative(root, actualParent);
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) fail('WORKSPACE_PATH_OUTSIDE', 'Path leaves the registered directory', 403);
  return target;
}
const revision = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function entry(path: string, name: string, facts: Stats): FileEntry {
  return { name, path, kind: facts.isSymbolicLink() ? 'symlink' : facts.isDirectory() ? 'directory' : facts.isFile() ? 'file' : 'other', size: Number(facts.size) };
}
async function read(workspace: Workspace, path: string, limit: number) {
  return filesystem(async () => {
    const target = await resolvePath(workspace, path); const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const facts = await handle.stat({ bigint: true }); if (!facts.isFile()) fail('WORKSPACE_NOT_FILE', 'Choose a regular file');
      if (facts.size > BigInt(limit)) fail('WORKSPACE_FILE_TOO_LARGE', `File exceeds the ${limit} byte limit`, 413);
      const bytes = Buffer.alloc(Math.min(limit + 1, Number(facts.size) + 1)); let length = 0;
      while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead; }
      if (BigInt(length) !== facts.size || length > limit) fail('WORKSPACE_FILE_CHANGED', 'The file changed while it was being read; reload it', 409);
      const checked = await resolvePath(workspace, path); const current = await lstat(checked, { bigint: true }); const after = await handle.stat({ bigint: true });
      if (current.dev !== facts.dev || current.ino !== facts.ino || after.mtimeNs !== facts.mtimeNs || after.ctimeNs !== facts.ctimeNs || after.size !== facts.size) fail('WORKSPACE_FILE_CHANGED', 'The file changed while it was being read; reload it', 409);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  });
}
export function createWriteCoordinator(requireWorkspace: (id: string) => Workspace, inspectClaims: (workspace:Workspace)=>import('@aork/contracts/workspace').WorkspaceWriterState = ()=>({state:'unclaimed'})) {
  const admission = new AsyncLocalStorage<symbol>();
  const held = new Map<symbol, string>(); const claimWriters=new Map<symbol,string>(); let participant: WorkspaceWriterParticipant | undefined; let authorityRequired = false;
  return {
    assertCurrentWrite(workspace:Workspace){const key=admission.getStore();if(!key||held.get(key)!==workspace.directory)fail('WORKSPACE_ADMISSION_REQUIRED','Reserve a Claim inside the current coordinated Workspace write callback',409);},
    registerWriterParticipant(next: WorkspaceWriterParticipant) {
      if (participant || held.size) fail('WORKSPACE_WRITER_AUTHORITY_CONFLICT', 'Writer authority cannot change during a write or replace an active authority', 409);
      participant = next; authorityRequired = true; return () => { if (participant === next) participant = undefined; };
    },
    active(root:string){return [...claimWriters.values()].some(other=>{const a=relative(root,other),b=relative(other,root);return !a||(!a.startsWith('../')&&a!=='..'&&!isAbsolute(a))||(!b.startsWith('../')&&b!=='..'&&!isAbsolute(b));});},
    async withWritePermission<T>(id: string, operation: (workspace: Workspace) => T | Promise<T>, currentClaim?:()=>void): Promise<T> {
      const workspace = requireWorkspace(id); const root = await validateRoot(workspace, true); const latest = requireWorkspace(id);
      if (latest.directory !== workspace.directory || latest.scope.root !== workspace.scope.root) fail('WORKSPACE_DIRECTORY_CHANGED', 'Workspace registration changed; retry the operation', 409);
      // The overlap/authority checks and reservation contain no await: two validations cannot both reserve.
      for (const other of held.values()) {
        const a = relative(root, other); const b = relative(other, root);
        if (!a || (!a.startsWith('../') && a !== '..' && !isAbsolute(a)) || (!b.startsWith('../') && b !== '..' && !isAbsolute(b))) fail('WORKSPACE_WRITE_BUSY', 'Another writer holds this directory or an overlapping Workspace', 409);
      }
      if(currentClaim)currentClaim();
      const claim=currentClaim?{state:'unclaimed' as const}:inspectClaims(latest); if(claim.state!=='unclaimed') fail(claim.state==='blocked'?'WORKSPACE_WRITE_BUSY':'WORKSPACE_WRITER_UNKNOWN',claim.reason,409);
      if (authorityRequired && !participant) fail('WORKSPACE_WRITER_UNKNOWN', 'Writer ownership is unknown; restore the lifecycle service', 409);
      if (participant&&!currentClaim) {
        let state; try { state = participant.inspect(latest); } catch { fail('WORKSPACE_WRITER_UNKNOWN', 'Writer ownership could not be verified', 409); }
        if (state?.state !== 'unclaimed') fail(state?.state === 'blocked' ? 'WORKSPACE_WRITE_BUSY' : 'WORKSPACE_WRITER_UNKNOWN', state && 'reason' in state ? state.reason : 'Writer ownership is unknown', 409);
      }
      const key = Symbol(); held.set(key, root);if(currentClaim)claimWriters.set(key,root);
      try { return await admission.run(key,()=>operation(latest)); } finally { held.delete(key);claimWriters.delete(key); }
    },
  };
}
export function createFileService(service: WorkspaceService, runAdmission?:{write<T>(id:string,operation:(workspace:Workspace)=>T|Promise<T>):Promise<T>;check():void}): WorkspaceFileService {
  const workspace = (id: string) => service.requireOpenWorkspace(id);
  function save(id: string, path: string, bytes: Uint8Array, createOnly: boolean, expectedRevision?: string) {
    return (runAdmission?.write??service.withWritePermission)(id, async current => filesystem(async () => {
      runAdmission?.check();
      if (bytes.byteLength > FILE_LIMITS.transferBytes) fail('WORKSPACE_FILE_TOO_LARGE', 'Upload exceeds the 8 MiB limit', 413);
      const latest = () => { runAdmission?.check(); const value = workspace(id); if (value.directory !== current.directory) fail('WORKSPACE_DIRECTORY_CHANGED', 'Workspace registration changed; retry the write', 409); return value; };
      const target = await resolvePath(latest(), path, { missingLeaf: true, write: true });
      async function checkDestination() {
        await resolvePath(latest(), path, { missingLeaf: true, write: true }); const existing = await lstatIfPresent(target);
        if (existing) {
          if (existing.isSymbolicLink()) fail('WORKSPACE_SYMLINK_REJECTED', 'Symbolic links are not followed by the Workspace file service', 403);
          if (!existing.isFile()) fail('WORKSPACE_NOT_FILE', 'Choose a regular file');
          if (createOnly) fail('WORKSPACE_FILE_EXISTS', 'A file already exists; choose another upload name', 409);
          if (expectedRevision && revision(await read(latest(), path, FILE_LIMITS.textBytes)) !== expectedRevision) fail('WORKSPACE_FILE_CHANGED', 'The file was changed by another writer; reload before saving', 409);
        } else if (expectedRevision) fail('WORKSPACE_FILE_CHANGED', 'The original file no longer exists; reload before saving', 409);
      }
      await checkDestination(); const temp = join(dirname(target), `.aork-upload-${randomUUID()}`); let handle: FileHandle | undefined;
      try {
        handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        let offset = 0; while (offset < bytes.byteLength) { const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null); if (!bytesWritten) fail('WORKSPACE_FILE_FAILED', 'The filesystem could not complete this write'); offset += bytesWritten; }
        runAdmission?.check(); await handle.sync(); await handle.close(); handle = undefined;
        await checkDestination(); await resolvePath(latest(), path, { missingLeaf: true, write: true }); latest();
        if (createOnly) {
          // Atomic create-only publication also rejects a new entry inserted after final lstat.
          try { await link(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('WORKSPACE_FILE_EXISTS', 'A file already exists; choose another upload name', 409); throw error; }
        } else await rename(temp, target);
        return { path, size: bytes.byteLength, revision: revision(bytes) };
      } finally { try { if (handle) await handle.close(); } finally { await removeIfPresent(temp); } }
    }));
  }
  return {
    async list(id, path) { return filesystem(async () => {
      const current = workspace(id); const target = await resolvePath(current, path, { root: true }); if (!(await stat(target)).isDirectory()) fail('WORKSPACE_NOT_DIRECTORY', 'Choose a directory');
      const directory = await opendir(target); const entries: FileEntry[] = []; let truncated = false; let encodedBytes = 0;
      try { let item; while ((item = await directory.read())) {
        if (entries.length >= FILE_LIMITS.entries) { truncated = true; break; }
        const next = entry(path ? `${path}/${item.name}` : item.name, item.name, await lstat(join(target, item.name)));
        encodedBytes += Buffer.byteLength(JSON.stringify(next)); if (encodedBytes > FILE_LIMITS.responseBytes) { truncated = true; break; } entries.push(next);
      } } finally { await directory.close(); }
      entries.sort((a, b) => a.name.localeCompare(b.name)); await resolvePath(workspace(id), path, { root: true }); return { path, entries, truncated };
    }); },
    async search(id, query) { return filesystem(async () => {
      if (!query.trim() || query.length > 120) fail('WORKSPACE_SEARCH_INVALID', 'Enter a filename search of 1 to 120 characters');
      const current = workspace(id); const entries: FileEntry[] = []; const pending = ['']; let visited = 0; let truncated = false; let encodedBytes = 0;
      while (pending.length) {
        const path = pending.pop()!; const target = await resolvePath(current, path, { root: true }); const directory = await opendir(target);
        try { let next; while ((next = await directory.read())) {
          if (++visited > FILE_LIMITS.searchEntries) { truncated = true; break; }
          const name = next.name; const child = path ? `${path}/${name}` : name; const item = entry(child, name, await lstat(join(target, name)));
          if (child.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
            encodedBytes += Buffer.byteLength(JSON.stringify(item)); if (encodedBytes > FILE_LIMITS.responseBytes) { truncated = true; break; }
            entries.push(item); if (entries.length >= FILE_LIMITS.searchResults) { truncated = true; break; }
          }
          if (item.kind === 'directory') { if (child.split('/').length < 32) pending.push(child); else truncated = true; }
        } } finally { await directory.close(); }
        if (truncated) break;
      }
      await validateRoot(workspace(id)); return { entries, visited: Math.min(visited, FILE_LIMITS.searchEntries), truncated };
    }); },
    async preview(id, path, startLine = 1, lines = 200): Promise<FilePreview> {
      if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lines) || lines < 1 || lines > 500) fail('WORKSPACE_LINES_INVALID', 'Choose a positive starting line and 1 to 500 lines');
      const bytes = await read(workspace(id), path, FILE_LIMITS.textBytes); let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) throw Error(); } catch { return fail('WORKSPACE_BINARY_FILE', 'This file is not UTF-8 text; download it instead', 415); }
      workspace(id); const all = text.split('\n'); return { path, text: all.slice(startLine - 1, startLine - 1 + lines).join('\n'), startLine, totalLines: all.length, truncated: startLine > 1 || startLine - 1 + lines < all.length, revision: revision(bytes), editable: startLine === 1 && all.length <= lines };
    },
    async download(id, path) { const bytes = await read(workspace(id), path, FILE_LIMITS.transferBytes); workspace(id); return bytes; },
    upload(id, path, bytes) { return save(id, path, bytes, true); },
    writeText(id, path, text, expectedRevision) {
      const bytes = Buffer.from(text, 'utf8'); if (bytes.byteLength > FILE_LIMITS.textBytes || text.includes('\0')) fail('WORKSPACE_TEXT_TOO_LARGE', 'Text must be UTF-8 without NUL and at most 256 KiB', 413);
      return save(id, path, bytes, false, expectedRevision);
    },
  };
}
