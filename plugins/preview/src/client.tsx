/** The document preview panel type of the right region: a Workspace file shown for what it is —
 * Markdown rendered, source coloured, an image, a PDF or a page in a sandbox — one tab per file,
 * in the shape of deepseek-harness's document preview (ui-sidebar-documentpreview; MIT). The panel
 * reads through the public `workspace.file` resource and renders entirely in the browser; it
 * sends nothing to the Host and keeps what it read only while its tab is open. */
import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { DockGlyph } from '@aork/dock';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { baseName, previewForms, previewLanguage, resolveWorkspaceLink } from './kinds.js';
import { codeLines } from './lines.js';
import { decodePreviewText, PREVIEW_TEXT_LIMIT } from './text.js';
import { sourceTokens } from './render.js';
import { renderMarkdown } from './markdown.js';
import { forgetPreview, readingOf, rememberReading, rememberView, viewOf } from './store.js';
import styles from './preview.module.css';

type Tab = InspectorTabContext['tab'];

/** What a body currently holds of its file. */
type Load =
  | { readonly status: 'unread' }
  | { readonly status: 'reading' }
  | { readonly status: 'ready'; readonly bytes: Uint8Array; readonly text: ReturnType<typeof decodePreviewText> | undefined }
  | { readonly status: 'failed'; readonly message: string };

/** The frame policy of a rendered Workspace page: scripts only. Without the same-origin grant the
 * frame is an opaque origin that can neither read the workbench's session nor act for the user,
 * and without top navigation or popups it cannot take the workbench's place. */
export const PREVIEW_PAGE_SANDBOX = 'allow-scripts';

const cx = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ');
const failureText = (failure: unknown): string => failure instanceof Error ? failure.message : '文件读取失败';

// Switching tabs unmounts bodies too, so what a tab read is dropped on the one event that means
// the tab is gone rather than merely out of sight: its signal.
const watched = new WeakSet<AbortSignal>();
function releaseOnClose(tab: Tab): void {
  if (watched.has(tab.signal)) return;
  watched.add(tab.signal);
  tab.signal.addEventListener('abort', () => { forgetPreview(tab.id); }, { once: true });
}

/** The Workspace selected in the address, by the key the public URL contract gives it. Read here
 * rather than through the contract module, which would carry the Workspace schemas into the
 * browser bundle for the sake of one name. */
function selectedWorkspace(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('workspace') || undefined;
}

