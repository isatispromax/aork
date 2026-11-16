import { z } from 'zod';
import { negotiatedInputSchema,attachmentSnapshotSchema,attachmentReferenceSchema,INPUT_LIMITS } from './input.js';
export const turnStateSchema = z.enum(['accepted', 'queued', 'removed', 'dispatching', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'delivery_unknown', 'interrupted']);
export const turnSchema = z.object({ id: z.uuid(), sessionId: z.uuid(), runId: z.uuid(), generation: z.number().int().positive(), state: turnStateSchema, configuration:negotiatedInputSchema.optional(),configurationRun:z.object({runId:z.uuid(),generation:z.number().int().positive()}).strict().optional(),attachments:z.array(attachmentSnapshotSchema).max(INPUT_LIMITS.attachments).optional(), hasAgentProgress:z.boolean().optional(), acceptanceOrder: z.number().int().positive(), createdAt: z.iso.datetime(), stopReason: z.string().max(100).optional(), reason: z.string().max(500).optional(), usage: z.object({ used: z.number().nonnegative(), size: z.number().nonnegative(), cost: z.object({ amount: z.number().nonnegative(), currency: z.string().max(30) }).optional() }).optional() }).strict();
export type Turn = z.infer<typeof turnSchema>;
/** Whitespace is user content; trim is used only to reject an empty input. */
export const sendTextSchema = z.object({ sessionId: z.uuid(), text: z.string().max(16000).refine(value => value.trim().length > 0, 'Enter text').refine(value => new TextEncoder().encode(value).length <= 16000, 'Input exceeds 16000 UTF-8 bytes').refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 24000, 'Escaped input exceeds the durable message limit'),attachments:z.array(attachmentReferenceSchema).max(INPUT_LIMITS.attachments).optional() }).strict();
export const cancelTurnSchema = z.object({ turnId: z.uuid() }).strict();
export const timelineMessageSchema = z.object({ id: z.string().max(200), turnId: z.uuid(), role: z.enum(['user', 'agent']), sequence: z.number().int().nonnegative(), text: z.string().max(16000), messageId: z.string().max(200).optional() }).strict();
export const toolDisplaySchema = z.object({ turnId: z.uuid(), toolCallId: z.string().max(200), title: z.string().max(500), status: z.enum(['pending', 'in_progress', 'completed', 'failed']), kind: z.string().max(50).optional(), text: z.string().max(4000).optional() }).strict();
/** Projection-only omissions never change the immutable accepted Turn. */
export const timelineTurnSchema=turnSchema.extend({detailsOmitted:z.literal(true).optional(),configurationRevision:z.number().int().positive().optional(),attachmentCount:z.number().int().nonnegative().max(INPUT_LIMITS.attachments).optional()}).strict();
export const timelinePreviewSchema=timelineMessageSchema.extend({truncated:z.literal(true).optional()}).strict();
export const sessionTimelineSchema = z.object({ sessionId: z.uuid(), completedReplies:z.array(z.object({activityId:z.uuid(),turnId:z.uuid()}).strict()).default([]), dispatchPaused: z.boolean(), turns: z.array(timelineTurnSchema), messages: z.array(timelinePreviewSchema), tools: z.array(toolDisplaySchema), truncated: z.boolean() }).strict();
export type SessionTimeline = z.infer<typeof sessionTimelineSchema>;
export const SESSION_TURN_DETAIL='sessions.turn';
export const turnDetailSchema=z.object({sessionId:z.uuid(),turn:turnSchema,input:timelineMessageSchema.extend({role:z.literal('user')}).strict()}).strict();
export type TurnDetail=z.infer<typeof turnDetailSchema>;

export const removeQueuedTurnSchema = z.object({ turnId: z.uuid() }).strict();
export const continueQueueSchema = z.object({ sessionId: z.uuid(), runId: z.uuid(), allowNewContext: z.boolean().default(false) }).strict();
export const queueStateSchema = z.object({ sessionId: z.uuid(), dispatchPaused: z.boolean(), runId: z.uuid().optional() }).strict();

export const replyPageSchema=z.object({activityId:z.uuid(),sessionId:z.uuid(),turnId:z.uuid(),messages:z.array(timelineMessageSchema),next:z.string().optional()}).strict();
export type ReplyPage=z.infer<typeof replyPageSchema>;
