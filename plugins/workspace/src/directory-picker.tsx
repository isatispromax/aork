import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

const failureText = (failure: unknown) => failure instanceof Error ? failure.message : '浏览目录失败';

function FolderGlyph({ dimmed }: { dimmed?: boolean }) {
  return <svg className={dimmed ? styles.iconDimmed : undefined} width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M1.5 5.25c0-.83.67-1.5 1.5-1.5h4.2c.4 0 .79.16 1.07.44l1.16 1.16c.1.1.24.16.38.16h7.19c.83 0 1.5.67 1.5 1.5v8.48c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V5.25Z" fill="var(--picker-folder-tab)" />
    <rect x="1.5" y="7" width="17" height="10" rx="1.5" fill="var(--picker-folder)" />
  </svg>;
}
function FileGlyph() {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".75" aria-hidden="true">
    <path d="M4.5 2.75c0-.55.45-1 1-1h5.09c.27 0 .52.11.71.29l3.66 3.66c.19.19.29.44.29.71v10.84c0 .55-.45 1-1 1h-8.75c-.55 0-1-.45-1-1V2.75Z" />
    <path d="M10.25 2.15v3.35c0 .55.45 1 1 1h3.35" />
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

function matchesSearch(entry: FileEntry, search: string) {
  return entry.name.toLowerCase().includes(search.trim().toLowerCase());
}

function entryGlyph(kind: FileEntry['kind']) {
  if (kind === 'directory') return <FolderGlyph />;
  if (kind === 'symlink') return <LinkGlyph />;
  if (kind === 'file') return <FileGlyph />;
  return <OtherGlyph />;
}

type ColumnResult = { listing: BrowseDirectory; error?: never } | { listing?: never; error: string };
type FolderTrail = readonly string[];
const emptyTrail: FolderTrail = [];

function directoryName(path: string) {
  return path.split('/').at(-1) || path;
}

async function browseDirectory(runtime: UiRuntime, path: string): Promise<BrowseDirectory> {
  const result = await runtime.resource('workspace.browseDirectory', { path });
  return JSON.parse(new TextDecoder().decode(result.bytes)) as BrowseDirectory;
}

function DirectoryColumn({
  runtime, path, result, showHidden, search, selectedPath, ancestor, onResult, onPick, onStep,
}: {
  runtime: UiRuntime;
  path: string;
  result: ColumnResult | undefined;
  showHidden: boolean;
  search: string;
  selectedPath: string | undefined;
  ancestor: boolean;
  onResult(path: string, result?: ColumnResult): void;
  onPick(entry: FileEntry, reveal: boolean, focusChild?: boolean): void;
  onStep(offset: number): void;
}) {
  useEffect(() => {
    let active = true;
    void browseDirectory(runtime, path).then(
      listing => { if (active) onResult(path, { listing }); },
      failure => { if (active) onResult(path, { error: failureText(failure) }); },
    );
    return () => { active = false; onResult(path); };
  }, [runtime, path, onResult]);

  const listing = result?.listing;
  const visibleEntries = listing ? filterHiddenEntries(listing.entries, showHidden).filter(entry => matchesSearch(entry, search)) : [];

  function handleKeys(event: KeyboardEvent<HTMLUListElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onStep(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!visibleEntries.length) return;
    const focused = (event.target as HTMLElement).closest('button')?.dataset.entryPath;
    const current = visibleEntries.findIndex(entry => entry.path === (focused ?? selectedPath));
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(visibleEntries.length - 1, Math.max(0, current + offset));
    const entry = visibleEntries[next]!;
    onPick(entry, false);
    event.currentTarget.querySelector<HTMLElement>(`button[data-entry-path=${CSS.escape(entry.path)}]`)?.focus();
  }

  return <section className={styles.column}>
    <ul className={styles.list} tabIndex={0} role="list" aria-label={`目录内容 · ${directoryName(path)}`} data-directory-path={path} onKeyDown={handleKeys}>
      {visibleEntries.map(item => {
        const selected = selectedPath === item.path;
        return <li key={item.path}>
          <button type="button" tabIndex={-1} className={item.kind === 'directory' ? undefined : styles.unchoosable} data-entry-path={item.path}
            aria-current={selected ? 'true' : undefined} data-ancestor={selected && ancestor || undefined} title={item.name}
            aria-label={item.kind === 'directory' ? `${item.name}，文件夹` : undefined}
            onClick={event => { if (event.detail <= 1) onPick(item, true); }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || item.kind !== 'directory') return;
              event.preventDefault();
              onPick(item, true, true);
            }}>
            <span className={styles.glyph}>{entryGlyph(item.kind)}</span>
            <span className={styles.name}>{item.name}</span>
            <span className={styles.disclosure}>
              {item.kind === 'directory' && <Chevron direction="right" />}
              {item.kind === 'symlink' && <small>链接</small>}
            </span>
          </button>
        </li>;
      })}
    </ul>
    {!result && <p role="status" className={styles.loading}>正在读取目录…</p>}
    {result?.error && <p role="alert" className={styles.error}>{result.error}</p>}
    {listing && !visibleEntries.length && <p role="status" className={styles.hint}>{search.trim() ? '没有匹配搜索的条目。' : listing.entries.length ? '此目录只有隐藏文件，可开启「显示隐藏文件」查看。' : '此目录为空。'}</p>}
    {listing?.truncated && <p role="status" className={styles.notice}>仅显示前 {FILE_LIMITS.entries} 项，可使用「前往文件夹」进入目标目录。</p>}
  </section>;
}

