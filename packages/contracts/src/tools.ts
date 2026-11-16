import { z } from 'zod';
import type { RuntimeSchema, SyncTransaction } from '@aork/sdk/server';
import type { WorkspaceRunAuthority, WorkspaceRunFileFacade } from './workspace.js';
export const TOOLS_SERVICE = 'aork.tools@1';
export const TOOL_SELECTION = 'aork.tools.selection@1';
export const TOOL_LIMITS = { registrations: 256, perOwner: 64, selection: 8, schemaBytes: 16384, frameBytes: 1048576, argumentBytes: 327680, resultBytes: 524288, inFlight: 4, totalInFlight: 64 } as const;
export const toolRefSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9.-]*\.[a-z][a-z0-9_]*$/).max(160), definitionVersion: z.string().min(1).max(64) }).strict();
export type ToolRef = z.infer<typeof toolRefSchema>;
export const runRefSchema = z.object({ runId: z.uuid(), generation: z.number().int().positive(), hostEpoch: z.uuid() }).strict();
export type ToolRunRef = z.infer<typeof runRefSchema>;
export const toolDescriptorSchema = toolRefSchema.extend({ registrationId: z.uuid(), ownerPluginId: z.string().max(100), ownerPluginVersion: z.string().max(64), schemaDigest: z.string().length(64), wireName: z.string().max(64), title: z.string().min(1).max(100), description: z.string().max(512), inputSchema: z.record(z.string(), z.json()), access: z.enum(['read', 'write']) }).strict();
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
export const toolCatalogEntrySchema = toolDescriptorSchema.omit({ inputSchema: true });
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>;
export const selectionSchema = z.object({ sessionId: z.uuid(), revision: z.number().int().positive(), tools: z.array(toolRefSchema).max(TOOL_LIMITS.selection) }).strict();
export const runToolSnapshotSchema = z.object({ grantId: z.uuid(), run: runRefSchema, sessionId: z.uuid(), workspaceId: z.uuid(), selectionRevision: z.number().int().positive(), tools: z.array(toolDescriptorSchema).max(TOOL_LIMITS.selection) }).strict();
export type RunToolSnapshot = z.infer<typeof runToolSnapshotSchema>;
/** Compact immutable refs in the global Session projection; full descriptors live in tools.session. */
export const runToolSummarySchema = z.object({ grantId: z.uuid(), selectionRevision: z.number().int().positive(), tools: z.array(toolRefSchema).max(TOOL_LIMITS.selection) }).strict();
export const toolResultSchema = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string().max(524288) }).strict()).max(16), structuredContent: z.record(z.string(), z.json()).optional(), isError: z.boolean().optional() }).strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
export const toolCallSchema = z.object({ id: z.uuid(), run: runRefSchema, sessionId: z.uuid(), tool: toolRefSchema, turnId: z.uuid().optional(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']), cancellationRequested: z.boolean(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), result: toolResultSchema.optional(), errorCode: z.string().max(100).optional() }).strict();
export type ToolCallRecord = z.infer<typeof toolCallSchema>;
/** List projection: result bodies are fetched one call at a time through tools.call. */
export const toolCallSummarySchema=toolCallSchema.omit({result:true}).extend({resultOmitted:z.boolean()});
export type ToolCallSummary=z.infer<typeof toolCallSummarySchema>;
export interface ToolDefinition<T = unknown> extends ToolRef {
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** Synchronous only; returning a Promise/thenable fails before handler admission. */
    arguments: RuntimeSchema<T>;
    access: 'read' | 'write';
}
export interface ToolContext {
    readonly signal: AbortSignal;
    readonly run: ToolRunRef;
    readonly turnId?: string;
    readonly files: WorkspaceRunFileFacade;
}
export interface ToolRuntimeHooks {
    registerJob(cancel: () => Promise<void>): () => void;
    currentScope(): {
        ready: boolean;
        turnId?: string;
    };
    onFailure(): void;
}
export interface RunToolHandle {
    readonly descriptor?: {
        command: string;
        args: string[];
        env: {
            name: string;
            value: string;
        }[];
    };
    revoke(): void;
    drain(): Promise<void>;
    cancelTurn(turnId: string): void;
}
export interface ToolsService {
    registerTool<T>(definition: ToolDefinition<T>, handler: (arguments_: T, context: ToolContext) => ToolResult | Promise<ToolResult>): () => void;
    createSelection(tx: SyncTransaction, input: {
        sessionId: string;
        principal: string;
        workspaceId: string;
    }, refs: readonly ToolRef[]): void;
    archiveSelection(tx: SyncTransaction, sessionId: string): void;
    captureRun(tx: SyncTransaction, input: {
        sessionId: string;
        run: ToolRunRef;
    }): RunToolSnapshot;
    assertCaptured(tx: SyncTransaction, snapshot: RunToolSnapshot): void;
    openRun(snapshot: RunToolSnapshot, hooks: ToolRuntimeHooks, authority: WorkspaceRunAuthority): Promise<RunToolHandle>;
    revokeInTransaction(tx: SyncTransaction, run: ToolRunRef, reason: string): void;
}
