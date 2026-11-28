import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { FileEntry, FileListing, FileSearch } from '@aork/contracts/workspace';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { UiRuntime } from '@aork/sdk/client';
import { DockGlyph } from '@aork/dock';
import { ancestorsOf, baseName, parentOf, searchItems, treeItems } from './file-tree.js';
import type { Level } from './file-tree.js';
import { saveShowHidden } from './file-store.js';
import type { TreeState } from './file-store.js';
import { failureText, fileJson } from './file-resource.js';
import { FileTree } from './tree-view.js';
import type { MenuTarget } from './tree-view.js';
import { FileMenu } from './file-menu.js';
import type { MenuAnchor, MenuItem } from './file-menu.js';
import styles from './files.module.css';

/** How long after a keystroke the search is sent. The Host walks the directories itself rather than
 * running ripgrep, so a word typed is searched once, at its end. */
const SEARCH_DELAY = 150;

export interface FileNavigatorProps {
  runtime: UiRuntime;
  workspaceId: string;
  /** The Workspace's directory on the server: what the header names and 复制路径 copies. */
  root: string;
  writable: boolean;
  /** Why the Workspace's list cannot be had, while it cannot. */
  accessError: string;
  state: TreeState;
  update(mutate: (state: TreeState) => void): void;
  /** Opens a file where it is read: the Preview panel, or the editor pane where none is installed. */
  onOpen(path: string): void;
  /** Shows a file in the editor pane, an edit beginning as soon as it is read. */
  onEdit(path: string): void;
  /** The file and the directory the address names, located once the tree is drawn. */
  linked: { file: string; directory: string };
}

const join = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

/* Glyphs: the docking kit's stroke, so the header reads as the strip above it. */
function ReloadGlyph(): ReactNode {
  return <DockGlyph><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.8 2.4v2.4h-2.4" /></DockGlyph>;
}
/** An eye for entries shown, an eye struck through for entries hidden. */
function EyeGlyph({ hidden }: { hidden: boolean }): ReactNode {
  return <DockGlyph><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" />{hidden && <path d="M2.5 2.5l11 11" />}</DockGlyph>;
}
function ClearGlyph(): ReactNode {
  return <DockGlyph><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></DockGlyph>;
}
function MoreGlyph(): ReactNode {
  return <DockGlyph><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} /></DockGlyph>;
}

/** The tree half of the Files view, in the shape of deepseek-harness's files page as ZCode's tree
 * draws it: a standing search box, under it a header naming the Workspace root with 重新读取 and the
 * 更多操作 menu, and the tree — lazily listed, or pruned to a search's matches. The actions the rows
 * take in their menus are the header menu's too, so the header keeps two controls of its own. */
