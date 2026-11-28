import { useMemo } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { FileEntry } from '@aork/contracts/workspace';
import { DockGlyph } from '@aork/dock';
import { matchRanges } from './file-tree.js';
import type { TreeItem } from './file-tree.js';
import styles from './files.module.css';

/** What a row's menu acts on: a file, a directory, or the Workspace root the header names. */
export type MenuTarget = { kind: 'file' | 'directory'; path: string; name: string } | { kind: 'root' };

export interface FileTreeProps {
  items: readonly TreeItem[];
  expanded: ReadonlySet<string>;
  /** The file whose row is the current one. */
  current: string | undefined;
  /** The search in force: where it occurs in a match's name is marked. */
  query: string | undefined;
  onToggle(entry: FileEntry): void;
  onOpen(entry: FileEntry): void;
  onRetry(path: string): void;
  /** Opens the menu of a row's target: at the pointer, or under the row — under its end for the
   * row's own control — for the keyboard and a touch. */
  menu(target: MenuTarget, row: HTMLElement, at?: { x: number; y: number; align?: 'end' }): void;
}

/** Lines of the tree as branches: each line belongs to the entry drawn above it at one depth less. */
interface Branch { item: TreeItem; children: Branch[] }
function nest(items: readonly TreeItem[]): Branch[] {
  const roots: Branch[] = [];
  const open: Branch[] = [];
  for (const item of items) {
    const branch: Branch = { item, children: [] };
    const parent = open[item.depth - 1];
    if (parent) parent.children.push(branch); else roots.push(branch);
    open[item.depth] = branch;
    open.length = item.depth + 1;
  }
  return roots;
}

const keyOf = (item: TreeItem): string => item.kind === 'entry' ? `entry:${item.entry.path}` : `${item.kind}:${item.path}`;
const join = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

/* Glyphs: the docking kit's stroke, so the tree reads as part of the strip above it. */
function entryGlyph(entry: FileEntry, open: boolean): ReactNode {
  if (entry.kind === 'directory') return open
    ? <DockGlyph><path d="M2 12.5V4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v1" /><path d="M1.5 12.6a.8.8 0 0 0 .76 1.05h9.9a1.3 1.3 0 0 0 1.23-.89l1.36-4.06a.6.6 0 0 0-.57-.8H4.53a1.3 1.3 0 0 0-1.23.89z" /></DockGlyph>
    : <DockGlyph><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" /></DockGlyph>;
  if (entry.kind === 'symlink') return <DockGlyph><path d="M5.5 10.5l4-4" /><path d="M8.5 3.5l1-1a2.47 2.47 0 0 1 3.5 3.5l-1 1" /><path d="M7.5 12.5l-1 1a2.47 2.47 0 0 1-3.5-3.5l1-1" /></DockGlyph>;
  if (entry.kind === 'other') return <DockGlyph><circle cx="8" cy="8" r="5.5" /><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" /></DockGlyph>;
  return <DockGlyph><path d="M4 1.75h5L12.25 5v8a1.5 1.5 0 0 1-1.5 1.5h-6.75a1.5 1.5 0 0 1-1.5-1.5v-9.75A1.5 1.5 0 0 1 4 1.75z" /><path d="M9 1.75V5h3.25" /></DockGlyph>;
}

/** A name with each occurrence of the search marked. */
function marked(text: string, query: string | undefined): ReactNode {
  if (!query) return text;
  const ranges = matchRanges(text, query);
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) parts.push(text.slice(from, start));
    parts.push(<mark className={styles.match} key={start}>{text.slice(start, end)}</mark>);
    from = end;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

const NOTES = { loading: '正在读取…', empty: '空目录', hidden: '隐藏项未显示', truncated: '条目太多，只显示了一部分。' } as const;

export function FileTree(props: FileTreeProps) {
  const roots = useMemo(() => nest(props.items), [props.items]);
  return <ul className={styles.level}>{roots.map(branch => <BranchLine key={keyOf(branch.item)} branch={branch} {...props} />)}</ul>;
}

function BranchLine({ branch, ...props }: { branch: Branch } & FileTreeProps) {
  const { item, children } = branch;
  return <li className={styles.item}>
    {item.kind === 'entry' && <EntryRow entry={item.entry} matched={item.matched} {...props} />}
    {item.kind === 'note' && <p className={styles.note} role={item.note === 'loading' ? 'status' : undefined}>{NOTES[item.note]}</p>}
    {item.kind === 'failure' && <p className={join(styles.note, styles.failed)} role="alert">读取失败：{item.error}<button type="button" className={styles.noteAction} onClick={() => props.onRetry(item.path)}>重试</button></p>}
    {children.length > 0 && <ul className={styles.level}>{children.map(child => <BranchLine key={keyOf(child.item)} branch={child} {...props} />)}</ul>}
  </li>;
}

function EntryRow({ entry, matched, expanded, current, query, onToggle, onOpen, menu }: { entry: FileEntry; matched: boolean } & FileTreeProps) {
  const directory = entry.kind === 'directory';
  const open = directory && expanded.has(entry.path);
  // Only a file or a directory can be acted on; anything else is listed greyed, with the reason.
  const openable = directory || entry.kind === 'file';
  const target: MenuTarget = { kind: directory ? 'directory' : 'file', path: entry.path, name: entry.name };
  const icon = <span className={join(styles.icon, open && styles.iconOpen)} aria-hidden="true">{entryGlyph(entry, open)}</span>;
  const name = <span className={styles.name}>{marked(entry.name, matched ? query : undefined)}</span>;
  return <div className={styles.row} data-file-row>
    {openable ? <button type="button" className={styles.action} data-file-path={entry.path}
      aria-expanded={directory ? open : undefined} aria-current={current === entry.path ? 'page' : undefined}
      onClick={() => directory ? onToggle(entry) : onOpen(entry)}
      // A secondary press is a gesture on the row, not a way into it: it takes focus, so Escape has somewhere to return.
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); menu(target, event.currentTarget, { x: event.clientX, y: event.clientY }); }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        menu(target, event.currentTarget, { x: rect.left, y: rect.bottom + 4 });
      }}>{icon}{name}</button>
    : <span className={join(styles.action, styles.unopenable)} data-file-path={entry.path} aria-disabled="true">{icon}{name}<span className={styles.reason}>{entry.kind === 'symlink' ? '链接不可访问' : '不是文件或目录'}</span></span>}
    {openable && <button type="button" className={styles.rowMenu} aria-label={`更多操作：${entry.name}`} aria-haspopup="menu" title="更多操作"
      onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); menu(target, event.currentTarget, { x: rect.right, y: rect.bottom + 4, align: 'end' }); }}>···</button>}
  </div>;
}
