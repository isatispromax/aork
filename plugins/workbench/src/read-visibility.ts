import { READ_VISIBILITY_ATTRIBUTE } from '@aork/contracts/workbench';

/** Presentation-only visibility. No Session state or private component names. */
interface WatchedContent {
    element: HTMLElement;
    intersects: boolean;
    last?: boolean;
    changed(visible: boolean): void;
}
export interface ReadableContentObserver { readable(): boolean; dispose(): void }
const watched = new Map<Element, WatchedContent>();
let intersection: IntersectionObserver | undefined;
let mutations: MutationObserver | undefined;
let frame: number | undefined;

function semanticallyVisible(element: HTMLElement): boolean {
    if (!element.isConnected || document.visibilityState !== 'visible') return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.inert || ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true'
            || ancestor.getAttribute(READ_VISIBILITY_ATTRIBUTE) === 'covered') return false;
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    // Native showModal blocks its background without adding an [inert] attribute.
    const modal = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].find(value => value.contains(document.activeElement))
        ?? document.querySelector<HTMLDialogElement>('dialog:modal');
    if (modal && !modal.contains(element)) return false;
    // Independent layouts can use standard ARIA modality too. Hidden/offstage
    // surfaces do not block anything; a rendered modal blocks content outside it.
    for (const layer of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
        if (layer.contains(element) || layer.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
        const rect = layer.getBoundingClientRect();
        const style = getComputedStyle(layer);
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
            && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0) return false;
    }
    return true;
}
function readable(content: WatchedContent): boolean {
    if (!content.intersects || !semanticallyVisible(content.element)) return false;
    const bounds = content.element.getBoundingClientRect();
    const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
    const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
    if (right <= left || bottom <= top) return false;
    // A geometric intersection can be behind another surface. Hit-test the
    // actual visible area, without relying on a private layout/component tree.
    // Non-hit-tested covers must declare their owned covered-content scope via
    // the public presentation attribute (or inert/aria-hidden/modal semantics).
    for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
        const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
        if (hit && content.element.contains(hit)) return true;
    }
    return false;
}
function evaluate() {
    frame = undefined;
    for (const content of watched.values()) {
        const visible = readable(content);
        if (visible !== content.last) { content.last = visible; content.changed(visible); }
    }
}
function schedule() { if (frame === undefined) frame = requestAnimationFrame(evaluate); }
function connect() {
    if (intersection) return;
    intersection = new IntersectionObserver(entries => {
        for (const value of entries) {
            const content = watched.get(value.target);
            if (content) content.intersects = value.isIntersecting && value.intersectionRatio > 0;
        }
        schedule();
    });
    // One scoped observer for all replies, rather than one document watcher per
    // history row. Semantic/DOM changes include portals and layer removal, so
    // uncovering rechecks content without a new domain event or a guessed timer.
    mutations = new MutationObserver(schedule);
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['inert', 'hidden', 'aria-hidden', 'aria-modal', 'open', 'style', 'class', READ_VISIBILITY_ATTRIBUTE] });
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
}
function disconnectIfUnused() {
    if (watched.size) return;
    intersection?.disconnect(); intersection = undefined;
    mutations?.disconnect(); mutations = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined;
    document.removeEventListener('visibilitychange', schedule);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('transitionend', schedule, true);
    document.removeEventListener('animationend', schedule, true);
}
export function observeReadableContent(element: HTMLElement, changed: (visible: boolean) => void): ReadableContentObserver {
    const content: WatchedContent = { element, intersects: false, changed };
    watched.set(element, content); connect(); intersection!.observe(element);
    return { readable: () => watched.get(element) === content && readable(content), dispose() {
        if (watched.get(element) !== content) return;
        intersection?.unobserve(element); watched.delete(element); disconnectIfUnused();
    } };
}
