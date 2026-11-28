import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './workspace-browser.module.css';

/** How long the pointer rests on a row before its card opens (dsh: 800ms). */
const OPEN_DELAY_MS = 800;
/** How long the card waits once the pointer has left it and its anchor, so it can be entered. */
const GRACE_MS = 140;
/** The card's width and its clearance from the anchor and the viewport's edges. */
const CARD_WIDTH = 244;
const GAP = 8;

/**
 * A card shown after the pointer rests on an anchor: it repeats what the anchor clips (a title, a
 * path) and may carry a small action. It sits beside the anchor's end edge with its top on the
 * anchor's, moving to the start edge, then above or below, when that would cross the viewport.
 * The pointer may cross onto the card; leaving both closes it after a grace period.
 * The shape of deepseek-harness's HoverCard, for a workspace plugin that has no primitives of its own.
 */
export function HoverCard({ anchor, content, disabled, label }: { anchor: ReactNode; content: ReactNode; disabled?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const anchorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef(disabled);
  current.current = disabled;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) { window.clearTimeout(timer.current); setOpen(false); } }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !cardRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const size = cardRef.current.getBoundingClientRect();
    const width = size.width || CARD_WIDTH; const height = size.height || 80;
    let left = rect.right + GAP;
    let top = rect.top;
    if (left + width > window.innerWidth - GAP) {
      left = rect.left - GAP - width;
      // A card that would cover its anchor from the start side waits below it instead.
      if (left < GAP) { left = Math.max(GAP, Math.min(rect.left, window.innerWidth - width - GAP)); top = rect.bottom + GAP; }
    }
    if (top + height > window.innerHeight - GAP) top = Math.max(GAP, rect.top - GAP - height < GAP ? window.innerHeight - height - GAP : rect.top - GAP - height);
    setPosition({ position: 'fixed', left, top });
  }, [open]);
  const arm = (): void => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { if (!current.current) setOpen(true); }, OPEN_DELAY_MS); };
  const leave = (): void => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), GRACE_MS); };
  const hold = (): void => window.clearTimeout(timer.current);
  return <>
    {/* A block wrapper keeps a full-width row full-width; the card measures this box. */}
    <div ref={anchorRef} className={styles.hoverAnchor}
      onPointerEnter={event => { if (event.pointerType !== 'touch') arm(); }} onPointerLeave={leave}>
      {anchor}
    </div>
    {open && createPortal(
      <div ref={cardRef} className={styles.hoverCard} aria-label={label} style={position ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}
        onPointerEnter={hold} onPointerLeave={() => setOpen(false)}>
        {content}
      </div>,
      document.body,
    )}
  </>;
}