export function FileNavigator({ runtime, workspaceId, root, writable, accessError, state, update, onOpen, onEdit, linked }: FileNavigatorProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const path = useRef<HTMLSpanElement>(null);
  // The directory 上传文件到这里 chose; the header's own upload goes to the root.
  const uploadInto = useRef('');
  /** Counts the locations begun: a collapse ends the one in flight. */
  const locating = useRef(0);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; target: MenuTarget; header?: boolean }>();
  // The directory a new file is named in while it is being named; the root is the empty path.
  const [creating, setCreating] = useState<string | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [pathOverflow, setPathOverflow] = useState(false);

  const searching = state.query.trim() !== '';
  const found = state.search.entries?.length ?? 0;

  /** Reads one level unless it is read or being read. `again` reads a level that is shown once more,
   * keeping what it shows until the answer comes. Resolves with its entries, or nothing when they
   * could not be read. */
  const read = useCallback(async (directory: string, again = false): Promise<FileEntry[] | undefined> => {
    const shown = state.levels.get(directory);
    if (!again && shown?.status === 'ready') return shown.entries;
    if (!again && shown?.pending) return (await shown.pending).entries;
    const request: Promise<Level> = fileJson<FileListing>(runtime, workspaceId, 'workspace.files', { path: directory }).then(
      (listing: FileListing) => ({ status: 'ready' as const, entries: listing.entries, truncated: listing.truncated }),
      (cause: unknown) => ({ status: 'failed' as const, error: failureText(cause) }),
    );
    const kept = shown?.entries;
    update(next => {
      next.levels.set(directory, { status: kept ? 'ready' : 'loading', ...(kept ? { entries: kept, truncated: shown?.truncated } : {}), refreshing: Boolean(kept), pending: request });
    });
    const settled = await request;
    // A listing that was shown and then failed to be read again stays on, with the failure under it.
    update(next => { next.levels.set(directory, settled.status === 'failed' && kept ? { status: 'failed', error: settled.error, entries: kept, truncated: shown?.truncated } : settled); });
    return settled.entries;
  }, [runtime, workspaceId, state, update]);

  /** Makes a path's row visible: opens its directories one level at a time, each after the listing
   * above it, then scrolls to it — and takes focus there, where focus is asked. */
  const locate = useCallback(async (target: string, expand: boolean, focus: boolean): Promise<void> => {
    const serial = ++locating.current;
    for (const directory of ancestorsOf(target)) {
      if (serial !== locating.current) return;
      update(next => { next.expanded.add(directory); });
      const entries = await read(directory);
      // A path no longer listed under its parent is not looked for any further.
      if (serial !== locating.current || !entries?.some(entry => entry.path === target || target.startsWith(`${entry.path}/`))) return;
    }
    if (serial !== locating.current) return;
    update(next => { next.located = target; if (expand) next.expanded.add(target); });
    if (expand) await read(target);
    requestAnimationFrame(() => {
      if (serial !== locating.current) return;
      const row = scroll.current?.querySelector<HTMLElement>(`button[data-file-path=${CSS.escape(target)}]`);
      row?.scrollIntoView({ block: 'nearest' });
      if (focus && row) row.focus({ preventScroll: true });
    });
  }, [read, update]);

  const searchNow = useCallback(async (text: string): Promise<void> => {
    const query = text.trim();
    if (!query) { update(next => { next.search = { status: 'idle' }; }); return; }
    const serial = ++state.searchSequence;
    const hidden = state.showHidden;
    // What the last search found stays under the spinner, until this answer replaces it.
    update(next => { next.search = { ...next.search, status: 'running' }; });
    const answer = await fileJson<FileSearch>(runtime, workspaceId, 'workspace.search', { query, includeHidden: hidden ? '1' : '0' }).then(
      (result: FileSearch) => result,
      (cause: unknown) => ({ error: failureText(cause) }),
    );
    if (state.searchSequence !== serial) return;
    update(next => {
      next.search = 'entries' in answer
        ? { status: 'done', entries: answer.entries, truncated: answer.truncated }
        : { status: 'failed', error: answer.error, ...(next.search.entries ? { entries: next.search.entries } : {}) };
    });
  }, [runtime, state, update, workspaceId]);

  // The root is read when the tree first shows; a tree read before is left as it is.
  useEffect(() => { void read(''); }, [read]);
  // A word left typed while the tab was switched away is searched when the tree is drawn again. It is
  // this draw alone: a word typed afterwards waits for the search box's own delay.
  useEffect(() => { if (state.query.trim() && state.search.status === 'idle') void searchNow(state.query); }, [searchNow]);

  // The file the address names, or the one last opened, is the current one, and is made visible once.
  // An address naming only a directory opens that directory instead.
  const current = linked.file || state.current;
  useEffect(() => {
    if (current) {
      if (current !== state.current) { update(next => { next.current = current; }); return; }
      if (current !== state.located) void locate(current, false, false);
    } else if (linked.directory && linked.directory !== state.located) void locate(linked.directory, true, false);
  }, [current, state.current, state.located, linked.directory, locate, update]);

  /** A saved file leaves what lists it, and any search that matched it, out of date. */
  const saved = state.saved;
  useEffect(() => {
    if (!saved) return;
    void read(parentOf(saved.path), true);
    // The search text is read as it stands when the file is saved, not followed: a word typed
    // afterwards is searched once, at its end, by the search box's own delay.
    if (state.query.trim()) void searchNow(state.query);
  }, [saved, read, searchNow]);

  // Where the panel is too narrow for both, the tree takes the front back with focus on the editor's file.
  const focusRequest = state.focusRequest;
  useEffect(() => {
    if (!focusRequest) return;
    scroll.current?.querySelector<HTMLElement>(`button[data-file-path=${CSS.escape(state.editorPath ?? state.current ?? '')}]`)?.focus({ preventScroll: true });
  }, [focusRequest, state.editorPath, state.current]);

  // The tree is found where it was left.
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = state.scrollTop; }, [state]);
  // The path fades where it is cut, and only there.
  useLayoutEffect(() => {
    const element = path.current;
    if (!element) return undefined;
    const measure = (): void => setPathOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => () => {
    // A search still waiting for the end of a word is run, not dropped.
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    void searchNow(state.query);
  }, [searchNow, state]);

  function searchSoon(): void {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = undefined; void searchNow(state.query); }, SEARCH_DELAY);
  }
  function clearSearch(): void {
    clearTimeout(timer.current);
    timer.current = undefined;
    update(next => { next.query = ''; next.search = { status: 'idle' }; });
    search.current?.focus();
  }
  function toggle(entry: FileEntry): void {
    if (state.expanded.has(entry.path)) update(next => { next.expanded.delete(entry.path); locating.current++; });
    else { update(next => { next.expanded.add(entry.path); }); void read(entry.path); }
  }
  function open(entry: FileEntry): void {
    // The row was just acted on, so it is where it is: nothing is left to make visible.
    update(next => { next.current = entry.path; next.located = entry.path; });
    onOpen(entry.path);
  }
  /** A directory among a search's matches leaves the search and opens in the tree. */
  function enter(entry: FileEntry): void {
    update(next => { next.query = ''; next.search = { status: 'idle' }; });
    void locate(entry.path, true, false);
  }
  function reload(): void {
    setError('');
    setNotice('');
    for (const directory of ['', ...state.expanded]) void read(directory, true);
    if (state.query.trim()) void searchNow(state.query);
    if (state.editorPath !== undefined && !state.editing) update(next => { next.editorRefresh++; });
  }
  function toggleHidden(): void {
    const showHidden = !state.showHidden;
    update(next => { next.showHidden = showHidden; });
    saveShowHidden(workspaceId, showHidden);
    // Hidden entries are searched only while they are shown.
    if (state.query.trim()) void searchNow(state.query);
  }

  async function perform(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); } catch (cause) { setError(failureText(cause)); }
    finally { setBusy(false); }
  }
  function receive(file: File | undefined): void {
    if (!file) return;
    const directory = uploadInto.current;
    uploadInto.current = '';
    void perform(async () => {
      if (file.size > FILE_LIMITS.transferBytes) throw new Error('上传文件最多 8 MiB');
      const path = directory ? `${directory}/${file.name}` : file.name;
      await fileJson(runtime, workspaceId, 'workspace.file', { path }, new Uint8Array(await file.arrayBuffer()));
      update(next => { if (directory) next.expanded.add(directory); });
      await read(directory, true);
      if (state.query.trim()) void searchNow(state.query);
      setNotice('文件已上传');
    });
  }
  function cancelCreate(): void { setCreating(undefined); setNewName(''); }
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const directory = creating;
    const name = newName.trim();
    // A name the form's own rule refuses never gets here; any other the file service judges, and says why.
    if (directory === undefined || !name) return;
    await perform(async () => {
      const path = directory ? `${directory}/${name}` : name;
      await fileJson(runtime, workspaceId, 'workspace.file', { path }, new Uint8Array());
      update(next => { next.current = path; next.located = path; if (directory) next.expanded.add(directory); });
      await read(directory, true);
      cancelCreate();
      // An empty file is made to be written: it opens in the editor, the edit begun.
      onEdit(path);
    });
  }
  function download(path: string): void {
    void perform(async () => {
      const result = await runtime.resource('workspace.file', { workspaceId, path });
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = baseName(path);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  function copyPath(path: string): void {
    void perform(async () => {
      try { await navigator.clipboard.writeText([root.replace(/\/+$/, ''), path].filter(Boolean).join('/')); }
      catch { throw new Error('无法复制，请检查内容是否可用后重试'); }
      setNotice('已复制路径');
    });
  }

  /** Opens the menu of what a row acts on; the header's path and ··· are the root. `header` marks
   * the opener as the header's own control, which shows its pressed state while the menu is open. */
  const openMenu = useCallback((target: MenuTarget, row: HTMLElement, at?: { x: number; y: number; align?: 'end' }, header = false) => {
    const rect = row.getBoundingClientRect();
    setMenu({ target, header, anchor: { x: at?.x ?? rect.left, y: at?.y ?? rect.bottom + 4, ...(at?.align ? { align: at.align } : {}), returnTo: row } });
  }, []);
  const target = menu?.target;
  // What goes through the one operation at a time is not offered while one is under way.
  const menuItems: MenuItem[] = !target ? [] : target.kind === 'file' ? [
    { id: 'edit', label: '编辑', disabled: !writable, run: () => { onEdit(target.path); } },
    { id: 'download', label: '下载', disabled: busy, run: () => { download(target.path); } },
    { id: 'copy', label: '复制路径', disabled: busy, run: () => { copyPath(target.path); } },
  ] : [
    { id: 'new', label: '新建文件', disabled: busy || !writable, run: () => { setCreating(target.kind === 'root' ? '' : target.path); setNewName(''); } },
    { id: 'upload', label: '上传文件到这里', disabled: busy || !writable, run: () => { uploadInto.current = target.kind === 'root' ? '' : target.path; upload.current?.click(); } },
    { id: 'copy', label: '复制路径', disabled: busy, run: () => { copyPath(target.kind === 'root' ? '' : target.path); } },
  ];

  /** The menu pattern's keys along the rows: the arrows move between them, and from the first back up to the search box. */
  function along(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    // A name being typed keeps its arrows.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const rows = [...(scroll.current?.querySelectorAll<HTMLElement>('[data-file-row] > button[data-file-path]') ?? [])];
    const row = (event.target as HTMLElement).closest('[data-file-row]')?.querySelector<HTMLElement>('button[data-file-path]');
    const at = rows.indexOf(row as HTMLElement);
    const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
    else if (event.key === 'ArrowUp' && at === 0) { event.preventDefault(); search.current?.focus(); }
  }
  function inSearch(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') clearSearch();
    if (event.key === 'ArrowDown') {
      const first = scroll.current?.querySelector<HTMLElement>('button[data-file-path]');
      if (first) { event.preventDefault(); first.focus(); }
    }
  }

  const items = searching ? searchItems(state.search.entries ?? [], state.showHidden) : treeItems(state.levels, state.expanded, state.showHidden);
  // A search's tree is drawn with every level open, so a directory with matches under it says so, and shows it.
  const openDirectories = searching
    ? new Set(items.flatMap((item, at): string[] => item.kind === 'entry' && item.entry.kind === 'directory' && items[at + 1]?.depth === item.depth + 1 ? [item.entry.path] : []))
    : state.expanded;
  const cut = root.lastIndexOf('/');
  const tool = (name: string, onClick: () => void, glyph: ReactNode, options: { pressed?: boolean; disabled?: boolean } = {}) => (
    <button type="button" className={join(styles.tool, options.pressed && styles.toolOn)} aria-label={name} title={name}
      aria-pressed={options.pressed === undefined ? undefined : options.pressed} disabled={options.disabled} onClick={onClick}>{glyph}</button>
  );
  const status = searching && state.search.status !== 'idle';

  return <div className={styles.navigator}>
    <div className={styles.searchBar}>
      <input ref={search} className={styles.searchBox} type="search" aria-label="搜索文件" placeholder="搜索文件" maxLength={120} value={state.query}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; searchSoon(); }}
        onChange={event => { const text = event.target.value; update(next => { next.query = text; }); if (!composing.current) searchSoon(); }} onKeyDown={inSearch} />
      {tool('显示隐藏项', toggleHidden, <EyeGlyph hidden={!state.showHidden} />, { pressed: state.showHidden })}
      {state.query && tool('清空搜索', clearSearch, <ClearGlyph />)}
    </div>
    <header className={styles.header}>
      <span ref={path} className={styles.path} data-overflowed={pathOverflow} title={root}
        onContextMenu={event => { event.preventDefault(); openMenu({ kind: 'root' }, event.currentTarget, { x: event.clientX, y: event.clientY }); }}>
        <span className={styles.pathText} dir="ltr"><span className={styles.pathDirs}>{root.slice(0, cut + 1)}</span><span className={styles.pathLeaf}>{root.slice(cut + 1)}</span></span>
      </span>
      <span className={styles.fill} />
      {tool('重新读取', reload, <ReloadGlyph />, { disabled: busy })}
      <button type="button" className={join(styles.tool, menu?.header && styles.toolOn)} aria-label="更多操作" title="更多操作"
        aria-haspopup="menu" aria-expanded={menu?.header === true}
        onClick={event => { const box = event.currentTarget.getBoundingClientRect(); openMenu({ kind: 'root' }, event.currentTarget, { x: box.right, y: box.bottom + 4, align: 'end' }, true); }}>
        <MoreGlyph />
      </button>
    </header>
    {(error || accessError) && <p role="alert" className={styles.error}>{error || accessError}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    <p className={styles.status} aria-live="polite" aria-busy={state.search.status === 'running'}>
      {status && `${found} 个结果`}
      {status && state.search.status === 'running' && <span className={styles.spinner} aria-hidden="true" />}
    </p>
    <div ref={scroll} className={styles.scroll} aria-busy={state.search.status === 'running'} onScroll={event => { state.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={along}>
      {creating !== undefined && <form className={styles.newFile} onSubmit={event => void create(event)}>
        <span className={styles.newIn}>{creating ? `在 ${creating}/ 中` : '在根目录中'}</span>
        <input autoFocus aria-label="新建文本文件名称" placeholder="新建文件名" title="名称里不能有斜杠" required maxLength={255} pattern="[^/\\]+" value={newName}
          onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') cancelCreate(); }} />
        <button type="submit" className={styles.textButton} disabled={busy}>新建</button>
        <button type="button" className={styles.textButton} disabled={busy} onClick={cancelCreate}>取消</button>
      </form>}
      <FileTree items={items} expanded={openDirectories} current={state.current} query={searching ? state.query.trim() : undefined}
        onToggle={entry => searching ? enter(entry) : toggle(entry)} onOpen={open} onRetry={directory => { void read(directory, true); }} menu={openMenu} />
      {status && state.search.status === 'done' && !found && <p className={styles.note} role="status">没有匹配项</p>}
      {status && state.search.status === 'done' && state.search.truncated && <p className={styles.note} role="status">只显示前 {found} 个结果，请缩小搜索范围。</p>}
      {status && state.search.status === 'failed' && <p className={join(styles.note, styles.failed)} role="alert">搜索失败：{state.search.error}<button type="button" className={styles.noteAction} onClick={() => void searchNow(state.query)}>重试</button></p>}
    </div>
    {/* The chooser the menus' 上传 open: kept out of sight, since a chooser opens from a press of a menu item as well as from a visible control. It stays labelled, for the tests drive it by name. */}
    <input ref={upload} type="file" className={styles.fileInput} aria-label="上传文件" title="上传文件" tabIndex={-1}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; receive(file); }} />
    {menu && <FileMenu anchor={menu.anchor} label="文件操作" items={menuItems} dismiss={() => setMenu(undefined)} />}
  </div>;
}
