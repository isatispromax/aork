import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import { SESSION_CREATE } from '@aork/contracts/session';
import { FileView } from './file-view.js';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import { WorkspaceBrowser } from './workspace-browser.js';
import { DirectoryPickerView } from './directory-picker-view.js';
import styles from './workspace.module.css';

/** The centre with nothing else selected: the Session detail while one is selected, and otherwise the
 * new-Session surface — dsh's hero, where the Workspace picker lives. There is no Workspace page:
 * Workspaces are managed in the left browser alone. */
function Page({ runtime }: ViewProps) {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const change = () => setHash(location.hash); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  const chosen = readWorkbenchSelection(hash);
  // A Workbench page of its own — pending requests, unread replies — is not the home and is left alone.
  const paged = new URLSearchParams(hash.replace(/^#/, '')).has('page');
  // The address says which surface is shown, so that cancelling, reloading and linking mean the same thing.
  useEffect(() => { if (!paged && !chosen.sessionId && !chosen.creatingSession) location.hash = withWorkbenchSelection(location.hash, { creatingSession: true }); }, [paged, chosen.sessionId, chosen.creatingSession]);
  // A replacement creation provider may open a dialog over the current page instead.
  const inline = chosen.creatingSession && runtime.bootstrap.ui.providers[SESSION_CREATE] === 'sessions:create';
  return <>
    {chosen.sessionId && <div className={styles.sessionHost} hidden={inline}>{runtime.renderView('aork.sessions.detail@1', { embedded: true })}</div>}
    {runtime.renderView(SESSION_CREATE, inline ? { inline: true } : undefined)}
  </>;
}
function FilesSection({ runtime, context }: ViewProps) {
  // Contributed into the public right region; the region shell owns width/close controls.
  const wide = Boolean(context && typeof context === 'object' && 'preferences' in context && (context as { preferences?: { inspectorWide?: boolean } }).preferences?.inspectorWide);
  // The region's tab travels with the hint, so the view can ask it to open a file elsewhere.
  const tab = (context as InspectorTabContext | undefined)?.tab;
  return <section className={styles.filesSection} aria-label="文件分区">{runtime.renderView('aork.workspace.files@1', { panel: true, wide, ...(tab ? { tab } : {}) })}</section>;
}
export function activate(context: ClientPluginContext) {
  context.registerView('navigation', WorkspaceBrowser);
  context.registerView('page', Page);
  context.registerView('files', FileView);
  context.registerView('directory-picker', DirectoryPickerView);
  context.registerExtension('files-section', FilesSection);
}
