/** The browser panel type of the right region: HTTP(S) pages in an embedded frame, one tab per
 * open page, in the shape of deepseek-harness's web Browser (ui-sidebar-browser; MIT). The panel
 * keeps its own address history — a frame's history cannot be read across origins — and offers a
 * page that navigated itself as "address changed" instead of guessing where it went. Navigation
 * is saved per Session in the browser; nothing here talks to the Host. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DockGlyph } from '@aork/dock';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { BrowserPage, IDLE_BROWSER_PAGE_STATE, type BrowserPageState } from './page.js';
import type { BrowserAddressFailure } from './url.js';
import { forgetTabState, readTabState, writeTabState } from './store.js';
import styles from './browser.module.css';

type Tab = InspectorTabContext['tab'];

/** What each refusal of an address-bar value says. */
const ADDRESS_ERRORS: Record<BrowserAddressFailure, string> = {
  empty: '请输入地址。',
  invalid: '这个地址无效或过长。',
  protocol: '只支持 HTTP 和 HTTPS 地址。',
  credentials: '地址不能包含用户名或密码。',
  'application-origin': '不能在嵌入浏览器中打开 Aork 自身。',
};

/** One page per open browser tab, kept while the tab is open — tab switches and Session changes
 * only unmount bodies — and dropped, with its saved navigation, when the tab closes. */
const pages = new Map<string, BrowserPage>();
function pageFor(tab: Tab): BrowserPage {
  const key = `${tab.sessionId}\u0000${tab.content ?? tab.id}`;
  const found = pages.get(key);
  if (found) return found;
  const id = tab.content ?? tab.id;
  const page = new BrowserPage(
    { initial: readTabState(tab.sessionId, id), persist: (state) => { writeTabState(tab.sessionId, id, state); } },
    location.origin,
  );
  pages.set(key, page);
  tab.signal.addEventListener('abort', () => {
    pages.delete(key);
    page.dispose();
    forgetTabState(tab.sessionId, id);
  }, { once: true });
  return page;
}
const NOTHING = (): (() => void) => () => { /* never reports a change */ };
const IDLE = (): BrowserPageState => IDLE_BROWSER_PAGE_STATE;
const cx = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ');

/** The address bar shows the address showing, except while a draft of the same revision is typed. */
function useAddressDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>();
  return [edit?.revision === revision ? edit.value : (url ?? ''), (value: string) => { setEdit({ revision, value }); }];
}

