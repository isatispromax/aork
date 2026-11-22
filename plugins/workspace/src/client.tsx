import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { workspaceOverviewSchema, readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import type { Workspace, WorkspaceOverview } from '@aork/contracts/workspace';
import { sessionsProjectionSchema } from '@aork/contracts/session';
import type { SessionsProjection } from '@aork/contracts/session';
import styles from './workspace.module.css';
import { FileView } from './file-view.js';
import { DirectoryPicker } from './directory-picker.js';

type Action = 'create' | 'edit' | 'archive';
interface FormState { action: Action; commandId: string; name: string; directory: string; access: string; authorized: boolean; workspaceId?: string }
function selection() { return readWorkbenchSelection(location.hash); }
function select(workspaceId?: string) {
  location.hash = withWorkbenchSelection(location.hash, { workspaceId: workspaceId ?? null, sessionId: null, creatingSession: false });
}
function Dialog({ runtime, form, setForm, busy, error, close, submit }: { runtime: UiRuntime; form: FormState; setForm(form: FormState): void; busy: boolean; error: string; close(): void; submit(event: FormEvent<HTMLFormElement>): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); before?.focus(); }; }, []);
  const archive = form.action === 'archive'; const title = ({ create: '新建工作区', edit: '编辑工作区', archive: '归档工作区' })[form.action];
  const update = (key: keyof FormState, value: string | boolean) => setForm({ ...form, [key]: value, commandId: crypto.randomUUID() });
  return <>
    <DirectoryPicker runtime={runtime} visible={pickerOpen} onCancel={() => setPickerOpen(false)} onConfirm={directory => { setPickerOpen(false); setForm({ ...form, directory, commandId: crypto.randomUUID() }); }} />
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit}><h2 id="workspace-dialog-title">{title}</h2>
        {archive ? <p>归档保留工作区、目录和已有记录。</p> : <fieldset disabled={busy}>
          <label>工作区名称<input autoFocus required maxLength={120} value={form.name} onChange={event => update('name', event.target.value)} /></label>
          {form.action === 'create' && <>
            <div className={styles.pickerField}>
              <p className={styles.fieldLabel}>目录</p>
              {form.directory ? <p className={styles.path}>{form.directory}</p> : <p className={styles.hint}>尚未选择目录</p>}
              <div className={styles.pickerRow}><button type="button" onClick={() => setPickerOpen(true)}>{form.directory ? '换个目录' : '选择目录…'}</button></div>
            </div>
            <label>访问权限<select value={form.access} onChange={event => update('access', event.target.value)}><option value="read-write">可读写</option><option value="read-only">只读</option></select></label>
            <label className={styles.check}><input type="checkbox" required checked={form.authorized} onChange={event => update('authorized', event.target.checked)} />授权此目录及其子目录</label>
          </>}
        </fieldset>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <footer><button type="button" disabled={busy} onClick={close}>取消</button><button className={styles.primary} type="submit" disabled={busy}>{busy ? '正在保存…' : archive ? '确认归档' : form.action === 'create' ? '创建' : '保存'}</button></footer>
      </form>
    </dialog>
  </>;
}
function Browser({ runtime, context }: ViewProps) {
  const [overview, setOverview] = useState<WorkspaceOverview>(); const [error, setError] = useState(''); const [chosen, setChosen] = useState(selection); const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState>(); const [busy, setBusy] = useState(false); const [formError, setFormError] = useState('');
  const [projection, setProjection] = useState<SessionsProjection>();
  useEffect(() => { const change = () => setChosen(selection()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { let active = true; const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', { next(value) { if (active) { setOverview(workspaceOverviewSchema.parse(value)); setError(''); } }, error(failure) { if (active) setError(failure.message); } }); return () => { active = false; void unsubscribe(); }; }, [runtime]);
  useEffect(() => { let active = true; const stop = runtime.observeSnapshot<SessionsProjection>('sessions.overview', {}, { next(value) { if (active) setProjection(sessionsProjectionSchema.parse(value)); }, error() { if (active) setProjection(undefined); } }, { owners: ['sessions'] }); return () => { active = false; void stop(); }; }, [runtime]);
  const workspaces = overview?.workspaces ?? [];
  const workspace = workspaces.find(item => item.id === chosen.workspaceId);
  const sessionCount = (id: string) => projection?.sessions.filter(item => item.session.workspaceId === id).length;
  const openForm = (action: Action) => { setFormError(''); setForm({ action, commandId: crypto.randomUUID(), name: action === 'edit' ? workspace?.name ?? '' : '', directory: '', access: action === 'edit' ? workspace?.access ?? 'read-write' : 'read-write', authorized: false, ...(workspace ? { workspaceId: workspace.id } : {}) }); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!form || busy) return; setBusy(true); setFormError('');
    try {
      if (form.action === 'create' && !form.directory) throw new Error('请先通过目录选择器选择工作区目录');
      const operations: Record<Action, { name: string; payload: unknown }> = {
        create: { name: 'workspace.create', payload: { workspace: { name: form.name, directory: form.directory, access: form.access } } },
        edit: { name: 'workspace.edit', payload: { id: form.workspaceId, name: form.name, access: form.access } },
        archive: { name: 'workspace.archive', payload: { id: form.workspaceId } },
      };
      const operation = operations[form.action]; const receipt = await runtime.command<CommandReceipt>(operation.name, operation.payload, form.commandId, { version: 1 });
      const next = workspaceOverviewSchema.parse(await runtime.query('workspace.overview', { cache: 'reload' })); setOverview(next);
      if (form.action === 'create') { const result = receipt.result as unknown as Workspace; select(result.id); }
      else if (form.action === 'archive') select();
      setForm(undefined);
    } catch (failure) { setFormError(failure instanceof Error ? failure.message : '保存失败，可使用同一命令重试'); }
    finally { setBusy(false); }
  }
  const visibleWorkspaces = workspaces.filter(item => showArchived || item.status === 'open');
  return <div className={context ? styles.split : styles.browser}>
    {context!=='page'&&<aside className={styles.sidebar} aria-label="工作区导航"><div className={styles.sidebarHeading}><h1>工作区</h1><button aria-label="新建工作区" onClick={() => openForm('create')}>＋</button></div>
      <nav>{visibleWorkspaces.map(item => <div key={item.id} className={styles.workspaceItem}><button aria-current={workspace?.id === item.id && !chosen.sessionId ? 'page' : undefined} onClick={() => select(item.id)}><span aria-hidden="true">▱</span>{item.name}{item.status === 'archived' ? ' · 已归档' : ''}</button>{workspace?.id === item.id && runtime.renderView('aork.sessions.navigation@1')}</div>)}</nav>
      {overview && !visibleWorkspaces.length && <p className={styles.emptyNav}>创建工作区，开始整理工作。</p>}
      <label className={`${styles.check} ${styles.archivedToggle}`}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示归档</label>
    </aside>}
    {context!=='navigation'&&<section className={chosen.sessionId ? styles.sessionContent : styles.content} aria-label="工作区详情">
      {chosen.sessionId ? <div className={styles.sessionArea}>{runtime.renderView('aork.sessions.detail@1',{embedded:true})}{!context&&workspace?.status === 'open' && <aside className={styles.sessionFiles} aria-label="会话文件">{runtime.renderView('aork.workspace.files@1')}</aside>}</div> : <>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {!overview && !error && <p role="status">正在加载工作区…</p>}
      {overview && !chosen.workspaceId && <div className={styles.overviewPage}>
        <div className={styles.pageHead}><h2>所有工作区</h2>{Boolean(workspaces.length) && <button className={styles.primary} onClick={() => openForm('create')}>新建工作区</button>}</div>
        {workspaces.length ? <ul className={styles.cards}>{workspaces.map(item => <li key={item.id}><button className={styles.card} data-archived={item.status === 'archived' || undefined} onClick={() => select(item.id)}>
          <strong>{item.name}</strong>
          <span className={styles.path} title={item.requestedDirectory !== item.directory ? item.requestedDirectory : undefined}>{item.directory}</span>
          <span className={styles.cardMeta}><span>{item.status === 'archived' ? '已归档' : '开启'}</span><span>{sessionCount(item.id) ?? '…'} 个会话</span></span>
        </button></li>)}</ul> : <div className={styles.empty}><div className={styles.mark}>a</div><h2>为下一项工作留个空间</h2><p>工作区绑定服务器上的真实目录，是组织持续工作的唯一单位。</p><button className={styles.primary} onClick={() => openForm('create')}>新建工作区</button></div>}
      </div>}
      {overview && chosen.workspaceId && !workspace && <div className={styles.empty}><div className={styles.mark}>a</div><h2>工作区不可用</h2><p>所选工作区可能已删除或不可访问。</p><button onClick={() => select()}>查看所有工作区</button></div>}
      {workspace && <><div className={styles.title}><div><p className={styles.eyebrow}>工作区</p><h2>{workspace.name}</h2></div><div className={styles.actions}>{workspace.status === 'open' && <><button onClick={() => openForm('edit')}>编辑工作区</button><button onClick={() => openForm('archive')}>归档工作区</button></>}</div></div>
        <div className={styles.details}>{workspace.status === 'archived' && <p role="status">工作区已归档，目录与记录保留。</p>}<dl><dt>真实目录</dt><dd className={styles.path}>{workspace.directory}</dd>{workspace.requestedDirectory !== workspace.directory && <><dt>登记路径</dt><dd className={styles.path}>{workspace.requestedDirectory}</dd></>}<dt>授权范围</dt><dd>此目录及其子目录</dd><dt>访问权限</dt><dd>{workspace.access === 'read-only' ? '只读' : '可读写'}</dd></dl>{workspace.status === 'open' && runtime.renderView('aork.workspace.files@1')}</div></>}
      </>}
    </section>}
    {context!=='navigation'&&runtime.renderView('aork.sessions.create@1')}
    {form && <Dialog runtime={runtime} form={form} setForm={setForm} busy={busy} error={formError} close={() => setForm(undefined)} submit={submit} />}
  </div>;
}
function Page({runtime}:ViewProps){const [chosen,setChosen]=useState(selection);useEffect(()=>{const changed=()=>setChosen(selection());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);return chosen.sessionId?<>{runtime.renderView('aork.sessions.detail@1',{embedded:true})}{runtime.renderView('aork.sessions.create@1')}</>:runtime.renderView('aork.workspace.workspace-page@1');}
export function activate(context: ClientPluginContext) { context.registerView('browser', Browser); context.registerView('navigation',props=><Browser {...props} context="navigation"/>); context.registerView('page',Page);context.registerView('workspace-page',props=><Browser {...props} context="page"/>); context.registerView('files', FileView); }
