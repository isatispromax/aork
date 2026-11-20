import { z } from 'zod';
import {toolRefSchema} from './tools.js';
import type { FactSource, SyncTransaction } from '@aork/sdk/server';
import { publicRunSchema } from './runtime.js';

import { profileSnapshotSchema } from './agent.js';
import { workspaceDirectoryStatusSchema, workspaceSchema } from './workspace.js';

export const SESSIONS_SERVICE = 'aork.sessions@1';
export const SESSION_NAVIGATION = 'aork.sessions.navigation@1';
export const SESSION_CREATE = 'aork.sessions.create@1';
export const SESSION_DETAIL = 'aork.sessions.detail@1';
export const SESSION_COMPOSER = 'aork.sessions.composer@1';
export const SESSION_MESSAGES = 'aork.sessions.messages@1';
export const SESSION_TOOLS = 'aork.sessions.tools@1';
export * from './turn.js';
import { turnSchema } from './turn.js';
const id = z.uuid();
export const createSessionSchema = z.object({ name: z.string().trim().min(1).max(120), projectId: id, workspaceId: id, profileId: id, tools:z.array(toolRefSchema).max(8).default([]) }).strict();
/** Saved configuration selection is an immutable value, separate from a later Run's launch snapshot. */
export const sessionSchema = createSessionSchema.omit({tools:true}).extend({
  id, status: z.enum(['open', 'archived']), createdAt: z.iso.datetime(),
  workspace: workspaceSchema, profile: profileSnapshotSchema.omit({ stateDirectory: true }), providerLabel: z.string().min(1).max(120),
}).strict();
export const sessionEntrySchema = z.object({
  session: sessionSchema, execution: z.union([z.object({ state: z.literal('not-started') }).strict(),publicRunSchema]),
  environment: z.object({ status: z.enum(['open', 'archived-or-unavailable']), directory: workspaceDirectoryStatusSchema }).strict(),
  nativeHistory: z.object({ restorable: z.literal(false), reason: z.enum(['never-started','native-recovery-not-implemented','check-required','load-unsupported','runtime-unavailable','execution-active']) }).strict(),
  currentTurn:turnSchema.optional(), dispatchPaused:z.boolean(),
}).strict();
export const sessionEnvironmentsSchema=z.object({environments:z.array(z.object({sessionId:z.uuid(),environment:sessionEntrySchema.shape.environment}).strict())}).strict();
export const sessionsProjectionSchema = z.object({ sessions: z.array(sessionEntrySchema.omit({ environment: true })) }).strict();
export type SessionsProjection = z.infer<typeof sessionsProjectionSchema>;
export const sessionsOverviewSchema = z.object({ sessions: z.array(sessionEntrySchema) }).strict();
export const archiveSessionSchema = z.object({ id }).strict();
export type Session = z.infer<typeof sessionSchema>;
export type SessionsOverview = z.infer<typeof sessionsOverviewSchema>;
/** Trusted server service. Browser reads always apply authenticated principal scope. */
export const completedReplyFactSchema = z.object({ principal:z.string(), activityId:z.uuid(), sessionId:z.uuid(), turnId:z.uuid(), projectId:z.uuid(), workspaceId:z.uuid(), sessionName:z.string().max(120), source:z.literal('live-completion') }).strict();
export type CompletedReplyFact = z.infer<typeof completedReplyFactSchema>;
export interface SessionsService {
  /** Only live completion creates this fact. Native history replay must never append it. */
  readonly replyFacts: FactSource<CompletedReplyFact>;
  /** Validates explicit user association, including archived history; never claims authorship. */
  requireSource(principal:string, source:{sessionId:string;turnId:string}, transaction?:SyncTransaction):{sessionId:string;turnId:string;projectId:string;workspaceId:string};
  getSession(id: string, transaction?: SyncTransaction): Session | undefined;
  requireOpenSession(id: string, transaction: SyncTransaction): Session;
  /** A lifecycle owner must reject archive while its Run cannot be safely archived.
   * Archival never calls stop, changes Run state, or releases a Workspace Claim. */
  registerArchiveParticipant(participant: { id: string; assertCanArchive(session: Session, transaction: SyncTransaction): void }): () => void;
}

/** Navigation labels may be compact; immutable full names remain in sessions.detail. */
export const sessionReferencesSchema=z.object({sessions:z.array(z.object({id:z.uuid(),name:z.string().max(120),nameTruncated:z.literal(true).optional(),projectId:z.uuid(),workspaceId:z.uuid()}).strict())}).strict();
