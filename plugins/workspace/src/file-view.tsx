import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ViewProps } from '@aork/sdk/client';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import { parentOf } from './file-tree.js';
import { treeState } from './file-store.js';
import type { TreeState } from './file-store.js';
import { FileEditor } from './file-editor.js';
import { FileNavigator } from './file-navigator.js';
import styles from './files.module.css';

/** The Workspace, directory, file and line the address names. */
interface Selection { id: string; directory: string; file: string; line: string }
function route(): Selection {
  const hash = new URLSearchParams(location.hash.slice(1));
  return { id: hash.get('workspace') ?? '', directory: hash.get('directory') ?? '', file: hash.get('file') ?? '', line: hash.get('line') ?? '1' };
}
function navigate(directory: string, file = '', line = '1') {
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const [key, value] of Object.entries({ directory, file, line: line === '1' ? '' : line })) {
    if (value) hash.set(key, value);
    else hash.delete(key);
  }
  location.hash = hash.toString();
}

/** The tree a tab keeps, redrawn after each change. The state itself lives outside React. */
function useTreeState(tabId: string, workspaceId: string, signal: AbortSignal | undefined) {
  const [, redraw] = useReducer((count: number): number => count + 1, 0);
  const state = useMemo(() => treeState(tabId, workspaceId, signal), [tabId, workspaceId, signal]);
  const update = useCallback((mutate: (next: TreeState) => void): void => { mutate(state); redraw(); }, [state]);
  return { state, update };
}

export function FileView(props: ViewProps) {
  const [selected, setSelected] = useState(route);
  useEffect(() => {
    const change = () => setSelected(route());
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);
  return selected.id ? <WorkspaceFiles key={selected.id} {...props} selected={selected} /> : null;
}

/** The region's tab, where the view is shown as a panel that hands one over: through it the view asks
 * the region to open a file with whatever panel type declares an `opensWith` trigger, naming no plugin. */
function handedTab(context: unknown): InspectorTabContext['tab'] | undefined {
  if (!(context instanceof Object) || !('tab' in context)) return undefined;
  const tab: unknown = context.tab;
  return tab instanceof Object ? tab as InspectorTabContext['tab'] : undefined;
}

/** The Files view: a Workspace's tree, and beside or under it the editor. The tree is in the shape of
 * deepseek-harness's files page; a file is read in the Preview panel wherever one is installed, as
 * there, and in the editor pane where none is. The Host's part is the public file resources only. */
function WorkspaceFiles({ runtime, context, selected }: ViewProps & { selected: Selection }) {
  const wide = Boolean(context && typeof context === 'object' && 'wide' in context && context.wide === true);
  // Shown as a panel the view is sized by its region; on its own it is as tall as what it shows.
  const panel = Boolean(context && typeof context === 'object' && 'panel' in context && context.panel === true);
  const tab = handedTab(context);
  // A file is opened with whatever panel type declares that it opens files, and only where this view
  // sits in a tab that can ask for it; elsewhere it is read in the editor pane.
  const elsewhere = useMemo(() => tab !== undefined && runtime.listExtensions('aork.workbench.inspector-tabs@1').some(extension => extension.opensWith === 'preview'), [runtime, tab]);
  const { state, update } = useTreeState(tab?.id ?? '', selected.id, tab?.signal);
  const [overview, setOverview] = useState<WorkspaceOverview>();
  const [accessError, setAccessError] = useState('');
  useEffect(() => {
    const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', {
      next(value) { setOverview(value); setAccessError(''); },
      error(failure) { setAccessError(failure.message); },
    });
    return () => { void unsubscribe(); };
  }, [runtime]);
  const workspace = overview?.workspaces.find(item => item.id === selected.id);
  const writable = workspace !== undefined;
  const shown = state.editorPath;
  const line = shown !== undefined && selected.file === shown ? Math.max(1, Number.parseInt(selected.line, 10) || 1) : 1;

  /** Names the file in the address: its directory, the file, and the reader's line where it is the same file. */
  function address(path: string): void { navigate(parentOf(path), path, path === selected.file ? selected.line : '1'); }
  function open(path: string): void {
    address(path);
    if (elsewhere) tab?.open('preview', path);
    else update(next => { next.editorPath = path; next.editing = false; next.editOnLoad = false; next.editorFront = true; });
  }
  function edit(path: string): void {
    address(path);
    // An edit already under way in this file is not begun again: what was typed is kept.
    if (state.editorPath === path && (state.editing || state.editOnLoad)) { update(next => { next.editorFront = true; }); return; }
    update(next => { next.editorPath = path; next.editing = false; next.editOnLoad = true; next.editorFront = true; });
  }

  return <section className={panel ? `${styles.root} ${styles.panel}` : styles.root} data-dock-fill data-wide={wide} data-editor={shown !== undefined} data-front={state.editorFront ? 'editor' : 'tree'} aria-label="工作区文件">
    <div className={styles.columns}>
      <FileNavigator runtime={runtime} workspaceId={selected.id} root={workspace?.directory ?? ''} writable={writable} accessError={accessError}
        state={state} update={update} linked={{ file: selected.file, directory: selected.directory }} onOpen={open} onEdit={edit} />
      {shown !== undefined && <FileEditor runtime={runtime} workspaceId={selected.id} path={shown} line={line} state={state} update={update} writable={writable}
        onLine={value => navigate(selected.directory, shown, String(value))}
        onSaved={path => update(next => { next.saved = { path }; })}
        onBack={() => update(next => { next.editorFront = false; next.focusRequest++; })} />}
    </div>
  </section>;
}
