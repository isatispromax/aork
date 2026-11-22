import { z } from 'zod';
/** Workbench projection watermarks are reply IDs, never global browser event cursors. */
export const replySummarySchema = z.object({ activityId: z.uuid(), sessionId: z.uuid(), turnId: z.uuid(), workspaceId: z.uuid(), sessionName: z.string().max(120) }).strict();
export const unreadPageSchema = z.object({ count: z.number().int().nonnegative(), items: z.array(replySummarySchema), next: z.string().optional() }).strict();
export type UnreadPage = z.infer<typeof unreadPageSchema>;
export const markReadSchema = z.object({ sessionId: z.uuid(), activityIds: z.array(z.uuid()).min(1).max(100) }).strict();
/** The three workbench regions are independently replaceable; each region also exposes
 * multi-plugin extension targets. Region containers and sections use only public
 * queries/commands; the right region is not owned by Files. */
export const WORKBENCH_SIDEBAR = 'aork.workbench.sidebar@1';
export const WORKBENCH_MAIN = 'aork.workbench.main@1';
export const WORKBENCH_INSPECTOR = 'aork.workbench.inspector@1';
export const WORKBENCH_RAIL_SECTIONS = 'aork.workbench.rail-sections@1';
export const WORKBENCH_INSPECTOR_SECTIONS = 'aork.workbench.inspector-sections@1';
export const WORKBENCH_CONVERSATION_BAND = 'aork.workbench.conversation@1';
export const preferencesSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), sidebarOpen: z.boolean(), inspectorOpen: z.boolean(), inspectorWide: z.boolean() }).strict();
export type WorkbenchPreferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: WorkbenchPreferences = { theme: 'system', sidebarOpen: true, inspectorOpen: true, inspectorWide: false };
/** Legacy records named the right region after Files. Reading them is presentation
 * recovery, not business state: unknown or malformed fields fall back to defaults. */
export function readPreferences(value: unknown): WorkbenchPreferences {
  if (!value || typeof value !== 'object') return defaultPreferences;
  const record = value as Record<string, unknown>;
  const pick = (name: keyof WorkbenchPreferences, legacy?: string) => record[name] !== undefined ? record[name] : legacy ? record[legacy] : undefined;
  const candidate = {
    theme: pick('theme'),
    sidebarOpen: pick('sidebarOpen'),
    inspectorOpen: pick('inspectorOpen', 'filesOpen'),
    inspectorWide: pick('inspectorWide', 'filesWide'),
  };
  const parsed = preferencesSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const merged = { ...defaultPreferences, ...Object.fromEntries(Object.entries(candidate).filter(([, field]) => typeof field === 'boolean' || field === 'light' || field === 'dark' || field === 'system')) };
  const recovered = preferencesSchema.safeParse(merged);
  return recovered.success ? recovered.data : defaultPreferences;
}
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
    /** True while the right region is presented as a compact overlay drawer rather
     * than a docked column. Region providers use it to hide desktop-only controls. */
    inspectorOverlay?: boolean;
}
