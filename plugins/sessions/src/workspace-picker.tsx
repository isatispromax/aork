import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiRuntime } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { WORKSPACE_DIRECTORY_PICKER } from '@aork/contracts/workspace';
import type { Workspace } from '@aork/contracts/workspace';
import { distinguishingPathSuffixes } from './path-suffix.js';
import { CheckIcon, FolderCloseIcon, PlusIcon } from './icons.js';
import createStyles from './create-session.module.css';

/** The create form's Workspace field, in the shape of deepseek-harness's WorkspacePicker: a card
 * anchored to its trigger that lists the Workspaces — folder glyph, name, the shortest path suffix
 * that tells same-named ones apart, a check on the chosen one — under a search box once there are two
 * or more, six rows visible, with 添加工作区… pinned below the list. Adding runs the Workspace
 * plugin's directory picker and selects what it registers. */

/** Name prefix first, then name substring, then directory substring; anything else is no match. */
function searchRank(workspace: { name: string; directory: string }, needle: string): number {
  const name = workspace.name.toLocaleLowerCase();
  const directory = workspace.directory.toLocaleLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (directory.includes(needle)) return 2;
  return -1;
}

const MENU_MARGIN = 8;
const VISIBLE_ROWS = 6;

function place(box: DOMRect, menu: HTMLElement): CSSProperties {
  const width = Math.max(box.width, 200);
  return {
    position: 'fixed',
    left: Math.max(MENU_MARGIN, Math.min(box.left, window.innerWidth - width - MENU_MARGIN)),
    top: Math.max(MENU_MARGIN, Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - MENU_MARGIN)),
    minWidth: width,
  };
}

export function WorkspacePickerField({ runtime, workspaces, value, onChange }: {
  runtime: UiRuntime;
  /** The Workspaces a new Session may start in. */
  workspaces: readonly Workspace[];
  value: string;
  onChange(id: string): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  // One command identity per attempted directory: retrying it replays the receipt instead of a second write.
  const addAttempt = useRef<{ directory: string; commandId: string } | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const canAdd = runtime.bootstrap.ui.providers[WORKSPACE_DIRECTORY_PICKER] !== undefined;
  const close = (back = true) => { setOpen(false); setQuery(''); if (back) trigger.current?.focus({ preventScroll: true }); };
  const selected = workspaces.find(item => item.id === value);
  const needle = query.trim().toLocaleLowerCase();
  const suffixes = distinguishingPathSuffixes(workspaces.map(item => ({ id: item.id, name: item.name, directory: item.directory })));
  const candidates = workspaces
    .map(workspace => ({ workspace, rank: needle ? searchRank(workspace, needle) : 0 }))
    .filter(item => item.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.workspace.name.localeCompare(right.workspace.name));
  useLayoutEffect(() => {
    if (open && menu.current && trigger.current) setPosition(place(trigger.current.getBoundingClientRect(), menu.current));
  }, [open, query]);
  useEffect(() => {
    if (!open) return undefined;
    const menuNode = menu.current;
    if (!menuNode) return undefined;
    // The search box, when there is one, or else the first choice.
    const target = menuNode.querySelector<HTMLElement>('[data-picker-search]') ?? menuNode.querySelector<HTMLElement>('[data-picker-option]');
    target?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.key === 'Tab') return;
      // Escape closes even while the search box holds text.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (menuNode.contains(event.target) || trigger.current?.contains(event.target))) return;
      close(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);
  const fieldKeys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-picker-option]')];
    const at = options.indexOf(document.activeElement as HTMLElement);
    const search = event.currentTarget.querySelector<HTMLElement>('[data-picker-search]');
    if (event.key === 'ArrowDown') { event.preventDefault(); options[Math.min(at + 1, options.length - 1)]?.focus({ preventScroll: true }); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (at > 0) options[at - 1]?.focus({ preventScroll: true }); else search?.focus({ preventScroll: true }); }
    else if (event.key === 'Enter' && !(event.target as HTMLElement).closest('[data-picker-add]')) {
      // Enter on the search (or an empty focus) picks the best candidate; on an option it picks that one.
      const id = (event.target as HTMLElement).matches('[data-picker-option]') ? (event.target as HTMLElement).dataset.pickerOption : candidates[0]?.workspace.id;
      if (id) { event.preventDefault(); onChange(id); close(); }
    }
  };
  async function addWorkspace(directory: string) {
    if (addAttempt.current?.directory !== directory) addAttempt.current = { directory, commandId: crypto.randomUUID() };
    const receipt = await runtime.command<CommandReceipt<Workspace>>('workspace.create', { workspace: { directory } }, addAttempt.current.commandId, { version: 1 });
    setAdding(false);
    onChange(receipt.result.id);
    close();
  }
  return <>
    <button type="button" ref={trigger} className={createStyles.pickerTrigger} aria-haspopup="listbox" aria-expanded={open} aria-label="选择工作区"
      onClick={() => { if (open) close(); else { setQuery(''); setOpen(true); } }}>
      <span className={selected ? undefined : createStyles.pickerPlaceholder}>{selected ? selected.name : '选择工作区'}</span>
      <span aria-hidden="true">▾</span>
    </button>
    {open && createPortal(
      <div ref={menu} className={createStyles.pickerMenu} style={position ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }} onKeyDown={fieldKeys}>
        {workspaces.length >= 2 && <input data-picker-search className={createStyles.pickerSearch} type="text" placeholder="搜索工作区" aria-label="搜索工作区"
          value={query} onChange={event => setQuery(event.target.value)} />}
        <div role="listbox" aria-label="选择工作区" className={createStyles.pickerList}>
          {candidates.map(({ workspace }) => {
            const suffix = suffixes.get(workspace.id) ?? '';
            return <button key={workspace.id} type="button" role="option" data-picker-option={workspace.id} aria-selected={workspace.id === value}
              className={createStyles.pickerOption} title={workspace.directory} onClick={() => { onChange(workspace.id); close(); }}>
              <FolderCloseIcon className={createStyles.pickerIcon} />
              <span className={createStyles.pickerOptionName}>{workspace.name}</span>
              {suffix && <span className={createStyles.pickerOptionSuffix}>{suffix}</span>}
              {workspace.id === value && <CheckIcon className={createStyles.pickerCheck} />}
            </button>;
          })}
          {!candidates.length && <p className={createStyles.pickerEmpty}>{workspaces.length ? '没有匹配的工作区。' : '还没有工作区。'}</p>}
        </div>
        {canAdd && <div className={createStyles.pickerFooter}>
          <button type="button" data-picker-add className={createStyles.pickerAdd} onClick={() => setAdding(true)}><PlusIcon className={createStyles.pickerIcon} />添加工作区…</button>
        </div>}
      </div>,
      document.body,
    )}
    {/* The picker is the Workspace plugin's; a refused registration stays in it, in place. */}
    {adding && runtime.renderView(WORKSPACE_DIRECTORY_PICKER, {
      onConfirm: addWorkspace,
      onCancel: () => setAdding(false),
    })}
  </>;
}
