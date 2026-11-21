import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
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

/** In-app NSOpenPanel-style directory browser for workspace registration.
 * The caller owns visibility: `onConfirm` receives an absolute directory path and
 * `onCancel` closes without a selection; neither closes the dialog by itself. */
export function DirectoryPicker({ runtime, visible, onCancel, onConfirm }: DirectoryPickerProps) {
  if (!visible) return null;
  return <PickerDialog runtime={runtime} onCancel={onCancel} onConfirm={onConfirm} />;
}

const failureText = (failure: unknown) => failure instanceof Error ? failure.message : '浏览目录失败';

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

  function navigate(to: string) {
    restoreFocus.current = selected?.path ?? listing?.path;
    setSelected(null);
    setPath(normalizeDirectoryPath(to));
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

  const visibleEntries = listing ? filterHiddenEntries(listing.entries, showHidden) : [];
  const confirm = confirmSelection(selected, listing?.path ?? '');
  const crumbs = listing ? breadcrumbSegments(listing.path) : [];
  const lastSegment = crumbs.length - 1;
  const up = listing ? parentPath(listing.path) : null;

  return <dialog ref={dialog} className={styles.dialog} aria-label="目录选择器" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={handleShortcut}>
    <h2>选择目录</h2>
    <div className={styles.layout}>
      <aside className={styles.side}>
        <div>
          <p className={styles.sideTitle}>快捷入口</p>
          {home && <nav className={styles.quick} aria-label="快捷入口">
            {quickAccessTargets(home).map(target => <button key={target.path} type="button" aria-current={listing?.path === target.path ? 'true' : undefined} onClick={() => navigate(target.path)}>{target.label}</button>)}
          </nav>}
        </div>
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
        <nav className={styles.crumbs} aria-label="目录位置">
          {crumbs.map((segment, index) => index === lastSegment
            ? <span key={segment.path} className={styles.current} aria-current="page">{segment.name}</span>
            : <button key={segment.path} type="button" onClick={() => navigate(segment.path)}>{segment.name}</button>)}
          {up && <button type="button" onClick={() => navigate(up)}>上一级</button>}
        </nav>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <ul ref={list} className={styles.list} tabIndex={-1} aria-label="目录内容">
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
              <span className={styles.glyph} aria-hidden="true">{item.kind === 'directory' ? '▱' : item.kind === 'symlink' ? '↗' : '·'}</span>
              <span className={styles.name}>{item.name}</span>
              <small className={styles.kind}>{item.kind === 'directory' ? '目录' : item.kind === 'symlink' ? '链接' : item.kind === 'file' ? `${item.size} B` : '其他'}</small>
            </button>
          </li>)}
        </ul>
        {!listing && !error && loading && <p role="status" className={styles.loading}>正在读取目录…</p>}
        {listing && !visibleEntries.length && <p className={styles.hint}>{listing.entries.length ? '此目录只有隐藏文件，可开启「显示隐藏文件」查看。' : '此目录为空。'}</p>}
        {listing?.truncated && <p role="status" className={styles.notice}>结果达到上限（500 项），部分条目未显示；请使用「前往文件夹」直接进入目标目录。</p>}
      </div>
    </div>
    <footer className={styles.footer}>
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" className={styles.primary} disabled={loading || !confirm.enabled} onClick={() => { if (confirm.path) onConfirm(confirm.path); }}>选择</button>
    </footer>
  </dialog>;
}
