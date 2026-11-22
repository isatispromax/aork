import { z } from 'zod';
import type { SyncTransaction, OwnerDescriptor } from '@aork/sdk/server';

export const WORKSPACE_SERVICE = 'aork.workspace@1';
export const WORKSPACE_BROWSER = 'aork.workspace.browser@1';
const id = z.uuid();
const name = z.string().trim().min(1).max(120);
export const workspaceSchema = z.object({
  id, name, status: z.enum(['open', 'archived']),
  requestedDirectory: z.string(), directory: z.string(), access: z.enum(['read-only', 'read-write']),
  scope: z.object({ root: z.string(), recursive: z.literal(true) }).strict(),
  directoryIdentity: z.object({ device: z.string(), inode: z.string() }).strict(),
}).strict();
/** Every Workspace registers an existing server directory; the managed auto-create mode is deleted. */
export const workspaceInputSchema = z.object({ name, directory: z.string().min(1).max(4096), access: z.enum(['read-only', 'read-write']) }).strict();
export const workspaceOverviewSchema = z.object({ workspaces: z.array(workspaceSchema) }).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceOverview = z.infer<typeof workspaceOverviewSchema>;
export const workspaceDirectoryStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['registration-missing', 'directory-unavailable']) }).strict(),
]);
export type WorkspaceDirectoryStatus = z.infer<typeof workspaceDirectoryStatusSchema>;
/** Future lifecycle owners participate explicitly; no raw tables or database connection cross this service. */
export interface WorkspaceService {
  getWorkspace(id: string, transaction?: SyncTransaction): Workspace | undefined;
  requireOpenWorkspace(id: string, transaction?: SyncTransaction): Workspace;
  /** Checks the registered physical identity even for archived history; never erases registration.
   * This observation is not a writer reservation or authorization to launch a Run. */
  inspectDirectory(id: string): Promise<WorkspaceDirectoryStatus>;
  readonly files: WorkspaceFileService;
  /** One coordinator gates file operations and future Run Claim creation. Held across awaited work.
   * Reservation callbacks persist the real Claim before returning; later inspections retain it. */
  withWritePermission<T>(id: string, operation: (workspace: Workspace) => T | Promise<T>): Promise<T>;
  reserveClaim(transaction: SyncTransaction, owner: OwnerDescriptor, runId: string, workspaceId: string, usedPluginIds: readonly string[]): WorkspaceClaimPermit;
  verifyClaim(transaction:SyncTransaction,permit:WorkspaceClaimPermit,owner:OwnerDescriptor,runId:string,workspaceId:string):void;
  releaseClaim(transaction: SyncTransaction, owner: OwnerDescriptor, runId: string): void;
  blockClaim(transaction: SyncTransaction, owner: OwnerDescriptor, runId: string, reason: string): void;
  registerWriterParticipant(participant: WorkspaceWriterParticipant): () => void;
}
/** Shared URL identity contract. Unrelated plugin keys survive entity selection updates. */
export function readWorkbenchSelection(hash: string) {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  return { workspaceId: values.get('workspace'), sessionId: values.get('session'), replyId:values.get('reply'), creatingSession: values.get('createSession') === '1' };
}
export function withWorkbenchSelection(hash: string, update: Partial<{ workspaceId: string | null; sessionId: string | null; creatingSession: boolean; directory: string | null; file: string | null; line: string | null }>): string {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  if(update.workspaceId!==undefined||update.sessionId!==undefined||update.creatingSession){
    for (const key of ['page', 'reply', 'interaction', 'input']) values.delete(key);
  }
  // Relative Files and artifact selection belong to their Workspace. Explicit new values apply below.
  if (update.workspaceId !== undefined && update.workspaceId !== values.get('workspace')) {
    for (const key of ['directory', 'file', 'line', 'artifact', 'artifactVersion']) values.delete(key);
  }
  const keys = { workspaceId: 'workspace', sessionId: 'session', creatingSession: 'createSession', directory: 'directory', file: 'file', line: 'line' } as const;
  for (const key of Object.keys(update) as Array<keyof typeof update>) {
    const value = update[key]; if (value === undefined) continue;
    if (value === null || value === false) values.delete(keys[key]); else values.set(keys[key], value === true ? '1' : value);
  }
  return values.toString();
}
export const createWorkspaceSchema = z.object({ workspace: workspaceInputSchema }).strict();
export const entityIdSchema = z.object({ id }).strict();
export const editWorkspaceSchema = z.object({ id, name, access: z.enum(['read-only', 'read-write']) }).strict();

