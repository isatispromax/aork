import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { workspaceOverviewSchema, readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import type { Project, Workspace, WorkspaceOverview } from '@aork/contracts/workspace';
import styles from './workspace.module.css';
import { FileView } from './file-view.js';

type Action = 'project' | 'workspace' | 'editProject' | 'editWorkspace' | 'archiveProject' | 'archiveWorkspace';
interface FormState { action: Action; commandId: string; name: string; workspaceName: string; management: string; directory: string; access: string; authorized: boolean; projectId?: string; workspaceId?: string }
function selection() { return readWorkbenchSelection(location.hash); }
function select(projectId: string, workspaceId?: string) {
  location.hash = withWorkbenchSelection(location.hash, { projectId, workspaceId: workspaceId ?? null, sessionId: null, creatingSession: false });
}
function Dialog({ form, setForm, busy, error, close, submit }: { form: FormState; setForm(form: FormState): void; busy: boolean; error: string; close(): void; submit(event: FormEvent<HTMLFormElement>): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); before?.focus(); }; }, []);
  const archive = form.action.startsWith('archive'); const create = form.action === 'project' || form.action === 'workspace'; const title = ({ project: '新建项目', workspace: '添加工作区', editProject: '编辑项目', editWorkspace: '编辑工作区', archiveProject: '归档项目', archiveWorkspace: '归档工作区' })[form.action];
  const update = (key: keyof FormState, value: string | boolean) => setForm({ ...form, [key]: value, commandId: crypto.randomUUID() });
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={submit}><h2 id="workspace-dialog-title">{title}</h2>
      {archive ? <p>归档保留工作区、目录和已有记录。项目归档后，其中的工作区将停止接受新的操作。</p> : <fieldset disabled={busy}>
        {(form.action === 'project' || form.action === 'editProject') && <label>项目名称<input autoFocus required maxLength={120} value={form.name} onChange={event => update('name', event.target.value)} /></label>}
        {(create || form.action === 'editWorkspace') && <label>工作区名称<input autoFocus={form.action !== 'project'} required maxLength={120} value={form.workspaceName} onChange={event => update('workspaceName', event.target.value)} /></label>}
        {create && <label>目录管理<select value={form.management} onChange={event => update('management', event.target.value)}><option value="managed">Aork 托管目录</option><option value="external">登记服务器已有目录</option></select></label>}
        {create && form.management === 'managed' && <p className={styles.hint}>在本实例的数据目录中创建独立工作区，无需 Git 仓库。</p>}
        {create && form.management === 'external' && <label>服务器目录<input required placeholder="/absolute/path" value={form.directory} onChange={event => update('directory', event.target.value)} /><small>填写此 Host 所在机器的绝对目录路径。</small></label>}
        {((create && form.management === 'external') || form.action === 'editWorkspace') && <label>访问权限<select value={form.access} onChange={event => update('access', event.target.value)}><option value="read-write">可读写</option><option value="read-only">只读</option></select></label>}
        {create && form.management === 'external' && <label className={styles.check}><input type="checkbox" required checked={form.authorized} onChange={event => update('authorized', event.target.checked)} />授权此目录及其子目录</label>}
      </fieldset>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button className={styles.primary} type="submit" disabled={busy}>{busy ? '正在保存…' : archive ? '确认归档' : create ? '创建' : '保存'}</button></footer>
    </form>
  </dialog>;
}
function Browser({ runtime, context }: ViewProps) {
  const [overview, setOverview] = useState<WorkspaceOverview>(); const [error, setError] = useState(''); const [chosen, setChosen] = useState(selection); const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState>(); const [busy, setBusy] = useState(false); const [formError, setFormError] = useState('');
  useEffect(() => { const change = () => setChosen(selection()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { let active = true; const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', { next(value) { if (active) { setOverview(workspaceOverviewSchema.parse(value)); setError(''); } }, error(failure) { if (active) setError(failure.message); } }); return () => { active = false; void unsubscribe(); }; }, [runtime]);
  const project = overview?.projects.find(item => item.id === chosen.projectId); const workspace = overview?.workspaces.find(item => item.id === chosen.workspaceId && item.projectId === project?.id);
  const openForm = (action: Action) => { setFormError(''); setForm({ action, commandId: crypto.randomUUID(), name: action === 'editProject' ? project?.name ?? '' : '', workspaceName: action === 'editWorkspace' ? workspace?.name ?? '' : '', management: 'managed', directory: '', access: action === 'editWorkspace' ? workspace?.access ?? 'read-write' : 'read-write', authorized: false, ...(project ? { projectId: project.id } : {}), ...(workspace ? { workspaceId: workspace.id } : {}) }); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!form || busy) return; setBusy(true); setFormError('');
    try {
      const input = { name: form.workspaceName, management: form.management, ...(form.management === 'external' ? { directory: form.directory, access: form.access } : {}) };
      const operations: Record<Action, { name: string; payload: unknown }> = {
        project: { name: 'workspace.createProject', payload: { name: form.name, workspace: input } },
        workspace: { name: 'workspace.create', payload: { projectId: form.projectId, workspace: input } },
        editProject: { name: 'workspace.editProject', payload: { id: form.projectId, name: form.name } },
        editWorkspace: { name: 'workspace.edit', payload: { id: form.workspaceId, name: form.workspaceName, access: form.access } },
        archiveProject: { name: 'workspace.archiveProject', payload: { id: form.projectId } },
        archiveWorkspace: { name: 'workspace.archive', payload: { id: form.workspaceId } },
      };
      const operation = operations[form.action]; const receipt = await runtime.command<CommandReceipt>(operation.name, operation.payload, form.commandId, { version: 1 });
      const next = workspaceOverviewSchema.parse(await runtime.query('workspace.overview', { cache: 'reload' })); setOverview(next);
      if (form.action === 'project') { const result = receipt.result as unknown as { project: Project; workspace: Workspace }; select(result.project.id, result.workspace.id); }
      else if (form.action === 'workspace') { const result = receipt.result as unknown as Workspace; select(result.projectId, result.id); }
      else if (form.action === 'archiveWorkspace') select(form.projectId!);
      else if (form.action === 'archiveProject') location.hash = '';
      setForm(undefined);
    } catch (failure) { setFormError(failure instanceof Error ? failure.message : '保存失败，可使用同一命令重试'); }
    finally { setBusy(false); }
  }
  const visibleProjects = overview?.projects.filter(item => showArchived || item.status === 'open') ?? [];
  return <div className={context ? styles.split : styles.browser}>
    {context!=='page'&&<aside className={styles.sidebar} aria-label="项目导航"><div className={styles.sidebarHeading}><h1>项目与工作区</h1><button aria-label="新建项目" onClick={() => openForm('project')}>＋</button></div>
      <nav>{visibleProjects.map(item => <section key={item.id} className={styles.project}><button aria-current={project?.id === item.id && !workspace ? 'page' : undefined} onClick={() => select(item.id)}><span aria-hidden="true">▾</span>{item.name}{item.status === 'archived' ? ' · 已归档' : ''}</button><div className={styles.tree}>{overview?.workspaces.filter(child => child.projectId === item.id && (showArchived || child.status === 'open')).map(child => <div key={child.id}><button aria-current={workspace?.id === child.id && !chosen.sessionId ? 'page' : undefined} onClick={() => select(item.id, child.id)}><span aria-hidden="true">▱</span>{child.name}{child.status === 'archived' ? ' · 已归档' : ''}</button>{workspace?.id === child.id && runtime.renderView('aork.sessions.navigation@1')}</div>)}</div></section>)}</nav>
      {overview && !visibleProjects.length && <p className={styles.emptyNav}>创建项目，开始整理工作。</p>}
      <label className={`${styles.check} ${styles.archivedToggle}`}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示归档</label>
    </aside>}
    {context!=='navigation'&&<section className={chosen.sessionId ? styles.sessionContent : styles.content} aria-label="工作区详情">
      {chosen.sessionId ? <div className={styles.sessionArea}>{runtime.renderView('aork.sessions.detail@1',{embedded:true})}{!context&&workspace?.status === 'open' && project?.status === 'open' && <aside className={styles.sessionFiles} aria-label="会话文件">{runtime.renderView('aork.workspace.files@1')}</aside>}</div> : <>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {!overview && !error && <p role="status">正在加载项目…</p>}
      {overview && !project && <div className={styles.empty}><div className={styles.mark}>a</div><h2>{chosen.projectId ? '项目不可用' : '为下一项工作留个空间'}</h2><p>{chosen.projectId ? '所选项目可能已归档，开启“显示归档”查看记录。' : '项目组织持续的工作。工作区连接真实目录，可以与代码无关。'}</p><button className={styles.primary} onClick={() => openForm('project')}>新建项目</button></div>}
      {project && <><div className={styles.title}><div><p className={styles.eyebrow}>{workspace ? project.name : '项目'}</p><h2>{workspace?.name ?? project.name}</h2></div><div className={styles.actions}>{project.status === 'open' && <><button onClick={() => openForm('workspace')}>添加工作区</button><button onClick={() => openForm('editProject')}>编辑项目</button><button onClick={() => openForm('archiveProject')}>归档项目</button></>}</div></div>
        {project.status === 'archived' && <p role="status">项目已归档，目录与工作区记录保留。</p>}
        {workspace ? <div className={styles.details}>{workspace.status === 'archived' && <p role="status">工作区已归档</p>}<dl><dt>真实目录</dt><dd className={styles.path}>{workspace.directory}</dd>{workspace.requestedDirectory !== workspace.directory && <><dt>登记路径</dt><dd className={styles.path}>{workspace.requestedDirectory}</dd></>}<dt>管理方式</dt><dd>{workspace.management === 'managed' ? 'Aork 托管' : '外接目录'}</dd><dt>授权范围</dt><dd>此目录及其子目录</dd><dt>访问权限</dt><dd>{workspace.access === 'read-only' ? '只读' : '可读写'}</dd></dl>{workspace.status === 'open' && project.status === 'open' && <div className={styles.actions}><button onClick={() => openForm('editWorkspace')}>编辑工作区</button><button onClick={() => openForm('archiveWorkspace')}>归档工作区</button></div>}{workspace.status === 'open' && project.status === 'open' && runtime.renderView('aork.workspace.files@1')}</div> : <div className={styles.details}><p>从左侧选择工作区查看真实目录和访问范围。</p><p className={styles.hint}>项目与目录分开管理；一个项目可以拥有多个工作区。</p></div>}
      </>}
      </>}
    </section>}
    {context!=='navigation'&&runtime.renderView('aork.sessions.create@1')}
    {form && <Dialog form={form} setForm={setForm} busy={busy} error={formError} close={() => setForm(undefined)} submit={submit} />}
  </div>;
}
function Page({runtime}:ViewProps){const [chosen,setChosen]=useState(selection);useEffect(()=>{const changed=()=>setChosen(selection());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);return chosen.sessionId?<>{runtime.renderView('aork.sessions.detail@1',{embedded:true})}{runtime.renderView('aork.sessions.create@1')}</>:runtime.renderView('aork.workspace.workspace-page@1');}
export function activate(context: ClientPluginContext) { context.registerView('browser', Browser); context.registerView('navigation',props=><Browser {...props} context="navigation"/>); context.registerView('page',Page);context.registerView('workspace-page',props=><Browser {...props} context="page"/>); context.registerView('files', FileView); }