function useHash(): string {
  const [value, setValue] = useState(() => location.hash);
  useEffect(() => {
    const changed = (): void => { setValue(location.hash); };
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  return value;
}

/* Glyphs: the docking kit's stroke, so the toolbar reads as the strip above it. */
function WrapGlyph(): ReactNode {
  return <DockGlyph><path d="M3 4.5h7a2 2 0 0 1 0 4H6a2 2 0 0 0 0 4h7" /><path d="M10.5 6.5l2 2-2 2M10.5 10.5l2 2-2 2" /></DockGlyph>;
}
function ReloadGlyph(): ReactNode {
  return <DockGlyph><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.8 2.4v2.4h-2.4" /></DockGlyph>;
}
function DownloadGlyph(): ReactNode {
  return <DockGlyph><path d="M8 2.5v7.5M4.5 7L8 10.5 11.5 7M3 13.5h10" /></DockGlyph>;
}

/** A browser address for bytes shown as they are — an image, a PDF — released when the bytes are
 * replaced and when the body unmounts. A body mounted again asks anew. */
function useObjectUrl(bytes: Uint8Array | undefined, mime: string | undefined): string | undefined {
  const url = useMemo(() => (bytes && mime ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })) : undefined), [bytes, mime]);
  useEffect(() => () => { if (url !== undefined) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function PreviewBody({ runtime, context }: ViewProps) {
  const tab = (context as InspectorTabContext | undefined)?.tab;
  const path = tab?.content;
  const hash = useHash();
  const workspaceId = selectedWorkspace(hash);
  // The chip names the file; until a body mounts it reads the type's label.
  useEffect(() => { if (tab && path !== undefined) tab.setTitle(baseName(path)); }, [tab, path]);
  if (!tab || path === undefined) return <p className={styles.orphan} role="status">预览面板只能显示在右侧栏的标签里，并需要指向一个工作区文件。</p>;
  // One body is one tab: what it read is looked up once, and it never has to follow another file.
  return <PreviewFile key={tab.id} runtime={runtime} tab={tab} path={path} workspaceId={workspaceId} />;
}

function PreviewFile({ runtime, tab, path, workspaceId }: { runtime: UiRuntime; tab: Tab; path: string; workspaceId: string | undefined }) {
  const forms = useMemo(() => previewForms(path), [path]);
  // A file whose suffix is known to hold nothing renderable is named, never read.
  const unpreviewable = forms.length === 0;
  // Whether a way of showing this file reads its bytes as text.
  const readsText = useMemo(() => forms.some(form => !form.binary), [forms]);
  const [view, setView] = useState(() => viewOf(tab.id) ?? { form: 0, wrap: false });
  const form = forms[Math.min(view.form, forms.length - 1)];
  const [load, setLoad] = useState<Load>(() => {
    const saved = workspaceId === undefined ? undefined : readingOf(tab.id);
    return saved !== undefined && saved.workspaceId === workspaceId && saved.path === path
      ? { status: 'ready', bytes: saved.bytes, text: saved.text }
      // A file the panel cannot show, or no Workspace to read from, is never read at all.
      : { status: 'unread' };
  });
  // 重新读取 asks for the file again; a body mounted again shows what was read before.
  const [attempt, setAttempt] = useState(0);
  const [downloadFailure, setDownloadFailure] = useState('');

  useEffect(() => { releaseOnClose(tab); }, [tab]);
  useEffect(() => {
    if (unpreviewable || workspaceId === undefined) return;
    const saved = readingOf(tab.id);
    if (attempt === 0 && saved?.workspaceId === workspaceId && saved.path === path) return;
    let live = true;
    setLoad({ status: 'reading' });
    setDownloadFailure('');
    void runtime.resource('workspace.file', { workspaceId, path }).then((result) => {
      if (!live) return;
      const bytes = result.bytes;
      const text = readsText ? decodePreviewText(bytes) : undefined;
      rememberReading(tab.id, { workspaceId, path, bytes, text });
      setLoad({ status: 'ready', bytes, text });
    }, (failure: unknown) => {
      if (live) setLoad({ status: 'failed', message: failureText(failure) });
    });
    return () => { live = false; };
  }, [runtime, tab.id, workspaceId, path, unpreviewable, readsText, attempt]);

  const ready = load.status === 'ready' ? load : undefined;
  const text = ready?.text;
  // Where Markdown cannot be rendered safely its source stands in.
  const markdown = useMemo(() => (text?.ok === true ? renderMarkdown(text.text) : undefined), [text]);
  const shown = form?.way === 'markdown' && markdown === undefined ? forms.find(item => item.way === 'code') ?? form : form;
  const language = previewLanguage(path);
  const lines = useMemo(() => {
    if (text?.ok !== true || shown?.way !== 'code') return undefined;
    return codeLines(sourceTokens(text.text, language));
  }, [text, shown, language]);
  const address = useObjectUrl(ready?.bytes, shown?.binary ? shown.mime : undefined);

  /** Shows the file another way; whether source wraps carries over to the way chosen. */
  function choose(next: number): void {
    const chosen = { form: next, wrap: view.wrap };
    setView(chosen);
    rememberView(tab.id, chosen);
  }
  function toggleWrap(): void {
    const chosen = { form: view.form, wrap: !view.wrap };
    setView(chosen);
    rememberView(tab.id, chosen);
  }
  async function download(): Promise<void> {
    setDownloadFailure('');
    try {
      if (workspaceId === undefined) throw new Error('请先选择一个工作区。');
      // What was read is downloaded as it is; a file the panel cannot show is read for this alone.
      const bytes = ready?.bytes ?? (await runtime.resource('workspace.file', { workspaceId, path })).bytes;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = baseName(path).replace(/[\x00-\x1f\x7f/\\]/g, '_') || 'download';
      link.rel = 'noopener noreferrer';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setDownloadFailure(failureText(failure)); }
  }
  /** A link in a rendered document that names a Workspace file opens that file in its own tab;
   * everything else — another site, a fragment — keeps the link's own behaviour. */
  function follow(event: MouseEvent<HTMLElement>): void {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return;
    const target = resolveWorkspaceLink(path, href);
    if (target === undefined) return;
    event.preventDefault();
    tab.open('preview', target);
  }
  const tool = (name: string, onClick: () => void, glyph: ReactNode, options: { pressed?: boolean; disabled?: boolean } = {}) => (
    <button type="button" className={cx(styles.tool, options.pressed && styles.toolOn)} aria-label={name} title={name}
      // A toggle says which way it stands at all times; a plain action says nothing.
      aria-pressed={options.pressed === undefined ? undefined : options.pressed} disabled={options.disabled} onClick={onClick}>{glyph}</button>
  );
  const name = baseName(path);
  const missing = workspaceId === undefined;
  return (
    <div className={styles.root} data-dock-fill role="region" aria-label="文档预览" data-preview-form={shown?.way ?? 'none'} data-preview-path={path} aria-busy={load.status === 'reading'}>
      <div className={styles.toolbar}>
        <span className={styles.name} title={path}>{name}</span>
        {forms.length > 1 && (
          <label className={styles.openWith}>打开方式
            <select aria-label="打开方式" value={Math.min(view.form, forms.length - 1)} onChange={(event) => { choose(Number(event.currentTarget.value)); }}>
              {forms.map((item, index) => <option key={item.way} value={index}>{item.label}</option>)}
            </select>
          </label>
        )}
        {shown && !shown.binary && tool('自动换行', toggleWrap, <WrapGlyph />, { pressed: view.wrap })}
        {!unpreviewable && tool('重新读取', () => { setAttempt(value => value + 1); }, <ReloadGlyph />)}
        {tool('下载', () => { void download(); }, <DownloadGlyph />)}
      </div>
      {downloadFailure && <p className={styles.failure} role="alert">下载失败：{downloadFailure}</p>}
      <div className={styles.content}>
        {missing && <p className={styles.notice} role="status">请先选择一个工作区。</p>}
        {!missing && unpreviewable && (
          <div className={styles.notice}>
            <p role="status">该格式文件暂时无法预览</p>
            <p className={styles.hint}>可以下载后用其他应用打开。</p>
          </div>
        )}
        {load.status === 'failed' && <p className={styles.failure} role="alert">读取失败：{load.message}</p>}
        {load.status === 'reading' && <p className={styles.notice} role="status">正在读取…</p>}
        {ready && shown !== undefined && !shown.binary && text !== undefined && !text.ok && (
          <p className={styles.notice} role="status">{text.reason === 'too-large' ? `文本超过 ${PREVIEW_TEXT_LIMIT / 1024} KiB，无法预览；请下载查看。` : '这个文件不是 UTF-8 文本，无法这样预览；请下载查看。'}</p>
        )}
        {ready && shown?.way === 'markdown' && markdown !== undefined && (
          // Sanitised in markdown.ts before it gets here; the page has no policy of its own to lean on.
          <article className={styles.markdown} onClick={follow} dangerouslySetInnerHTML={{ __html: markdown }} />
        )}
        {ready && shown?.way === 'code' && lines !== undefined && (
          <pre className={cx(styles.code, view.wrap && styles.codeWrap)} data-preview-code={language} tabIndex={0}><code>
            {lines.map((tokens, index) => <span className={styles.line} key={index}><span className={styles.number} aria-hidden="true">{index + 1}</span><span className={styles.source}>{tokens.map((token, at) => {
              // A scope may name a language-specific class after the colourer's own; the first colours.
              const scope = token.scope === undefined ? undefined : styles[token.scope.split(/\s+/)[0]!];
              return scope === undefined ? token.text : <span className={scope} key={at}>{token.text}</span>;
            })}</span></span>)}
          </code></pre>
        )}
        {ready && shown?.way === 'image' && address !== undefined && (
          <div className={styles.picture}><img className={styles.image} src={address} alt={name} data-preview-image /></div>
        )}
        {ready && shown?.way === 'pdf' && address !== undefined && !navigator.pdfViewerEnabled && (
          <div className={styles.notice}>
            <p role="status">当前浏览器不能内嵌显示 PDF</p>
            <p className={styles.hint}>请下载后用其他应用打开。</p>
          </div>
        )}
        {ready && shown?.way === 'pdf' && address !== undefined && navigator.pdfViewerEnabled && (
          <iframe className={styles.frame} src={address} title="PDF 预览" data-preview-frame="pdf" />
        )}
        {ready && shown?.way === 'html' && text?.ok === true && (
          <iframe className={styles.frame} srcDoc={text.text} sandbox={PREVIEW_PAGE_SANDBOX} title="网页预览" referrerPolicy="no-referrer" data-preview-frame="page" />
        )}
      </div>
    </div>
  );
}

export function activate(context: ClientPluginContext) {
  context.registerExtension('preview', PreviewBody);
}
