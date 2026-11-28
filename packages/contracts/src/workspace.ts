import { z } from 'zod';
import type { SyncTransaction, OwnerDescriptor } from '@aork/sdk/server';

export const WORKSPACE_SERVICE = 'aork.workspace@1';
/** The in-app directory picker, rendered by whoever adds a Workspace (the left browser and the new-Session picker). */
export const WORKSPACE_DIRECTORY_PICKER = 'aork.workspace.directory-picker@1';
/** What the directory picker view is handed: its caller's side of the picking conversation. */
export interface DirectoryPickerContext {
  /** A confirmed absolute server directory. A returned promise keeps 「选择」 pending; a rejection
   * leaves the picker open with the failure shown in place. */
  onConfirm(directory: string): void | Promise<unknown>;
  /** The picker was dismissed; nothing was chosen. */
  onCancel(): void;
}
const id = z.uuid();
const name = z.string().trim().min(1).max(120);
export const workspaceSchema = z.object({
  id, name,
  requestedDirectory: z.string(), directory: z.string(),
  scope: z.object({ root: z.string(), recursive: z.literal(true) }).strict(),
  directoryIdentity: z.object({ device: z.string(), inode: z.string() }).strict(),
  /** Registration instant, stamped at create and never rewritten. */
  createdAt: z.iso.datetime(),
  /** Presentation-only manual order; records without it keep insertion order. */
  order: z.number().int().nonnegative().optional(),
}).strict();
/** Every Workspace registers an existing server directory. One registration per canonical directory:
 * requesting one that is already registered returns that Workspace. `name` is optional — the server
 * names a new Workspace after its requested directory's last segment. */
export const workspaceInputSchema = z.object({ name: name.optional(), directory: z.string().min(1).max(4096) }).strict();
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
  /** The registration must exist. Deleting it is the only way a Workspace becomes unavailable;
   * a missing directory is reported by `inspectDirectory` and never erases the registration. */
  requireWorkspace(id: string, transaction?: SyncTransaction): Workspace;
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
export function withWorkbenchSelection(hash: string, update: Partial<{ workspaceId: string | null; sessionId: string | null; creatingSession: boolean; directory: string | null; file: string | null; line: string | null; preview: string | null }>): string {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  if(update.workspaceId!==undefined||update.sessionId!==undefined||update.creatingSession){
    for (const key of ['page', 'reply', 'interaction', 'input']) values.delete(key);
  }
  // Relative Files, preview and artifact selection belong to their Workspace. Explicit new values apply below.
  if (update.workspaceId !== undefined && update.workspaceId !== values.get('workspace')) {
    for (const key of ['directory', 'file', 'line', 'preview', 'artifact', 'artifactVersion']) values.delete(key);
  }
  const keys = { workspaceId: 'workspace', sessionId: 'session', creatingSession: 'createSession', directory: 'directory', file: 'file', line: 'line', preview: 'preview' } as const;
  for (const key of Object.keys(update) as Array<keyof typeof update>) {
    const value = update[key]; if (value === undefined) continue;
    if (value === null || value === false) values.delete(keys[key]); else values.set(keys[key], value === true ? '1' : value);
  }
  return values.toString();
}
export const createWorkspaceSchema = z.object({ workspace: workspaceInputSchema }).strict();
export const entityIdSchema = z.object({ id }).strict();
/** workspace.rename sets a name no other Workspace holds; an unchanged name writes nothing. */
export const renameWorkspaceSchema = z.object({ id, name }).strict();
/** workspace.delete removes only the registration: directory and Session history stay. */
export const deleteWorkspaceSchema = entityIdSchema;
/** One manual-order write: the complete Workspace sequence of this principal. */
export const reorderWorkspacesSchema = z.object({ orderedIds: z.array(id).max(500) }).strict();

export const WORKSPACE_FILES = 'aork.workspace.files@1';
export { FILE_LIMITS } from './fileLimits.js';
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
/** Search never enters version-control or package directories. Dot entries are matched and descended
 * only while `includeHidden` is true; a caller that omits it keeps seeing them. Listing is not affected. */
export interface FileSearchOptions { includeHidden?: boolean }
export interface WorkspaceFileService {
  list(workspaceId: string, path: string): Promise<FileListing>;
  search(workspaceId: string, query: string, options?: FileSearchOptions): Promise<FileSearch>;
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
/** Optional presentation hint; file access and selection remain owner/public URL state. `tab` is
 * present while the view shows as a right-region panel: through it the view asks the region to
 * open a file with whatever panel type declares an `opensWith` trigger, naming no plugin. */
export interface FilesViewContext {panel:true;wide:boolean;tab?:import('./workbench.js').InspectorTabContext['tab']}
