import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './session-rows.module.css';

export interface MenuAnchor {
  x: number;
  y: number;
  /** Whether the menu's left edge (`start`) or its right edge (`end`) sits at `x`. */
  align?: 'start' | 'end';
  /** The control that opened the menu. It takes focus back when the menu closes. */
  returnTo: HTMLElement;
}
/** One row of a menu. `separatorBefore` opens a group with a rule; `danger` is the destructive colour. */
export interface MenuItem { id: string; label: string; disabled?: boolean; separatorBefore?: boolean; danger?: boolean; run(): void }

/** The margin the menu keeps from the viewport's edges, however near them the pointer is. */
const MARGIN = 8;

function place(anchor: MenuAnchor, menu: HTMLElement): CSSProperties {
  const wanted = anchor.align === 'end' ? anchor.x - menu.offsetWidth : anchor.x;
  return {
    position: 'fixed',
    left: Math.max(MARGIN, Math.min(wanted, window.innerWidth - menu.offsetWidth - MARGIN)),
    top: Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - MARGIN)),
  };
}

/** A session row's menu, the workspace plugin's file-menu pattern re-drawn against this
 * plugin's styles: above everything, dismissing itself on an outside press or an unmodified
 * Escape, focus back on what opened it. */
export function RowMenu({ anchor, label, items, dismiss }: { anchor: MenuAnchor; label: string; items: readonly MenuItem[]; dismiss(): void }) {
  const self = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    if (self.current) setPosition(place(anchor, self.current));
  }, [anchor]);
  useEffect(() => {
    const menu = self.current;
    if (!menu) return undefined;
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
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
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor]);
  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = event.key === 'ArrowDown' ? items[(at + 1) % items.length] : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
  const alone = (event: { stopPropagation(): void }): void => event.stopPropagation();
  return createPortal(
    <div ref={self} role="menu" aria-label={label} className={styles.menu}
      style={position ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}
      onPointerDown={alone} onClick={alone} onAuxClick={alone} onKeyDown={event => { alone(event); navigate(event); }}>
      {items.map(item => <Fragment key={item.id}>{item.separatorBefore && <div role="separator" className={styles.separator} />}
        <button type="button" role="menuitem" className={`${styles.menuItem}${item.danger ? ` ${styles.danger}` : ''}`} disabled={item.disabled}
          onClick={() => { dismiss(); item.run(); }}>{item.label}</button></Fragment>)}
    </div>,
    document.body,
  );
}
