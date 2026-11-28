import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import type { FilePreview } from '@aork/contracts/workspace';
import { baseName } from './file-tree.js';
import type { TreeState } from './file-store.js';
import { failureText, fileJson } from './file-resource.js';
import styles from './files.module.css';

/** Lines read at a time. A file is edited only where its whole text is shown. */
const PAGE = 500;

export interface FileEditorProps {
  runtime: UiRuntime;
  workspaceId: string;
  path: string;
  /** The first line shown, 1-based: the reader's place in a file longer than a page. */
  line: number;
  state: TreeState;
  update(mutate: (state: TreeState) => void): void;
  writable: boolean;
  onLine(line: number): void;
  /** The file was saved, so what lists it, and any search that matched it, is out of date. */
  onSaved(path: string): void;
  /** Gives the front back to the tree, which takes keyboard focus on the editor's file. */
  onBack(): void;
}

/** The editor pane of the Files view: a file's numbered source, and the means to rewrite it. What
 * it shows is the file service's own bounded text, so a page is never more than `PAGE` lines. */
export function FileEditor({ runtime, workspaceId, path, line, state, update, writable, onLine, onSaved, onBack }: FileEditorProps) {
  // What was read, and which file and page it answers to: an answer to an earlier one is not shown.
  const [read, setRead] = useState<{ file: string; value: FilePreview }>();
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The editor's own re-reads, after a save.
  const [again, setAgain] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const drawn = useRef<string | undefined>(undefined);
  const file = `${path}\0${line}`;
  const value = read?.file === file ? read.value : undefined;

  useLayoutEffect(() => {
    let live = true;
    const changed = drawn.current !== file;
    drawn.current = file;
    setRead(undefined);
    setFailure('');
    // Another file, or another page of this one, ends an edit, with what was said of the one before.
    // Reading the same page again does not.
    if (changed) {
      update(next => { next.editing = false; next.draft = ''; });
      setError('');
      setNotice('');
    }
    void fileJson<FilePreview>(runtime, workspaceId, 'workspace.preview', { path, startLine: String(line), lines: String(PAGE) })
      .then(answer => { if (live) setRead({ file, value: answer }); }, (cause: unknown) => { if (live) setFailure(failureText(cause)); });
    return () => { live = false; };
  }, [runtime, workspaceId, path, line, file, state.editorRefresh, again, update]);

  // 编辑 on a row waits for the file to be read, then begins the edit with what was read.
  useEffect(() => {
    if (!state.editOnLoad || !value) return;
    update(next => {
      next.editOnLoad = false;
      if (value.editable && writable) { next.draft = value.text; next.editing = true; }
    });
    if (!value.editable || !writable) setError(value.editable ? '工作区不可写，无法编辑。' : '这里只显示了文件的一部分，无法编辑；请从第 1 行打开，或下载后修改。');
  }, [state.editOnLoad, value, update, writable]);
  useEffect(() => { if (state.editing) area.current?.focus({ preventScroll: true }); }, [state.editing, path]);

  function toggleEdit(): void {
    if (!value?.editable) return;
    update(next => {
      if (next.editing) next.editing = false;
      else if (writable) { next.draft = value.text; next.editing = true; }
    });
  }
  async function save(): Promise<void> {
    if (!value?.editable || !writable || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // The revision read is the one saved over: the file service refuses a file changed since.
      await fileJson(runtime, workspaceId, 'workspace.text', { path, expectedRevision: value.revision }, new TextEncoder().encode(state.draft));
      update(next => { next.editing = false; });
      setAgain(count => count + 1);
      setNotice('文件已保存');
      onSaved(path);
    } catch (cause) { setError(failureText(cause)); }
    finally { setBusy(false); }
  }

  return <section className={styles.editor} aria-label="文件编辑">
    <div className={styles.editorTools}>
      <button type="button" className={styles.backTree} onClick={onBack}>返回文件树</button>
      <strong className={styles.editorName} title={path}>{baseName(path)}</strong>
      {value && !state.editing && <span className={styles.lines}>第 {value.startLine}–{Math.min(value.startLine + PAGE - 1, value.totalLines)} 行 / 共 {value.totalLines} 行</span>}
      {value?.editable && (state.editing || writable) && <button type="button" className={styles.textButton} disabled={busy} onClick={toggleEdit}>{state.editing ? '取消编辑' : '编辑文本'}</button>}
      {state.editing && <button type="button" className={styles.textButton} disabled={busy || !writable} onClick={() => void save()}>保存文件</button>}
    </div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {state.editing
      ? <textarea ref={area} className={styles.text} aria-label="文件文本" spellCheck={false} value={state.draft} disabled={busy} onChange={event => update(next => { next.draft = event.target.value; })} />
      : value && <pre className={styles.code} data-file-source={path}>{value.text.split('\n').map((text, index) => <div className={styles.sourceLine} key={index}><span className={styles.line} aria-hidden="true">{value.startLine + index}</span><code>{text || ' '}</code></div>)}</pre>}
    {value?.truncated && <div className={styles.page}>
      <button type="button" className={styles.textButton} disabled={value.startLine <= 1} onClick={() => onLine(Math.max(1, value.startLine - PAGE))}>前 {PAGE} 行</button>
      <button type="button" className={styles.textButton} disabled={value.startLine + PAGE > value.totalLines} onClick={() => onLine(value.startLine + PAGE)}>后 {PAGE} 行</button>
    </div>}
    {failure && <p role="alert" className={styles.error}>{failure}</p>}
    {!value && !failure && !state.editing && <p role="status" className={styles.note}>正在读取…</p>}
  </section>;
}
