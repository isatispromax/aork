/** What each open preview tab last read and how it was being shown, kept while its tab is open.
 * A panel body unmounts whenever its tab is not the one showing, when the region collapses or
 * when the Session changes; what it read outlives all of that, so coming back to the tab shows
 * the file at once instead of reading it again — until 重新读取 asks for it, or the tab closes. */

import type { PreviewText } from './text.js';

export interface PreviewReading {
  readonly workspaceId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  /** The bytes as text, where the file has a way of showing that reads them as text. */
  readonly text: PreviewText | undefined;
}

/** Which of a file's ways of showing is selected, and whether source wraps. */
export interface PreviewView {
  readonly form: number;
  readonly wrap: boolean;
}

const readings = new Map<string, PreviewReading>();
const views = new Map<string, PreviewView>();

/** The last reading of a tab, when it has one. */
export function readingOf(tabId: string): PreviewReading | undefined { return readings.get(tabId); }
/** Keeps a tab's reading, replacing what it read before. */
export function rememberReading(tabId: string, reading: PreviewReading): void { readings.set(tabId, reading); }
/** How a tab was showing its file, when it chose. */
export function viewOf(tabId: string): PreviewView | undefined { return views.get(tabId); }
/** Keeps how a tab is showing its file. */
export function rememberView(tabId: string, view: PreviewView): void { views.set(tabId, view); }
/** Drops everything kept for a tab that closed. */
export function forgetPreview(tabId: string): void {
  readings.delete(tabId);
  views.delete(tabId);
}
