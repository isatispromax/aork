import { z } from 'zod';
/** Workbench projection watermarks are reply IDs, never global browser event cursors. */
export const replySummarySchema = z.object({ activityId: z.uuid(), sessionId: z.uuid(), turnId: z.uuid(), projectId: z.uuid(), workspaceId: z.uuid(), sessionName: z.string().max(120) }).strict();
export const unreadPageSchema = z.object({ count: z.number().int().nonnegative(), items: z.array(replySummarySchema), next: z.string().optional() }).strict();
export type UnreadPage = z.infer<typeof unreadPageSchema>;
export const markReadSchema = z.object({ sessionId: z.uuid(), activityIds: z.array(z.uuid()).min(1).max(100) }).strict();
export const preferencesSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), sidebarOpen: z.boolean(), filesOpen: z.boolean(), filesWide: z.boolean() }).strict();
export type WorkbenchPreferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: WorkbenchPreferences = { theme: 'system', sidebarOpen: true, filesOpen: true, filesWide: false };
export const pageParametersSchema = z.object({ after: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).default('0') }).strict();
/** Public wrapper contract: acknowledge only this rendered reply's complete content while visible. */
export interface ReadTrackerContext {
    sessionId: string;
    activityId: string;
    content: import('react').ReactNode;
}
/** Layout child context is presentation only. Services still validate every command. */
export interface WorkbenchLayoutContext {
    preferences: WorkbenchPreferences;
    save(update: Partial<WorkbenchPreferences>): void;
    narrow: boolean;
}
