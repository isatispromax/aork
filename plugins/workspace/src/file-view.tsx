import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ViewProps } from '@aork/sdk/client';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { FileListing, FileSearch, FilePreview, WorkspaceOverview } from '@aork/contracts/workspace';
import styles from './files.module.css';
function route() { const hash = new URLSearchParams(location.hash.slice(1)); return { id: hash.get('workspace') ?? '', directory: hash.get('directory') ?? '', file: hash.get('file') ?? '', line: hash.get('line') ?? '1' }; }
function navigate(directory: string, file = '', line = '1') {
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const [key, value] of Object.entries({ directory, file, line: line === '1' ? '' : line })) {
    if (value) hash.set(key, value);
    else hash.delete(key);
  }
  location.hash = hash.toString();
}
const failureText = (failure: unknown) => failure instanceof Error ? failure.message : '文件操作失败';
export function FileView(props: ViewProps) {
  const [selected, setSelected] = useState(route);
  useEffect(() => {
    const change = () => setSelected(route());
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);
  return selected.id ? <WorkspaceFiles key={selected.id} {...props} selected={selected} /> : null;
}

function WorkspaceFiles({ runtime, context, selected }: ViewProps & { selected: ReturnType<typeof route> }) {
  const panel=Boolean(context&&typeof context==='object'&&'panel' in context&&context.panel===true);const wide=Boolean(context&&typeof context==='object'&&'wide' in context&&context.wide===true);
  const [previewOpen,setPreviewOpen]=useState(()=>Boolean(selected.file));const fileTree=useRef<HTMLUListElement>(null);const previewBack=useRef<HTMLButtonElement>(null);const restoreTreeFocus=useRef(false);const composing=useRef(false);
  const [overview, setOverview] = useState<WorkspaceOverview>();
  const [listing, setListing] = useState<FileListing | FileSearch>();
  const [preview, setPreview] = useState<FilePreview>();
  const [accessError, setAccessError] = useState('');
  const [listingError, setListingError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [listingRefresh, setListingRefresh] = useState(0);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchScope, setSearchScope] = useState<{ directory: string; term: string }>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState('');
  const search = searchScope?.directory === selected.directory ? searchScope.term : '';
  useLayoutEffect(() => { setPreviewOpen(Boolean(selected.file)); }, [selected.file]);
  useLayoutEffect(()=>{
    if(!panel)return;
    if(previewOpen){
      restoreTreeFocus.current=false;
      if(previewBack.current?.getClientRects().length)previewBack.current.focus();
    }else if(restoreTreeFocus.current){
      restoreTreeFocus.current=false;
      const target=fileTree.current?.querySelector<HTMLElement>(`button[data-file-path=${CSS.escape(selected.file)}]`);
      if(target?.getClientRects().length)target.focus();
    }
  },[panel,previewOpen,selected.file,selected.id]);
  const selectionKey = JSON.stringify(selected);
  const operationScope = useRef(0);
  const workspace = overview?.workspaces.find(item => item.id === selected.id); const writable = workspace?.access === 'read-write' && workspace.status === 'open';
  useEffect(() => {
    const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', {
      next(value) { setOverview(value); setAccessError(''); },
      error(failure) { setAccessError(failure.message); },
    });
    return () => { void unsubscribe(); };
  }, [runtime]);
  async function json<T>(name: string, parameters: Record<string, string>, bytes?: Uint8Array): Promise<T> { const result = await runtime.resource(name, { workspaceId: selected.id, ...parameters }, bytes); return JSON.parse(new TextDecoder().decode(result.bytes)) as T; }
  useLayoutEffect(() => {
    let active = true;
    setListing(undefined);
    setListingError('');
    const read = search ? json<FileSearch>('workspace.search', { query: search }) : json<FileListing>('workspace.files', { path: selected.directory });
    void read.then(value => { if (active) setListing(value); }).catch(failure => { if (active) setListingError(failureText(failure)); });
    return () => { active = false; };
  }, [runtime, selected.id, selected.directory, search, listingRefresh]);
  useLayoutEffect(() => {
    let active = true;
    setPreview(undefined);
    setPreviewError('');
    setEditing(false);
    setDraft('');
    if (selected.file) {
      void json<FilePreview>('workspace.preview', { path: selected.file, startLine: selected.line, lines: '500' })
        .then(value => { if (active) setPreview(value); })
        .catch(failure => { if (active) setPreviewError(failureText(failure)); });
    }
    return () => { active = false; };
  }, [runtime, selected.id, selected.file, selected.line, previewRefresh]);
  useLayoutEffect(() => {
    operationScope.current++;
    setOperationError('');
    setNotice('');
    return () => { operationScope.current++; };
  }, [selectionKey]);
  function refreshFiles() {
    setListingRefresh(value => value + 1);
    if (!editing) setPreviewRefresh(value => value + 1);
    setOperationError('');
    setNotice('');
  }
  async function perform(operation: (isCurrent: () => boolean) => Promise<void>) {
    if (busy) return;
    const scope = operationScope.current;
    const isCurrent = () => operationScope.current === scope && selectionKey === JSON.stringify(route());
    setBusy(true);
    setOperationError('');
    setNotice('');
    try { await operation(isCurrent); }
    catch (failure) { if (isCurrent()) setOperationError(failureText(failure)); }
    finally { setBusy(false); }
  }
  function searchFiles(event: FormEvent) {
    event.preventDefault();
    const term = searchInput.trim();
    if (!term) return;
    if (term === search) setListingRefresh(value => value + 1);
    else setSearchScope({ directory: selected.directory, term });
  }
  async function download() {
    await perform(async isCurrent => {
      const result = await runtime.resource('workspace.file', { workspaceId: selected.id, path: selected.file });
      if (!isCurrent()) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = selected.file.split('/').at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function save() {
    if (!preview?.editable || !writable) return;
    await perform(async isCurrent => {
      await json('workspace.text', { path: selected.file, expectedRevision: preview.revision }, new TextEncoder().encode(draft));
      if (isCurrent()) {
        setListingRefresh(value => value + 1);
        setPreviewRefresh(value => value + 1);
        setNotice('文件已保存');
      }
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const path = selected.directory ? `${selected.directory}/${newName}` : newName;
    await perform(async isCurrent => {
      await json('workspace.file', { path }, new Uint8Array());
      if (isCurrent()) {
        setNewName('');
        setSearchScope(undefined);
        setListingRefresh(value => value + 1);
        navigate(selected.directory, path);
      }
    });
  }
  async function upload(file: File) {
    await perform(async isCurrent => {
      if (file.size > FILE_LIMITS.transferBytes) throw new Error('上传文件最多 8 MiB');
      const path = selected.directory ? `${selected.directory}/${file.name}` : file.name;
      await json('workspace.file', { path }, new Uint8Array(await file.arrayBuffer()));
      if (isCurrent()) {
        setListingRefresh(value => value + 1);
        setNotice('文件已上传');
      }
    });
  }
  return <section className={`${styles.files} ${panel?styles.panel:''}`} data-wide={wide} data-preview={previewOpen} aria-label="工作区文件">
    <header className={styles.heading}><h3>文件</h3><button disabled={busy} onClick={refreshFiles}>刷新文件</button></header>
    <div className={styles.toolbar}><form onSubmit={searchFiles}><input aria-label="搜索文件名" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing))event.preventDefault();}} placeholder="搜索文件名" maxLength={120} value={searchInput} onChange={event => setSearchInput(event.target.value)} /><button disabled={busy || !searchInput.trim()}>搜索</button>{search && <button type="button" onClick={() => { setSearchScope(undefined); setSearchInput(''); }}>清除搜索</button>}</form>
      <label className={styles.upload}>上传文件<input aria-label="上传文件" type="file" disabled={busy || !writable} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void upload(file);
      }} /></label>
    </div>
    {accessError && <p role="alert" className={styles.error}>{accessError}</p>}
    {operationError && <p role="alert" className={styles.error}>{operationError}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className={styles.panels}><div className={styles.tree}>
      <div className={styles.breadcrumb}><button disabled={!selected.directory} onClick={() => navigate('')}>根目录</button><span>{selected.directory || '/'}</span>{selected.directory && <button onClick={() => navigate(selected.directory.split('/').slice(0, -1).join('/'))}>上一级</button>}</div>
      {listingError && <p role="alert" className={styles.error}>{listingError}</p>}
      {!listing && !listingError && <p role="status">{search ? '正在搜索文件…' : '正在读取文件…'}</p>}
      {listing && !listing.entries.length && <p className={styles.hint}>{search ? '没有匹配的文件。' : '此目录为空。'}</p>}
      <ul ref={fileTree}>{listing?.entries.map(item => <li key={item.path}><button data-file-path={item.path} disabled={busy || item.kind === 'symlink' || item.kind === 'other'} aria-current={selected.file === item.path ? 'page' : undefined} onClick={() => {if(item.kind==='directory')navigate(item.path);else{setPreviewOpen(true);navigate(selected.directory,item.path);}}}><span aria-hidden="true">{item.kind === 'directory' ? '▱' : item.kind === 'symlink' ? '↗' : '·'}</span><span>{search ? item.path : item.name}</span><small>{item.kind === 'directory' ? '目录' : item.kind === 'symlink' ? '链接不可访问' : `${item.size} B`}</small></button></li>)}</ul>
      {listing?.truncated && <p role="status">结果达到上限，请缩小目录或搜索范围。</p>}
      {writable && <form className={styles.newFile} onSubmit={create}><input aria-label="新建文本文件名称" placeholder="新建文件名" required maxLength={255} pattern="[^/\\\\]+" value={newName} onChange={event => setNewName(event.target.value)} /><button disabled={busy}>新建</button></form>}
    </div><div className={styles.preview}>
      {selected.file ? <>{panel&&<button ref={previewBack} type="button" className={styles.backTree} onClick={()=>{restoreTreeFocus.current=true;setPreviewOpen(false);}}>返回文件树</button>}<div className={styles.fileHeading}><strong>{selected.file}</strong><button disabled={busy} onClick={() => void download()}>下载</button></div>
        {preview && <><div className={styles.editorTools}><span>第 {preview.startLine}–{Math.min(preview.startLine + 499, preview.totalLines)} 行 / 共 {preview.totalLines} 行</span>{preview.editable && (editing || writable) && <button disabled={busy} onClick={() => { setDraft(preview.text); setEditing(value => !value); }}>{editing ? '取消编辑' : '编辑文本'}</button>}{editing && <button disabled={busy || !writable} onClick={() => void save()}>保存文件</button>}</div>
          {editing ? <textarea className={styles.editor} aria-label="文件文本" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} /> : <pre className={styles.code}>{preview.text.split('\n').map((line, index) => <div key={index}><span className={styles.line}>{preview.startLine + index}</span><code>{line || ' '}</code></div>)}</pre>}
          {preview.truncated && <div className={styles.page}><button disabled={preview.startLine <= 1} onClick={() => navigate(selected.directory, selected.file, String(Math.max(1, preview.startLine - 500)))}>前 500 行</button><button disabled={preview.startLine + 500 > preview.totalLines} onClick={() => navigate(selected.directory, selected.file, String(preview.startLine + 500))}>后 500 行</button></div>}</>}
        {previewError && <p role="alert" className={styles.error}>{previewError}</p>}
        {!preview && !previewError && <p role="status">正在读取预览…</p>}</> : <p className={styles.hint}>选择文件查看文本或下载。文本最多 256 KiB，每页 500 行；上传与下载最多 8 MiB。符号链接不进入访问范围。</p>}
    </div></div>
  </section>;
}
