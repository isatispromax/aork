import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { BrowseDirectory, FileEntry } from '@aork/contracts/workspace';
import styles from './directory-picker.module.css';

/** Strips trailing slashes; the root stays `/` so parent/breadcrumb math stays total. */
export function normalizeDirectoryPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** The server never accepts `~` or relative paths; the picker expands `~` with the
 * `home` field revealed by the browse responses. `~name` is not this user's home and
 * passes through for the server to reject in place. Returns null when `~` is requested
 * before any response revealed home. */
export function expandHomePath(input: string, home: string | undefined): string | null {
  if (!input.startsWith('~')) return input;
  if (!home) return null;
  if (input === '~' || input.startsWith('~/')) return `${home}${input.slice(1)}`;
  return input;
}

/** Parent of a browsed directory; null at the root (the 上一级 affordance hides there). */
export function parentPath(path: string): string | null {
  const current = normalizeDirectoryPath(path);
  if (current === '/') return null;
  const parent = current.slice(0, current.lastIndexOf('/'));
  return parent === '' ? '/' : parent;
}

export interface BreadcrumbSegment { name: string; path: string }

/** Root plus one clickable segment per directory level with cumulative absolute paths. */
export function breadcrumbSegments(path: string): BreadcrumbSegment[] {
  const current = normalizeDirectoryPath(path);
  const segments: BreadcrumbSegment[] = [{ name: '/', path: '/' }];
  if (current === '/') return segments;
  let accumulated = '';
  for (const part of current.slice(1).split('/')) {
    if (!part) continue;
    accumulated += `/${part}`;
    segments.push({ name: part, path: accumulated });
  }
  return segments;
}

/** Pure client-side dotfile filter; the server returns entries as-is and is never refetched. */
export function filterHiddenEntries(entries: readonly FileEntry[], showHidden: boolean): FileEntry[] {
  return showHidden ? [...entries] : entries.filter(entry => !entry.name.startsWith('.'));
}

export interface ConfirmState { enabled: boolean; path: string | null }

/** 「选择」 semantics: a selected directory row confirms that row, no selection confirms the
 * currently browsed directory, and a selected non-directory row (file/symlink/other) disables confirmation. */
export function confirmSelection(selected: Pick<FileEntry, 'path' | 'kind'> | null, currentPath: string): ConfirmState {
  if (!selected) return { enabled: true, path: currentPath };
  if (selected.kind !== 'directory') return { enabled: false, path: null };
  return { enabled: true, path: selected.path };
}

/** Static quick-access bar entries, resolved against the discovered home. */
export function quickAccessTargets(home: string): Array<{ label: string; path: string }> {
  return [
    { label: '主目录', path: home },
    { label: '桌面', path: `${home}/Desktop` },
    { label: '文稿', path: `${home}/Documents` },
    { label: '下载', path: `${home}/Downloads` },
  ];
}

export interface DirectoryPickerProps { runtime: UiRuntime; visible: boolean; onCancel(): void; onConfirm(directory: string): void }

/** In-app macOS-style directory browser for workspace registration.
 * The caller owns visibility: `onConfirm` receives an absolute directory path and
 * `onCancel` closes without a selection; neither closes the dialog by itself. */
export function DirectoryPicker({ runtime, visible, onCancel, onConfirm }: DirectoryPickerProps) {
  if (!visible) return null;
  return <PickerDialog runtime={runtime} onCancel={onCancel} onConfirm={onConfirm} />;
}

const failureText = (failure: unknown) => failure instanceof Error ? failure.message : '浏览目录失败';

