import { z } from 'zod';
import type { SyncTransaction } from '@aork/sdk/server';

export const WORKSPACE_SERVICE = 'aork.workspace@1';
export const WORKSPACE_BROWSER = 'aork.workspace.browser@1';
const id = z.uuid();
const name = z.string().trim().min(1).max(120);
export const projectSchema = z.object({ id, name, status: z.enum(['open', 'archived']) }).strict();
export const workspaceSchema = z.object({
  id, projectId: id, name, status: z.enum(['open', 'archived']), management: z.enum(['managed', 'external']),
  requestedDirectory: z.string(), directory: z.string(), access: z.enum(['read-only', 'read-write']),
  scope: z.object({ root: z.string(), recursive: z.literal(true) }).strict(),
  directoryIdentity: z.object({ device: z.string(), inode: z.string() }).strict(),
}).strict();
export const workspaceInputSchema = z.discriminatedUnion('management', [
  z.object({ name, management: z.literal('managed'), access: z.literal('read-write').default('read-write') }).strict(),
  z.object({ name, management: z.literal('external'), directory: z.string().min(1).max(4096), access: z.enum(['read-only', 'read-write']) }).strict(),
]);
export const createProjectSchema = z.object({ name, workspace: workspaceInputSchema }).strict();
export const createProjectResultSchema = z.object({ project: projectSchema, workspace: workspaceSchema }).strict();
export const workspaceOverviewSchema = z.object({ projects: z.array(projectSchema), workspaces: z.array(workspaceSchema) }).strict();
export type Project = z.infer<typeof projectSchema>;
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
  registerWriterParticipant(participant: WorkspaceWriterParticipant): () => void;
}
/** Shared URL identity contract. Unrelated plugin keys survive entity selection updates. */
export function readWorkbenchSelection(hash: string) {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  return { projectId: values.get('project'), workspaceId: values.get('workspace'), sessionId: values.get('session'), creatingSession: values.get('createSession') === '1' };
}
export function withWorkbenchSelection(hash: string, update: Partial<{ projectId: string | null; workspaceId: string | null; sessionId: string | null; creatingSession: boolean; directory: string | null; file: string | null; line: string | null }>): string {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  // Relative Files selection belongs to its Workspace. Explicit new Files values apply below.
  if (update.workspaceId !== undefined && update.workspaceId !== values.get('workspace')) {
    for (const key of ['directory', 'file', 'line']) values.delete(key);
  }
  const keys = { projectId: 'project', workspaceId: 'workspace', sessionId: 'session', creatingSession: 'createSession', directory: 'directory', file: 'file', line: 'line' } as const;
  for (const key of Object.keys(update) as Array<keyof typeof update>) {
    const value = update[key]; if (value === undefined) continue;
    if (value === null || value === false) values.delete(keys[key]); else values.set(keys[key], value === true ? '1' : value);
  }
  return values.toString();
}
export const createWorkspaceSchema = z.object({ projectId: id, workspace: workspaceInputSchema }).strict();
export const editProjectSchema = z.object({ id, name }).strict();
export const entityIdSchema = z.object({ id }).strict();
export const editWorkspaceSchema = z.object({ id, name, access: z.enum(['read-only', 'read-write']) }).strict();

export const WORKSPACE_FILES = 'aork.workspace.files@1';
export const FILE_LIMITS = { transferBytes: 8 * 1024 * 1024, textBytes: 256 * 1024, entries: 500, searchEntries: 5000, searchResults: 200 } as const;
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface FileSearch { entries: FileEntry[]; truncated: boolean; visited: number }
export interface FilePreview { path: string; text: string; startLine: number; totalLines: number; truncated: boolean; revision: string; editable: boolean }
export interface FileWriteResult { path: string; size: number; revision: string }
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