export const WORKSPACE_FILES = 'aork.workspace.files@1';
export const FILE_LIMITS = { transferBytes: 8 * 1024 * 1024, textBytes: 256 * 1024, entries: 500, searchEntries: 5000, searchResults: 200, responseBytes: 750 * 1024 } as const;
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface FileSearch { entries: FileEntry[]; truncated: boolean; visited: number }
export interface FilePreview { path: string; text: string; startLine: number; totalLines: number; truncated: boolean; revision: string; editable: boolean }
export interface FileWriteResult { path: string; size: number; revision: string }
/** Single-level browse-only listing for the directory picker. Metadata only: no contents, no symlink subtree expansion.
 * The server never accepts `~` or relative paths; clients expand `~` with the response `home` field. */
export const fileEntrySchema = z.object({ name: z.string(), path: z.string(), kind: z.enum(['directory', 'file', 'symlink', 'other']), size: z.number() }).strict();
export const browseDirectoryInputSchema = z.object({ path: z.string().max(4096) }).strict();
export const browseDirectorySchema = z.object({ home: z.string().min(1), path: z.string().min(1).max(4096), entries: z.array(fileEntrySchema), truncated: z.boolean() }).strict();
export type BrowseDirectory = z.infer<typeof browseDirectorySchema>;
export type WorkspaceWriterState = { state: 'unclaimed' } | { state: 'blocked' | 'unknown'; reason: string };
/** Run lifecycle registers its authoritative synchronous inspection before it can start writers.
 * Unknown/throwing/disposed authorities deny. No TTL proves that a writer stopped. */
export interface WorkspaceWriterParticipant { inspect(workspace: Workspace): WorkspaceWriterState }
export interface WorkspaceFileService {
  list(workspaceId: string, path: string): Promise<FileListing>;
  search(workspaceId: string, query: string): Promise<FileSearch>;
  preview(workspaceId: string, path: string, startLine?: number, lines?: number): Promise<FilePreview>;
  download(workspaceId: string, path: string): Promise<Uint8Array>;
  upload(workspaceId: string, path: string, bytes: Uint8Array): Promise<FileWriteResult>;
  writeText(workspaceId: string, path: string, text: string, expectedRevision?: string): Promise<FileWriteResult>;
}

declare const claimPermitBrand:unique symbol;
/** Opaque, non-serializable admission proof; Workspace rechecks its persistent Claim in the shared TX. */
export interface WorkspaceClaimPermit {readonly [claimPermitBrand]:true}

export const WORKSPACE_RUN_FILES='aork.workspace.run-files@1';
declare const runAuthority:unique symbol;
export interface WorkspaceRunAuthority {readonly [runAuthority]:true}
export interface WorkspaceRunFileFacade {
 preview(path:string,startLine?:number,lines?:number):Promise<FilePreview>;
 writeText(path:string,text:string,expectedRevision?:string):Promise<{path:string;size:number;revision:string}>;
}
export interface WorkspaceRunFiles {
 bindRunAuthority(tx:SyncTransaction,permit:WorkspaceClaimPermit,claimOwner:OwnerDescriptor,run:{runId:string;generation:number;hostEpoch:string},workspaceId:string):WorkspaceRunAuthority;
 close(authority:WorkspaceRunAuthority):void;
 files(authority:WorkspaceRunAuthority,signal:AbortSignal):WorkspaceRunFileFacade;
}
/** Optional presentation hint; file access and selection remain owner/public URL state. */
export interface FilesViewContext {panel:true;wide:boolean}