/** In-app directory browser. The caller owns the open state and receives an absolute path. */
export function DirectoryPicker({ runtime, onCancel, onConfirm }: { runtime: UiRuntime; onCancel(): void; onConfirm(directory: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const pathBar = useRef<HTMLElement>(null);
  const goto = useRef<HTMLInputElement>(null);
  const navigationFocus = useRef<string | undefined>(undefined);
  const revealNewest = useRef(true);
  const [home, setHome] = useState<string>();
  const [discoveryError, setDiscoveryError] = useState('');
  const [results, setResults] = useState(() => new Map<string, ColumnResult>());
  const [history, setHistory] = useState<FolderTrail[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [gotoInput, setGotoInput] = useState('');
  const [search, setSearch] = useState('');

  const trail = history[cursor] ?? emptyTrail;
  const path = trail.at(-1);
  const discovering = !path && !discoveryError;
  const listing = path ? results.get(path)?.listing : undefined;
  const confirm = confirmSelection(selectedFile, listing?.path ?? '');
  const displayPath = listing?.path ?? path;
  const crumbs = displayPath ? breadcrumbSegments(displayPath) : [];
  const visibleCount = listing ? filterHiddenEntries(listing.entries, showHidden).filter(entry => matchesSearch(entry, search)).length : 0;

  useEffect(() => {
    const node = dialog.current;
    const before = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => { node?.close(); if (before?.isConnected) before.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    void browseDirectory(runtime, '/').then(value => {
      if (!active) return;
      const initialPath = normalizeDirectoryPath(value.home);
      setHome(initialPath);
      navigationFocus.current = initialPath;
      setHistory([[initialPath]]);
      setCursor(0);
    }, failure => { if (active) setDiscoveryError(failureText(failure)); });
    return () => { active = false; };
  }, [runtime]);

  const recordResult = useCallback((directory: string, result?: ColumnResult) => {
    setResults(previous => {
      if (!result && !previous.has(directory)) return previous;
      const updated = new Map(previous);
      if (result) updated.set(directory, result);
      else updated.delete(directory);
      return updated;
    });
  }, []);

  const focusColumn = useCallback((directory: string) => {
    const list = columns.current?.querySelector<HTMLElement>(`[data-directory-path=${CSS.escape(directory)}]`);
    if (!list) return;
    const focus = list.querySelector<HTMLElement>('[aria-current="true"]') ?? list;
    focus.focus();
  }, []);

  useLayoutEffect(() => {
    const pending = navigationFocus.current;
    navigationFocus.current = undefined;
    if (revealNewest.current && columns.current) columns.current.scrollLeft = columns.current.scrollWidth;
    if (pending) focusColumn(pending);
  }, [trail, focusColumn]);

  useLayoutEffect(() => {
    if (pathBar.current) pathBar.current.scrollLeft = pathBar.current.scrollWidth;
  }, [displayPath, listing, visibleCount]);

  function visit(next: FolderTrail, reveal: boolean, focus?: string) {
    if (next.length === trail.length && next.every((item, index) => item === trail[index])) {
      if (focus) focusColumn(focus);
      return;
    }
    revealNewest.current = reveal;
    navigationFocus.current = focus;
    setHistory([...history.slice(0, cursor + 1), next]);
    setCursor(cursor + 1);
  }

  function navigate(to: string) {
    const target = normalizeDirectoryPath(to);
    const index = trail.indexOf(target);
    setSelectedFile(null);
    setSearch('');
    visit(index < 0 ? [target] : trail.slice(0, index + 1), true, target);
  }

  function walk(delta: number) {
    const index = cursor + delta;
    const next = history[index];
    if (!next) return;
    revealNewest.current = true;
    navigationFocus.current = next.at(-1);
    setSelectedFile(null);
    setSearch('');
    setCursor(index);
  }

  function pick(index: number, entry: FileEntry, reveal: boolean, focusChild?: boolean) {
    const ancestors = trail.slice(0, index + 1);
    if (entry.kind === 'directory') {
      setSelectedFile(null);
      setSearch('');
      visit([...ancestors, entry.path], reveal, focusChild ? entry.path : undefined);
    } else {
      setSelectedFile(entry);
      if (index < trail.length - 1) setSearch('');
      visit(ancestors, reveal);
    }
  }

  function toggleHidden(next: boolean) {
    setShowHidden(next);
    setSelectedFile(current => current && !next && current.name.startsWith('.') ? null : current);
  }

  function changeSearch(next: string) {
    setSearch(next);
    setSelectedFile(current => current && matchesSearch(current, next) ? current : null);
  }

  function submitGoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = gotoInput.trim();
    if (!target || discovering) return;
    const expanded = expandHomePath(target, home);
    if (expanded === null) {
      setDiscoveryError('主目录未知，请直接输入绝对路径。');
      return;
    }
    setDiscoveryError('');
    setGotoInput('');
    navigate(expanded);
  }

  function handleShortcut(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      goto.current?.focus();
      goto.current?.select();
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-label="目录选择器" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={handleShortcut}>
    <header className={styles.titleBar}>
      <div className={styles.lights}>
        <button type="button" className={styles.lightClose} aria-label="关闭" onClick={onCancel} />
        <span className={styles.lightDisabled} aria-hidden="true" />
        <span className={styles.lightGrow} aria-hidden="true" />
      </div>
      <h2 className={styles.title}>选择文件夹</h2>
    </header>
    <div className={styles.body}>
      <aside className={styles.side}>
        <p className={styles.sideTitle}>收藏</p>
        {home && <nav className={styles.quick} aria-label="快捷入口">
          {quickAccessTargets(home).map((target, index) => <button key={target.path} type="button" aria-current={trail[0] === target.path && results.get(target.path)?.listing ? 'true' : undefined} onClick={() => navigate(target.path)}>
            <span className={styles.quickIcon}><SidebarGlyph kind={(['home', 'desktop', 'documents', 'downloads'] as const)[index]!} /></span>{target.label}
          </button>)}
        </nav>}
        <label className={styles.check}><input type="checkbox" checked={showHidden} onChange={event => toggleHidden(event.target.checked)} />显示隐藏文件</label>
      </aside>
      <div className={styles.main}>
        <div className={styles.toolbar}>
          <div className={styles.history} role="group" aria-label="浏览历史">
            <button type="button" className={styles.navButton} disabled={cursor <= 0} aria-label="后退" title="后退" onClick={() => walk(-1)}><Chevron direction="left" /></button>
            <button type="button" className={styles.navButton} disabled={cursor >= history.length - 1} aria-label="前进" title="前进" onClick={() => walk(1)}><Chevron direction="right" /></button>
          </div>
          <div className={styles.location} title={path}>
            <FolderGlyph />
            <span>{path ? directoryName(path) : '目录'}</span>
          </div>
          <label className={styles.search}>
            <SearchGlyph />
            <input role="searchbox" inputMode="search" aria-label="搜索当前目录" placeholder="搜索" autoComplete="off" spellCheck={false} value={search} onChange={event => changeSearch(event.target.value)} />
          </label>
        </div>
        <div className={styles.columns} ref={columns}>
          {!path && <section className={styles.column}>
            {discoveryError ? <p role="alert" className={styles.error}>{discoveryError}</p> : <p role="status" className={styles.loading}>正在读取目录…</p>}
          </section>}
          {trail.map((directory, index) => <DirectoryColumn key={directory} runtime={runtime} path={directory}
            result={results.get(directory)} showHidden={showHidden} search={index === trail.length - 1 ? search : ''}
            selectedPath={trail[index + 1] ?? (index === trail.length - 1 ? selectedFile?.path : undefined)}
            ancestor={index < trail.length - 2} onResult={recordResult}
            onPick={(entry, reveal, focusChild) => pick(index, entry, reveal, focusChild)}
            onStep={offset => {
              const target = trail[index + offset];
              if (target) focusColumn(target);
            }}
          />)}
        </div>
        <div className={styles.pathBar}>
          <nav ref={pathBar} className={styles.crumbs} aria-label="目录位置" title={displayPath}>
            {crumbs.map((segment, index) => <span key={segment.path} className={styles.crumb}>
              {index > 0 && <Chevron direction="right" />}
              {index === crumbs.length - 1
                ? <span className={styles.current} aria-current="page">{segment.name}</span>
                : <button type="button" onClick={() => navigate(segment.path)}>{segment.name}</button>}
            </span>)}
          </nav>
          {listing && <span className={styles.count}>{visibleCount} 个项目</span>}
        </div>
      </div>
    </div>
    <footer className={styles.footer}>
      <form className={styles.goto} onSubmit={submitGoto}>
        <input ref={goto} aria-label="前往文件夹" placeholder="前往文件夹…" autoComplete="off" spellCheck={false} value={gotoInput} onChange={event => setGotoInput(event.target.value)} />
        <button type="submit" disabled={discovering || !gotoInput.trim()}>前往</button>
      </form>
      <div className={styles.footerButtons}>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className={styles.primary} disabled={!listing || !confirm.enabled} onClick={() => { if (confirm.path) onConfirm(confirm.path); }}>选择</button>
      </div>
    </footer>
  </dialog>;
}
