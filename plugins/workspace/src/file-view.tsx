import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ViewProps } from '@aork/sdk/client';
import { FILE_LIMITS } from '@aork/contracts/workspace';
import type { FileListing, FileSearch, FilePreview, WorkspaceOverview } from '@aork/contracts/workspace';
import styles from './files.module.css';
function route() { const hash = new URLSearchParams(location.hash.slice(1)); return { id: hash.get('workspace') ?? '', directory: hash.get('directory') ?? '', file: hash.get('file') ?? '', line: hash.get('line') ?? '1' }; }
function navigate(directory: string, file = '', line = '1') { const hash = new URLSearchParams(location.hash.slice(1)); for (const [key, value] of Object.entries({ directory, file, line })) { if (value && value !== '1') hash.set(key, value); else hash.delete(key); } location.hash = hash.toString(); }
const failureText = (failure: unknown) => failure instanceof Error ? failure.message : '文件操作失败';
export function FileView({ runtime,context }: ViewProps) {
  const panel=Boolean(context&&typeof context==='object'&&'panel' in context&&context.panel===true);const wide=Boolean(context&&typeof context==='object'&&'wide' in context&&context.wide===true);
  const [previewOpen,setPreviewOpen]=useState(()=>Boolean(route().file));const fileTree=useRef<HTMLUListElement>(null);const composing=useRef(false);
  const [selected, setSelected] = useState(route); const [overview, setOverview] = useState<WorkspaceOverview>(); const [listing, setListing] = useState<FileListing | FileSearch>(); const [preview, setPreview] = useState<FilePreview>();
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0); const [searchInput, setSearchInput] = useState(''); const [search, setSearch] = useState(''); const [draft, setDraft] = useState(''); const [editing, setEditing] = useState(false); const [newName, setNewName] = useState('');
  useEffect(()=>{if(selected.file)setPreviewOpen(true);},[selected.file,selected.id]);
  const selectionKey = `${selected.id}:${selected.directory}:${selected.file}:${selected.line}`; const currentKey = useRef(selectionKey); currentKey.current = selectionKey;
  const workspace = overview?.workspaces.find(item => item.id === selected.id); const writable = workspace?.access === 'read-write' && workspace.status === 'open' && overview?.projects.find(item => item.id === workspace.projectId)?.status === 'open';
  useEffect(() => { const change = () => setSelected(route()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', { next: setOverview, error: failure => setError(failure.message) }); return () => { void unsubscribe(); }; }, [runtime]);
  async function json<T>(name: string, parameters: Record<string, string>, bytes?: Uint8Array): Promise<T> { const result = await runtime.resource(name, { workspaceId: selected.id, ...parameters }, bytes); return JSON.parse(new TextDecoder().decode(result.bytes)) as T; }
  useEffect(() => {
    let active = true; setListing(undefined); setError(''); setSearch('');
    void json<FileListing>('workspace.files', { path: selected.directory }).then(value => { if (active) setListing(value); }).catch(failure => { if (active) setError(failureText(failure)); });
    return () => { active = false; };
  }, [runtime, selected.id, selected.directory, refresh]);
  useEffect(() => {
    let active = true; setPreview(undefined); setEditing(false); setDraft('');
    if (selected.file) void json<FilePreview>('workspace.preview', { path: selected.file, startLine: selected.line, lines: '500' }).then(value => { if (active) { setPreview(value); setDraft(value.text); setError(''); } }).catch(failure => { if (active) setError(failureText(failure)); });
    return () => { active = false; };
  }, [runtime, selected.id, selected.file, selected.line, refresh]);
  async function perform(operation: () => Promise<void>) { if (busy) return; const key = currentKey.current; setBusy(true); setError(''); setNotice(''); try { await operation(); } catch (failure) { if (currentKey.current === key) setError(failureText(failure)); } finally { setBusy(false); } }
  async function searchFiles(event: FormEvent) { event.preventDefault(); const key = selectionKey; await perform(async () => { const result = await json<FileSearch>('workspace.search', { query: searchInput }); if (currentKey.current === key) { setSearch(searchInput); setListing(result); } }); }
  async function download() { const key = selectionKey; await perform(async () => { const result = await runtime.resource('workspace.file', { workspaceId: selected.id, path: selected.file }); if (currentKey.current !== key) return; const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: 'application/octet-stream' })); const link = document.createElement('a'); link.href = url; link.download = selected.file.split('/').at(-1)!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); }
  async function save() { const key = selectionKey; await perform(async () => { if (!preview?.editable) return; await json('workspace.text', { path: selected.file, expectedRevision: preview.revision }, new TextEncoder().encode(draft)); if (currentKey.current === key) { setRefresh(value => value + 1); setNotice('文件已保存'); } }); }
  async function create(event: FormEvent) { event.preventDefault(); const path = selected.directory ? `${selected.directory}/${newName}` : newName; const key = selectionKey; await perform(async () => { await json('workspace.file', { path }, new Uint8Array()); if (currentKey.current === key) { setNewName(''); setRefresh(value => value + 1); navigate(selected.directory, path); } }); }
  return <section className={`${styles.files} ${panel?styles.panel:''}`} data-wide={wide} data-preview={previewOpen} aria-label="工作区文件">
    <header className={styles.heading}><h3>文件</h3><button disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新文件</button></header>
    <div className={styles.toolbar}><form onSubmit={searchFiles}><input aria-label="搜索文件名" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing))event.preventDefault();}} placeholder="搜索文件名" maxLength={120} value={searchInput} onChange={event => setSearchInput(event.target.value)} /><button disabled={busy || !searchInput.trim()}>搜索</button>{search && <button type="button" onClick={() => setRefresh(value => value + 1)}>清除搜索</button>}</form>
      <label className={styles.upload}>上传文件<input aria-label="上传文件" type="file" disabled={busy || !writable} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; const key = selectionKey; void perform(async () => { if (file.size > FILE_LIMITS.transferBytes) throw new Error('上传文件最多 8 MiB'); const path = selected.directory ? `${selected.directory}/${file.name}` : file.name; await json('workspace.file', { path }, new Uint8Array(await file.arrayBuffer())); if (currentKey.current === key) { setRefresh(value => value + 1); setNotice('文件已上传'); } }); }} /></label>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className={styles.panels}><div className={styles.tree}>
      <div className={styles.breadcrumb}><button disabled={!selected.directory} onClick={() => navigate('')}>根目录</button><span>{selected.directory || '/'}</span>{selected.directory && <button onClick={() => navigate(selected.directory.split('/').slice(0, -1).join('/'))}>上一级</button>}</div>
      {!listing && !error && <p role="status">正在读取文件…</p>}
      {listing && !listing.entries.length && <p className={styles.hint}>{search ? '没有匹配的文件。' : '此目录为空。'}</p>}
      <ul ref={fileTree}>{listing?.entries.map(item => <li key={item.path}><button data-file-path={item.path} disabled={busy || item.kind === 'symlink' || item.kind === 'other'} aria-current={selected.file === item.path ? 'page' : undefined} onClick={() => {if(item.kind==='directory')navigate(item.path);else{setPreviewOpen(true);navigate(selected.directory,item.path);}}}><span aria-hidden="true">{item.kind === 'directory' ? '▱' : item.kind === 'symlink' ? '↗' : '·'}</span><span>{search ? item.path : item.name}</span><small>{item.kind === 'directory' ? '目录' : item.kind === 'symlink' ? '链接不可访问' : `${item.size} B`}</small></button></li>)}</ul>
      {listing?.truncated && <p role="status">结果达到上限，请缩小目录或搜索范围。</p>}
      {writable && <form className={styles.newFile} onSubmit={create}><input aria-label="新建文本文件名称" placeholder="新建文件名" required maxLength={255} pattern="[^/\\\\]+" value={newName} onChange={event => setNewName(event.target.value)} /><button disabled={busy}>新建</button></form>}
    </div><div className={styles.preview}>
      {selected.file ? <>{panel&&<button className={styles.backTree} onClick={()=>{setPreviewOpen(false);requestAnimationFrame(()=>fileTree.current?.querySelector<HTMLElement>(`button[data-file-path=${CSS.escape(selected.file)}]`)?.focus());}}>返回文件树</button>}<div className={styles.fileHeading}><strong>{selected.file}</strong><button disabled={busy} onClick={() => void download()}>下载</button></div>
        {preview && <><div className={styles.editorTools}><span>第 {preview.startLine}–{Math.min(preview.startLine + 499, preview.totalLines)} 行 / 共 {preview.totalLines} 行</span>{writable && preview.editable && <button disabled={busy} onClick={() => { setDraft(preview.text); setEditing(value => !value); }}>{editing ? '取消编辑' : '编辑文本'}</button>}{editing && <button disabled={busy} onClick={() => void save()}>保存文件</button>}</div>
          {editing ? <textarea className={styles.editor} aria-label="文件文本" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} /> : <pre className={styles.code}>{preview.text.split('\n').map((line, index) => <div key={index}><span className={styles.line}>{preview.startLine + index}</span><code>{line || ' '}</code></div>)}</pre>}
          {preview.truncated && <div className={styles.page}><button disabled={preview.startLine <= 1} onClick={() => navigate(selected.directory, selected.file, String(Math.max(1, preview.startLine - 500)))}>前 500 行</button><button disabled={preview.startLine + 500 > preview.totalLines} onClick={() => navigate(selected.directory, selected.file, String(preview.startLine + 500))}>后 500 行</button></div>}</>}
        {!preview && !error && <p role="status">正在读取预览…</p>}</> : <p className={styles.hint}>选择文件查看文本或下载。文本最多 256 KiB，每页 500 行；上传与下载最多 8 MiB。符号链接不进入访问范围。</p>}
    </div></div>
  </section>;
}
