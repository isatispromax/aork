import { z } from 'zod';
import type { SyncTransaction } from '@aork/sdk/server';
import { profileSnapshotSchema } from './agent.js';
import { workspaceSchema } from './workspace.js';

export const SESSIONS_SERVICE = 'aork.sessions@1';
export const SESSION_NAVIGATION = 'aork.sessions.navigation@1';
export const SESSION_CREATE = 'aork.sessions.create@1';
export const SESSION_DETAIL = 'aork.sessions.detail@1';
const id = z.uuid();
export const createSessionSchema = z.object({ name: z.string().trim().min(1).max(120), projectId: id, workspaceId: id, profileId: id }).strict();
/** Saved configuration selection is an immutable value, separate from a later Run's launch snapshot. */
export const sessionSchema = createSessionSchema.extend({
  id, status: z.enum(['open', 'archived']), createdAt: z.iso.datetime(),
  workspace: workspaceSchema, profile: profileSnapshotSchema.omit({ stateDirectory: true }), providerLabel: z.string().min(1).max(120),
}).strict();
export const sessionEntrySchema = z.object({
  session: sessionSchema, execution: z.object({ state: z.literal('not-started') }).strict(),
  nativeHistory: z.object({ restorable: z.literal(false), reason: z.literal('never-started') }).strict(),
}).strict();
export const sessionsOverviewSchema = z.object({ sessions: z.array(sessionEntrySchema) }).strict();
export const archiveSessionSchema = z.object({ id }).strict();
export type Session = z.infer<typeof sessionSchema>;
export type SessionsOverview = z.infer<typeof sessionsOverviewSchema>;
/** Trusted server service. Browser reads always apply authenticated principal scope. */
export interface SessionsService {
  getSession(id: string, transaction?: SyncTransaction): Session | undefined;
  requireOpenSession(id: string, transaction: SyncTransaction): Session;
  /** A lifecycle owner must reject archive while its Run cannot be safely archived.
   * Archival never calls stop, changes Run state, or releases a Workspace Claim. */
  registerArchiveParticipant(participant: { assertCanArchive(session: Session, transaction: SyncTransaction): void }): () => void;
}
