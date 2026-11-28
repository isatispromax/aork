import type { FileEntry } from '@aork/contracts/workspace';
import type { Level } from './file-tree.js';

export type SearchStatus = 'idle' | 'running' | 'done' | 'failed';
export interface SearchState { status: SearchStatus; entries?: FileEntry[]; truncated?: boolean; error?: string }

/** What one tab's file tree holds between draws: the levels it read, which directories are open,
 * the search in force, and the editor's file with its unsaved draft. It lives outside React, as
 * deepseek-harness's does: the dock mounts only the active tab's body, so a tree kept in component
 * state would be listed anew on every switch back. */
export interface TreeState {
  readonly workspaceId: string;
  readonly levels: Map<string, Level>;
  readonly expanded: Set<string>;
  /** Whether dot entries are drawn: a preference of the Workspace, kept across loads. */
  showHidden: boolean;
  /** The search box's text. Text other than whitespace is a search in force. */
  query: string;
  search: SearchState;
  /** Counts the searches started, so the answer to an earlier text is dropped. */
  searchSequence: number;
  /** The file the tab last opened or was linked to. Its row is the current one. */
  current: string | undefined;
  /** The last path whose row the tree made visible. A path is located once, until it is linked again. */
  located: string | undefined;
  editorPath: string | undefined;
  editing: boolean;
  draft: string;
  /** Set by 编辑 on a row: the editor begins its edit as soon as it has read the file. */
  editOnLoad: boolean;
  /** Counted up to have the editor read its file again. */
  editorRefresh: number;
  /** The last file the editor saved, each save a new record: what lists it is out of date. */
  saved: { path: string } | undefined;
  /** Which of the tree and the editor is in front where the panel is too narrow for both. */
  editorFront: boolean;
  scrollTop: number;
  /** Counted up to have the tree take keyboard focus back on the editor's file. */
  focusRequest: number;
}

const trees = new Map<string, TreeState>();

/** The tree a tab holds for a Workspace, made on first use. A tab that closes forgets its trees. */
export function treeState(tabId: string, workspaceId: string, signal?: AbortSignal): TreeState {
  const key = `${tabId}|${workspaceId}`;
  let state = trees.get(key);
  if (!state) {
    state = {
      workspaceId, levels: new Map(), expanded: new Set(), showHidden: showHiddenOf(workspaceId),
      query: '', search: { status: 'idle' }, searchSequence: 0,
      current: undefined, located: undefined, editorPath: undefined, editing: false, draft: '', editOnLoad: false, editorRefresh: 0, saved: undefined,
      editorFront: false, scrollTop: 0, focusRequest: 0,
    };
    trees.set(key, state);
    // Registered once, outside any effect: a tab can close while another body is the one mounted.
    signal?.addEventListener('abort', () => { trees.delete(key); }, { once: true });
  }
  return state;
}

const PREFERENCE = 'aork.workspace.files.v1.';

/** A reader's choice to see dot entries, kept per Workspace. Only the choice to see them is written:
 * a Workspace with no record takes the default, and so a later default unchanged. */
export function showHiddenOf(workspaceId: string): boolean {
  try { return localStorage.getItem(PREFERENCE + workspaceId) === 'hidden'; } catch { return false; }
}

export function saveShowHidden(workspaceId: string, showHidden: boolean): void {
  try {
    const key = PREFERENCE + workspaceId;
    if (showHidden) localStorage.setItem(key, 'hidden');
    else localStorage.removeItem(key);
  } catch { /* a choice that cannot be kept still holds for this draw */ }
}
