import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './files.module.css';

export interface MenuAnchor {
  x: number;
  y: number;
  /** Whether the menu's left edge (`start`) or its right edge (`end`) sits at `x`. */
  align?: 'start' | 'end';
  /** The control that opened the menu. It takes focus back when the menu closes. */
  returnTo: HTMLElement;
}
/** One row of a menu. `heading` rows are labels; `checked` makes the row a radio choice; `separatorBefore`
 * opens a group with a rule; `danger` is the destructive colour. */
export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  heading?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  danger?: boolean;
  icon?: ReactNode;
  run(): void;
}

/** The margin the menu keeps from the viewport's edges, however near them the pointer is. */
const MARGIN = 8;
const capture = true;

function place(anchor: MenuAnchor, menu: HTMLElement): CSSProperties {
  const wanted = anchor.align === 'end' ? anchor.x - menu.offsetWidth : anchor.x;
  return {
    position: 'fixed',
    left: Math.max(MARGIN, Math.min(wanted, window.innerWidth - menu.offsetWidth - MARGIN)),
    top: Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - MARGIN)),
  };
}

/** A row's menu, in the shape of the docking kit's own tab menu: drawn above everything and
 * dismissing itself on an outside press or an unmodified Escape, with focus back on what opened it.
 * The workbench has no menu of its own to lend, so it lives here. */
export function FileMenu({ anchor, label, items, dismiss }: { anchor: MenuAnchor; label: string; items: readonly MenuItem[]; dismiss(): void }) {
  const self = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    // Unplaced for one layout pass: measured, then positioned.
    if (self.current) setPosition(place(anchor, self.current));
  }, [anchor]);
  useEffect(() => {
    const menu = self.current;
    if (!menu) return undefined;
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')?.focus({ preventScroll: true });
    // Capture: an Escape here must not also close the region behind the menu, and a press on a row
    // must dismiss the menu before that row's own handlers act.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') { latest.current(); return; }
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        latest.current();
        anchor.returnTo.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, capture);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, capture);
    };
  }, [anchor]);
  /** The menu pattern's keys: the arrows and their ends move between choices; a choice closes it. */
  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const choices = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(choices)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = event.key === 'ArrowDown' ? items[(at + 1) % items.length] : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
  // Events of a portal bubble to nothing of the tree, but a press must not reach the pane's own drag.
  const alone = (event: { stopPropagation(): void }): void => event.stopPropagation();
  return createPortal(
    <div ref={self} role="menu" aria-label={label} className={styles.menu}
      style={position ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}
      onPointerDown={alone} onClick={alone} onAuxClick={alone} onKeyDown={event => { alone(event); navigate(event); }}>
      {items.map(item => <Fragment key={item.id}>
        {item.separatorBefore && <div role="separator" className={styles.menuSeparator} />}
        {item.heading
          ? <p className={styles.menuHeading}>{item.label}</p>
          : <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
            className={`${styles.menuItem}${item.danger ? ` ${styles.menuDanger}` : ''}`} disabled={item.disabled}
            onClick={() => { dismiss(); item.run(); }}>
            {item.icon && <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span>}
            <span className={styles.menuLabel}>{item.label}</span>
            {item.checked && <span className={styles.menuCheck} aria-hidden="true"><CheckGlyph /></span>}
          </button>}
      </Fragment>)}
    </div>,
    document.body,
  );
}

/** The radio choice's check mark. */
function CheckGlyph() {
  return <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" vectorEffect="non-scaling-stroke" /></svg>;
}