/* Glyphs: the docking kit's stroke, so the toolbar reads as the strip above it. */
function ChevronGlyph({ forward }: { forward?: boolean }): ReactNode {
  return <DockGlyph>{forward ? <path d="M6.5 3.5L11 8l-4.5 4.5" /> : <path d="M9.5 3.5L5 8l4.5 4.5" />}</DockGlyph>;
}
function ReloadGlyph(): ReactNode {
  return <DockGlyph><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.8 2.4v2.4h-2.4" /></DockGlyph>;
}
function GoGlyph(): ReactNode { return <DockGlyph><path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" /></DockGlyph>; }
function ExternalGlyph(): ReactNode {
  return <DockGlyph><path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" /><path d="M9.5 2.5h4v4M13.2 2.8L7.5 8.5" /></DockGlyph>;
}
/** A shield that is closed while the frame policy holds and crossed while it is lifted. */
function ShieldGlyph({ held }: { held: boolean }): ReactNode {
  return <DockGlyph><path d="M8 2l4.5 1.6v3.7c0 2.9-1.9 5.2-4.5 6.2-2.6-1-4.5-3.3-4.5-6.2V3.6z" />{held ? <path d="M5.7 8.1l1.6 1.6 3.1-3.3" /> : <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />}</DockGlyph>;
}

/** The panel: a navigation toolbar over the page, with the panel's own notices between them. */
function BrowserBody({ context }: ViewProps) {
  const tab = (context as InspectorTabContext | undefined)?.tab;
  // One body is one tab: its page is found once, and this body never has to follow another identity.
  const [page] = useState(() => (tab ? pageFor(tab) : undefined));
  const state = useSyncExternalStore(page?.subscribe ?? NOTHING, page?.getSnapshot ?? IDLE);
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (page && viewport.current ? page.mount(viewport.current) : undefined), [page]);
  // The chip names the host of the page showing; until then it reads the type's label.
  const host = state.target?.title;
  useEffect(() => { if (host !== undefined) tab?.setTitle(host); }, [tab, host]);

  if (!tab || !page) return <p className={styles.orphan} role="status">浏览器面板只能显示在右侧栏的标签里。</p>;

  const unknown = state.address === 'unknown';
  // While the page went somewhere unreadable there is no address to hand to the system browser.
  const externalUrl = unknown ? undefined : state.target?.url;
  const [draft, setDraft] = useAddressDraft(state.target?.url, state.addressRevision);
  const submit = (event: FormEvent): void => { event.preventDefault(); page.loadUrl(draft); };
  const tool = (name: string, disabled: boolean, onClick: () => void, glyph: ReactNode, extra?: string) => (
    <button type="button" className={cx(styles.tool, extra)} aria-label={name} title={name} disabled={disabled} onClick={onClick}>{glyph}</button>
  );
  const showing = state.target !== undefined;
  return (
    <div className={styles.root} data-dock-fill role="region" aria-label="浏览器面板">
      <form className={styles.toolbar} onSubmit={submit}>
        {tool('后退', !state.canGoBack, () => { page.goBack(); }, <ChevronGlyph />)}
        {tool('前进', !state.canGoForward, () => { page.goForward(); }, <ChevronGlyph forward />)}
        {tool('刷新', !showing, () => { page.reload(); }, <ReloadGlyph />)}
        <div className={styles.addressBox}>
          <input
            className={cx(styles.address, unknown && styles.addressUnknown)}
            value={draft}
            aria-label="输入 HTTP(S) 地址"
            placeholder="输入 HTTP(S) 地址"
            spellCheck={false}
            onChange={(event) => { setDraft(event.currentTarget.value); }}
          />
          {unknown && <span className={styles.addressChanged}>URL 已变化</span>}
          <button type="submit" className={cx(styles.tool, styles.addressGo)} aria-label="前往" title="前往"><GoGlyph /></button>
        </div>
        {tool('在系统浏览器中打开', externalUrl === undefined, () => { if (externalUrl !== undefined) window.open(externalUrl, '_blank', 'noopener,noreferrer'); }, <ExternalGlyph />)}
        <button type="button" className={cx(styles.tool, !state.sandboxed && styles.sandboxOff)}
          aria-label={state.sandboxed ? '关闭沙箱限制' : '恢复沙箱限制'} title={state.sandboxed ? '关闭沙箱限制' : '恢复沙箱限制'}
          aria-pressed={!state.sandboxed} onClick={() => { page.setSandbox(!state.sandboxed); }}>
          <ShieldGlyph held={state.sandboxed} />
        </button>
      </form>
      {!state.sandboxed && <div className={styles.sandboxWarning} role="status">沙箱限制已关闭；页面可以导航顶层应用，并使用下载、模态对话框与输入锁定。</div>}
      {state.error !== undefined && <div className={styles.failure} role="status">页面加载失败；请刷新重试或在系统浏览器中打开。</div>}
      {state.addressFailure !== undefined && <div className={styles.failure} role="alert">{ADDRESS_ERRORS[state.addressFailure]}</div>}
      <div className={styles.content} aria-busy={state.loading}>
        <div ref={viewport} className={styles.viewport} />
        {state.restoreTarget !== undefined && (
          <section className={styles.restore} aria-label="上次打开">
            <p className={styles.restoreLabel}>上次打开</p>
            <p className={styles.restoreTitle}>{state.restoreTarget.title}</p>
            <p className={styles.restoreUrl}>{state.restoreTarget.url}</p>
            <button type="button" className={styles.restoreAction} onClick={() => { page.restore(); }}>恢复页面</button>
          </section>
        )}
        {state.restoreTarget === undefined && (!showing || state.loading) && state.error === undefined && (
          <div className={styles.placeholder}><div className={styles.start}>{showing ? '正在打开…' : '输入 HTTP(S) 地址开始浏览'}</div></div>
        )}
      </div>
      {unknown && <p className={styles.limit}>页面已跳转；当前载体无法读取新的 URL。</p>}
    </div>
  );
}

export function activate(context: ClientPluginContext) {
  context.registerExtension('browser', BrowserBody);
}
