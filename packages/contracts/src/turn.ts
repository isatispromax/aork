import { z } from 'zod';
export const turnStateSchema = z.enum(['accepted', 'dispatching', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'delivery_unknown', 'interrupted']);
export const turnSchema = z.object({ id: z.uuid(), sessionId: z.uuid(), runId: z.uuid(), generation: z.number().int().positive(), state: turnStateSchema, createdAt: z.iso.datetime(), stopReason: z.string().max(100).optional(), reason: z.string().max(500).optional(), usage: z.object({ used: z.number().nonnegative(), size: z.number().nonnegative(), cost: z.object({ amount: z.number().nonnegative(), currency: z.string().max(30) }).optional() }).optional() }).strict();
export type Turn = z.infer<typeof turnSchema>;
/** Whitespace is user content; trim is used only to reject an empty input. */
export const sendTextSchema = z.object({ sessionId: z.uuid(), text: z.string().max(16000).refine(value => value.trim().length > 0, 'Enter text').refine(value => new TextEncoder().encode(value).length <= 16000, 'Input exceeds 16000 UTF-8 bytes').refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 24000, 'Escaped input exceeds the durable message limit') }).strict();
export const cancelTurnSchema = z.object({ turnId: z.uuid() }).strict();
export const timelineMessageSchema = z.object({ id: z.string().max(200), turnId: z.uuid(), role: z.enum(['user', 'agent']), sequence: z.number().int().nonnegative(), text: z.string().max(16000), messageId: z.string().max(200).optional() }).strict();
export const toolDisplaySchema = z.object({ turnId: z.uuid(), toolCallId: z.string().max(200), title: z.string().max(500), status: z.enum(['pending', 'in_progress', 'completed', 'failed']), kind: z.string().max(50).optional(), text: z.string().max(4000).optional() }).strict();
export const sessionTimelineSchema = z.object({ sessionId: z.uuid(), dispatchPaused: z.boolean(), turns: z.array(turnSchema), messages: z.array(timelineMessageSchema), tools: z.array(toolDisplaySchema), truncated: z.boolean() }).strict();
export type SessionTimeline = z.infer<typeof sessionTimelineSchema>;