function FolderGlyph({ dimmed }: { dimmed?: boolean }) {
  return <svg className={dimmed ? styles.iconDimmed : undefined} width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M1.5 5.25c0-.83.67-1.5 1.5-1.5h4.2c.4 0 .79.16 1.07.44l1.16 1.16c.1.1.24.16.38.16h7.19c.83 0 1.5.67 1.5 1.5v8.48c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V5.25Z" fill="var(--aork-picker-folder, #5eb0f5)" />
    <path d="M1.5 7.9c0-.5.46-.88.95-.77 1.86.4 3.8.4 5.66 0l1.79-.39v8.6c0 .56-.44 1.02-1 1.02H2.5c-.55 0-1-.45-1-1V7.9Z" fill="#ffffff" opacity=".28" />
  </svg>;
}
function FileGlyph() {
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.5 2.75c0-.55.45-1 1-1h5.09c.27 0 .52.11.71.29l3.66 3.66c.19.19.29.44.29.71v10.84c0 .55-.45 1-1 1h-8.75c-.55 0-1-.45-1-1V2.75Z" fill="var(--aork-surface)" stroke="var(--aork-border)" strokeWidth="1.2" />
    <path d="M10.25 2.15v3.35c0 .55.45 1 1 1h3.35" fill="none" stroke="var(--aork-border)" strokeWidth="1.2" />
  </svg>;
}
function LinkGlyph() {
  return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <FolderGlyph dimmed />
    <path d="M12 15h5m0 0-2.2-2.2M17 15l-2.2 2.2" fill="none" stroke="var(--aork-text)" strokeWidth="1.5" strokeLinecap="round" />
  </svg>;
}
function OtherGlyph() { return <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="var(--aork-border)" strokeWidth="1.5" /></svg>; }
function SidebarGlyph({ kind }: { kind: 'home' | 'desktop' | 'documents' | 'downloads' }) {
  const paths = {
    home: 'M10 3.2 3.5 8.6V16c0 .55.45 1 1 1H8v-4.5h4V17h3.5c.55 0 1-.45 1-1V8.6L10 3.2Z',
    desktop: 'M2.75 5c0-.55.45-1 1-1h12.5c.55 0 1 .45 1 1v7.5c0 .55-.45 1-1 1H3.75c-.55 0-1-.45-1-1V5Zm3 10.5h8.5',
    documents: 'M5.25 2.75h6.1l3.4 3.4V17c0 .55-.45 1-1 1H5.25c-.55 0-1-.45-1-1V3.75c0-.55.45-1 1-1Zm6 0v3.4h3.4',
    downloads: 'M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8M4 15.5c0 .55.45 1 1 1h10c.55 0 1-.45 1-1',
  } as const;
  return <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d={paths[kind]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d={direction === 'left' ? 'M9 2.5 4.5 7 9 11.5' : 'M5 2.5 9.5 7 5 11.5'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function SearchGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9.2 9.2 12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function entryGlyph(kind: FileEntry['kind']) {
  if (kind === 'directory') return <FolderGlyph />;
  if (kind === 'symlink') return <LinkGlyph />;
  if (kind === 'file') return <FileGlyph />;
  return <OtherGlyph />;
}

function PickerDialog({ runtime, onCancel, onConfirm }: { runtime: UiRuntime; onCancel(): void; onConfirm(directory: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const goto = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<string | undefined>(undefined);
  const [home, setHome] = useState<string>();
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<BrowseDirectory>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [gotoInput, setGotoInput] = useState('');
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);

  // Repo dialog convention: showModal on mount, close and restore the caller's focus on unmount.
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); }; }, []);

  // One browse in flight per path; responses for an abandoned path are dropped by the active flag.
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setListing(undefined); setSelected(null);
    const target = path ?? '/'; // Before the first response reveals `home`, `/` is only a home probe.
    void (async () => {
      const result = await runtime.resource('workspace.browseDirectory', { path: target });
      return JSON.parse(new TextDecoder().decode(result.bytes)) as BrowseDirectory;
    })()
      .then(value => {
        if (!active) return;
        setHome(value.home);
        if (!path) { setPath(value.home); return; } // Discovery phase: jump to 主目录 without showing `/`.
        setLoading(false); setListing(value);
      })
      .catch(failure => { if (!active) return; setLoading(false); setError(failureText(failure)); });
    return () => { active = false; };
  }, [path, runtime]);

  // Focus follows the file-view idiom: the previously visited row if still visible, else the list container.
  useLayoutEffect(() => {
    if (!listing) return;
    const remembered = restoreFocus.current; restoreFocus.current = undefined;
    const target = remembered ? list.current?.querySelector<HTMLElement>(`button[data-entry-path=${CSS.escape(remembered)}]`) : undefined;
    if (target?.getClientRects().length) target.focus(); else list.current?.focus();
  }, [listing]);

  // Finder-style navigation history: every jump truncates the forward tail; back/forward walk it.
  function navigate(to: string) {
    restoreFocus.current = selected?.path ?? listing?.path;
    const target = normalizeDirectoryPath(to);
    setSelected(null); setSearch('');
    setHistory([...history.slice(0, cursor + 1), target]);
    setCursor(cursor + 1);
    setPath(target);
  }
  function walk(delta: number) {
    const target = cursor + delta;
    if (target < 0 || target >= history.length) return;
    restoreFocus.current = selected?.path ?? listing?.path;
    setSelected(null); setSearch('');
    setCursor(target); setPath(history[target]!);
  }
  function toggleHidden(next: boolean) {
    setShowHidden(next);
    setSelected(current => current && !next && current.name.startsWith('.') ? null : current);
  }
  function submitGoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = gotoInput.trim();
    if (!target) return;
    const expanded = expandHomePath(target, home);
    if (expanded === null) { setError('主目录未知，请直接输入绝对路径。'); return; }
    setGotoInput('');
    navigate(expanded);
  }
  // ⇧⌘G (Ctrl⇧G off-mac) moves focus to the 前往文件夹 input while the dialog is open.
  function handleShortcut(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      goto.current?.focus();
      goto.current?.select();
    }
  }

  const visibleEntries = listing ? filterHiddenEntries(listing.entries, showHidden).filter(entry => !search || entry.name.toLowerCase().includes(search.toLowerCase())) : [];
  const confirm = confirmSelection(selected, listing?.path ?? '');
  const crumbs = listing ? breadcrumbSegments(listing.path) : [];
  const lastSegment = crumbs.length - 1;
  const up = listing ? parentPath(listing.path) : null;
  const canBack = cursor > 0, canForward = cursor < history.length - 1;

  // Finder list keyboard model: ↑/↓ move the selection, → enters the selected directory, ← goes up.
  function moveSelection(delta: number) {
    if (!visibleEntries.length) return;
    const current = selected ? visibleEntries.findIndex(entry => entry.path === selected.path) : -1;
    const next = Math.min(visibleEntries.length - 1, Math.max(0, current + delta));
    const entry = visibleEntries[next]!;
    setSelected(entry);
    list.current?.querySelector<HTMLElement>(`button[data-entry-path=${CSS.escape(entry.path)}]`)?.focus();
  }
  function handleListKeys(event: KeyboardEvent<HTMLUListElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (selected?.kind === 'directory') navigate(selected.path); }
    else if (event.key === 'ArrowLeft' && up) { event.preventDefault(); navigate(up); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-label="目录选择器" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={handleShortcut}>
    <header className={styles.titleBar}>
      <div className={styles.lights}>
        <button type="button" className={styles.lightClose} aria-label="关闭" onClick={onCancel} />
        <span className={styles.lightDisabled} aria-hidden="true" />
        <span className={styles.lightGrow} aria-hidden="true" />
      </div>
      <p className={styles.title}>选择文件夹</p>
    </header>
    <div className={styles.toolbar}>
      <button type="button" className={styles.navButton} disabled={!canBack} aria-label="后退" onClick={() => walk(-1)}><Chevron direction="left" /></button>
      <button type="button" className={styles.navButton} disabled={!canForward} aria-label="前进" onClick={() => walk(1)}><Chevron direction="right" /></button>
      <span className={styles.search}>
        <SearchGlyph />
        <input aria-label="搜索当前目录" placeholder="搜索" autoComplete="off" spellCheck={false} value={search} onChange={event => setSearch(event.target.value)} />
      </span>
    </div>
    <div className={styles.body}>
      <aside className={styles.side}>
        <p className={styles.sideTitle}>收藏</p>
        {home && <nav className={styles.quick} aria-label="快捷入口">
          {quickAccessTargets(home).map((target, index) => <button key={target.path} type="button" aria-current={listing?.path === target.path ? 'true' : undefined} onClick={() => navigate(target.path)}>
            <span className={styles.quickIcon} data-kind={['home', 'desktop', 'documents', 'downloads'][index]}><SidebarGlyph kind={['home', 'desktop', 'documents', 'downloads'][index] as 'home' | 'desktop' | 'documents' | 'downloads'} /></span>{target.label}
          </button>)}
        </nav>}
        <label className={styles.check}><input type="checkbox" checked={showHidden} onChange={event => toggleHidden(event.target.checked)} />显示隐藏文件</label>
        <form className={styles.goto} onSubmit={submitGoto}>
          <p className={styles.sideTitle}><label htmlFor="directory-picker-goto">前往文件夹</label></p>
          <div className={styles.gotoRow}>
            <input ref={goto} id="directory-picker-goto" aria-label="前往文件夹" placeholder="/absolute/path 或 ~/…" autoComplete="off" spellCheck={false} value={gotoInput} onChange={event => setGotoInput(event.target.value)} />
            <button type="submit" disabled={loading}>前往</button>
          </div>
        </form>
      </aside>
      <div className={styles.main}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <ul ref={list} className={styles.list} tabIndex={-1} aria-label="目录内容" onKeyDown={handleListKeys}>
          {visibleEntries.map(item => <li key={item.path}>
            <button type="button" className={item.kind === 'directory' ? undefined : styles.unchoosable} data-entry-path={item.path} aria-current={selected?.path === item.path ? 'true' : undefined}
              onClick={() => setSelected(item)}
              onDoubleClick={() => { if (item.kind === 'directory') navigate(item.path); }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                if (selected?.path !== item.path) return; // Enter on an unselected row keeps the native select click.
                event.preventDefault(); // Enter on a selected non-directory row does nothing.
                if (item.kind === 'directory') navigate(item.path);
              }}>
              <span className={styles.glyph}>{entryGlyph(item.kind)}</span>
              <span className={styles.name}>{item.name}</span>
              <small className={styles.kind}>{item.kind === 'directory' ? '文件夹' : item.kind === 'symlink' ? '链接' : item.kind === 'file' ? `${item.size} B` : '其他'}</small>
            </button>
          </li>)}
        </ul>
        {!listing && !error && loading && <p role="status" className={styles.loading}>正在读取目录…</p>}
        {listing && !visibleEntries.length && <p className={styles.hint}>{search ? '没有匹配搜索的条目。' : listing.entries.length ? '此目录只有隐藏文件，可开启「显示隐藏文件」查看。' : '此目录为空。'}</p>}
        {listing?.truncated && <p role="status" className={styles.notice}>结果达到上限（{FILE_LIMITS.entries} 项），部分条目未显示；请使用「前往文件夹」直接进入目标目录。</p>}
      </div>
    </div>
    <footer className={styles.pathBar}>
      <nav className={styles.crumbs} aria-label="目录位置">
        {crumbs.map((segment, index) => <span key={segment.path} className={styles.crumb}>
          {index > 0 && <span className={styles.crumbSeparator} aria-hidden="true">›</span>}
          {index === lastSegment
            ? <span className={styles.current} aria-current="page">{segment.name}</span>
            : <button type="button" onClick={() => navigate(segment.path)}>{segment.name}</button>}
        </span>)}
      </nav>
      {listing && <span className={styles.count}>{visibleEntries.length} 个项目</span>}
    </footer>
    <footer className={styles.footer}>
      <span className={styles.footerHint}>{confirm.path ? confirm.path : '未选中时「选择」确认当前文件夹'}</span>
      <div className={styles.footerButtons}>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className={styles.primary} disabled={loading || !confirm.enabled} onClick={() => { if (confirm.path) onConfirm(confirm.path); }}>选择</button>
      </div>
    </footer>
  </dialog>;
}
