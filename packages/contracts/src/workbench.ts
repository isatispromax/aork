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
/** Public presentation-only marker for opaque/non-hit-tested owned layers.
 * Layouts set it to "covered" on the content scope while an opaque layer covers
 * that scope. They may instead use standard inert/aria-hidden/modal semantics.
 * Removing a cover is not itself a read acknowledgment: content must still be
 * visible and exposed. This marker cannot grant any server/business authority. */
export const READ_VISIBILITY_ATTRIBUTE = 'data-aork-read-visibility';
/** Public wrapper contract: render complete reply content and expose truthful
 * standard/owned-layer visibility. A committed slot does not imply it was seen.
 * The caller may update Session/activity in one mounted slot without remounting;
 * read attempts and late callbacks must remain bound to their immutable payload. */
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
