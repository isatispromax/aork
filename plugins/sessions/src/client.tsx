import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import { overviewSchema as agentsOverviewSchema } from '@aork/contracts/agent';
import type { AgentsOverview } from '@aork/contracts/agent';
import { SESSION_COMPOSER, SESSION_MESSAGES, SESSION_TOOLS, sessionsOverviewSchema, sessionTimelineSchema } from '@aork/contracts/session';
import type { Session, SessionsOverview, SessionTimeline, Turn } from '@aork/contracts/session';
import { permissionSchema } from '@aork/contracts/interaction';
import type { PermissionInteraction } from '@aork/contracts/interaction';
import styles from './sessions.module.css';

function useSelection() {
  const [selection, setSelection] = useState(() => readWorkbenchSelection(location.hash));
  useEffect(() => { const change = () => setSelection(readWorkbenchSelection(location.hash)); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  return selection;
}
function useSessions(runtime: UiRuntime, refresh: string | number | null) {
  const [overview, setOverview] = useState<SessionsOverview>(); const [error, setError] = useState('');
  useEffect(() => { let active = true; const stop = runtime.subscribe<SessionsOverview>('sessions.overview', { next(value) { if (active) { setOverview(sessionsOverviewSchema.parse(value)); setError(''); } }, error(failure) { if (active) setError(failure.message); } }, { intervalMs: 1000 }); return () => { active = false; void stop(); }; }, [runtime, refresh]);
  return { overview, error };
}
function useTimeline(runtime: UiRuntime, sessionId: string | null) {
  const [timeline, setTimeline] = useState<SessionTimeline>(); const [error, setError] = useState('');
  useEffect(() => {
    setTimeline(undefined); setError(''); if (!sessionId) return;
    let active = true; let reading = false;
    const stop = runtime.subscribe('sessions.overview', {
      async next() {
        if (reading) return; reading = true;
        try { const value = await runtime.resource('sessions.timeline', { sessionId }); const parsed = sessionTimelineSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes))); if (active) { setTimeline(parsed); setError(''); } }
        catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '读取历史失败'); }
        finally { reading = false; }
      },
      error(failure) { if (active) setError(failure.message); },
    }, { intervalMs: 1000 });
    return () => { active = false; void stop(); };
  }, [runtime, sessionId]);
  return { timeline, error };
}
const turnLabels: Record<Turn['state'], string> = { accepted: '已受理', dispatching: '正在发送', running: '执行中', cancelling: '取消中', completed: '已完成', cancelled: '已取消', failed: '执行失败', delivery_unknown: '交付结果未知', interrupted: '执行已中断' };
const activeTurn = (turn: Turn | undefined) => turn && ['accepted', 'dispatching', 'running', 'cancelling'].includes(turn.state);
function Messages({ runtime }: ViewProps) {
  const { sessionId } = useSelection(); const { timeline, error } = useTimeline(runtime, sessionId);
  return <section className={styles.messages} aria-label="会话消息" aria-live="polite">
    {error && <p role="alert">{error}</p>}
    {!timeline && !error && <p role="status">正在读取对话…</p>}
    {timeline && !timeline.turns.length && <div className={styles.empty}><h3>从这里开始</h3><p>向 Agent 说明你想完成的工作。</p></div>}
    {timeline?.turns.map(turn => <article key={turn.id} className={styles.turn}>
      {(['user', 'agent'] as const).map(role => { const text = timeline.messages.filter(message => message.turnId === turn.id && message.role === role).map(message => message.text).join(''); return text ? <div key={role} className={role === 'user' ? styles.userMessage : styles.agentMessage}><span className={styles.messageRole}>{role === 'user' ? '你' : 'Agent'}</span><div className={styles.messageText}>{text}</div></div> : null; })}
      <footer className={styles.turnStatus}><span>{turnLabels[turn.state]}</span>{turn.stopReason && <span>{turn.stopReason}</span>}{turn.usage ? <span>用量 {turn.usage.used} / {turn.usage.size} · {turn.usage.cost ? `${turn.usage.cost.amount} ${turn.usage.cost.currency}` : '费用未知'}</span> : <span>用量未知 · 费用未知</span>}</footer>
      {turn.reason && <p className={styles.error}>{turn.reason}</p>}
      {turn.state === 'delivery_unknown' && <p className={styles.hint}>无法确认 Agent 是否收到输入。此输入不会自动重发。</p>}
      {turn.state === 'interrupted' && <p className={styles.hint}>执行连接已中断，已保存的内容仍保留。此输入不会自动重发。</p>}
    </article>)}
    {timeline?.truncated && <p role="status">此视图仅展示最近的有界历史。</p>}
  </section>;
}
function Tools({ runtime }: ViewProps) {
  const { sessionId } = useSelection(); const { timeline, error } = useTimeline(runtime, sessionId);
  if (!error && !timeline?.tools.length) return null;
  return <section className={styles.tools} aria-label="工具报告"><h3>工具报告</h3>{error && <p role="alert">{error}</p>}{timeline?.tools.map(tool => <details key={`${tool.turnId}:${tool.toolCallId}`} className={styles.tool}><summary><span>{tool.title}</span><small>{({ pending: '等待中', in_progress: '执行中', completed: '已完成', failed: '失败' })[tool.status]}</small></summary>{tool.text && <pre>{tool.text}</pre>}<p>Agent 的执行报告，仅供查看。</p></details>)}</section>;
}
interface Draft { text: string; commandId: string; uncertain?: { text: string; commandId: string } }
const drafts = new Map<string, Draft>();
function Composer({ runtime }: ViewProps) { const { sessionId } = useSelection(); return sessionId ? <SessionComposer key={sessionId} runtime={runtime} sessionId={sessionId} /> : null; }
function SessionComposer({ runtime, sessionId }: ViewProps & { sessionId: string }) {
  const { overview, error: queryError } = useSessions(runtime, sessionId);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(sessionId) ?? { text: '', commandId: crypto.randomUUID() });
  const [pending, setPending] = useState<PermissionInteraction[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [receivedTurn, setReceivedTurn] = useState<Turn>(); const [cancel, setCancel] = useState<{ turnId: string; commandId: string }>();
  const input = useRef<HTMLTextAreaElement>(null); const composing = useRef(false); const sending = useRef(false); const latestDraft = useRef(draft);
  const entry = overview?.sessions.find(item => item.session.id === sessionId);
  const turn = receivedTurn && (!entry?.currentTurn || (receivedTurn.id !== entry.currentTurn.id && activeTurn(receivedTurn))) ? receivedTurn : entry?.currentTurn;
  const working = Boolean(activeTurn(turn));
  const canSend = Boolean(entry && entry.session.status === 'open' && entry.execution.state === 'ready' && entry.environment.status === 'open' && entry.environment.directory.status === 'available' && !entry.dispatchPaused && !working && !queryError);
  function update(next: Draft) { latestDraft.current = next; drafts.set(sessionId, next); setDraft(next); }
  useEffect(() => { input.current?.focus(); }, [sessionId]);
  useEffect(() => { const element = input.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; } }, [draft.text]);
  useEffect(() => {
    let active = true; const stop = runtime.subscribe<{ pending: unknown[] }>('interactions.pending', {
      next(value) { if (active) setPending(value.pending.map(item => permissionSchema.parse(item)).filter(item => item.sessionId === sessionId && item.state === 'pending')); },
      error(failure) { if (active) setError(failure.message); },
    }, { intervalMs: 1000 }); return () => { active = false; void stop(); };
  }, [runtime, sessionId]);
  async function submit(retry = false) {
    const current = latestDraft.current; const attempt = retry ? current.uncertain : { text: current.text, commandId: current.commandId };
    if (!attempt || !attempt.text.trim() || sending.current || (!retry && (!canSend || current.uncertain))) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const receipt = await runtime.command<CommandReceipt<Turn>>('sessions.sendText', { sessionId, text: attempt.text }, attempt.commandId, { version: 1 });
      setReceivedTurn(receipt.result);
      const latest = latestDraft.current; update({ text: latest.text === attempt.text ? '' : latest.text, commandId: crypto.randomUUID() });
      input.current?.focus();
    } catch (failure) { update({ ...latestDraft.current, uncertain: attempt }); setError(failure instanceof Error ? failure.message : '发送结果未确认'); }
    finally { sending.current = false; setBusy(false); }
  }
  async function cancelTurn() {
    if (!turn || !activeTurn(turn) || turn.state === 'cancelling' || busy) return;
    const attempt = cancel?.turnId === turn.id ? cancel : { turnId: turn.id, commandId: crypto.randomUUID() }; setCancel(attempt); setBusy(true); setError('');
    try { await runtime.command('sessions.cancelTurn', { turnId: attempt.turnId }, attempt.commandId, { version: 1 }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '取消结果未确认，可重试'); }
    finally { setBusy(false); }
  }
  return <section className={styles.composerArea} aria-label="会话输入">
    {pending.length > 0 && <aside className={styles.permission} aria-label="等待权限"><strong>等待权限处理</strong>{pending.map(item => <p key={item.id}>{item.title}</p>)}<p>此阶段尚未提供权限响应，可取消当前轮次。</p></aside>}
    {entry?.dispatchPaused && <p role="status">会话派发已暂停；此输入不会自动重发。</p>}
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className={styles.inputLabel} htmlFor={`message-${sessionId}`}>消息输入</label>
      <textarea ref={input} id={`message-${sessionId}`} value={draft.text} maxLength={16000} rows={1} placeholder="描述你想完成的工作…" onChange={event => update({ ...latestDraft.current, text: event.target.value, commandId: crypto.randomUUID() })} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; void submit(); } }} />
      <footer className={styles.composerFooter}><div><span title={entry?.session.providerLabel}>{entry?.session.profile.name ?? 'Agent'}</span><small>{turn && activeTurn(turn) ? turnLabels[turn.state] : canSend ? 'Enter 发送 · Shift+Enter 换行' : '启动运行后可发送'}</small></div>{working ? <button type="button" disabled={busy || turn?.state === 'cancelling'} onClick={() => void cancelTurn()}>{turn?.state === 'cancelling' ? '取消中…' : '取消当前轮次'}</button> : <button type="submit" className={styles.send} disabled={busy || !canSend || !draft.text.trim() || Boolean(draft.uncertain)} aria-label="发送消息">↑</button>}</footer>
    </form>
    {draft.uncertain && <div className={styles.retry} role="status"><p>发送结果未确认。重试会查询或受理同一条输入，不会创建另一轮。</p><button disabled={busy} onClick={() => void submit(true)}>重试原输入</button></div>}
    {(error || queryError) && <p role="alert" className={styles.error}>{error || queryError}</p>}
  </section>;
}
function Modal({ title, busy, close, children }: { title: string; busy: boolean; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); }; }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) close(); }}><h2>{title}</h2>{children}</dialog>;
}
function Navigation({ runtime }: ViewProps) {
  const chosen = useSelection(); const { overview, error } = useSessions(runtime, chosen.sessionId); const [archived, setArchived] = useState(false);
  const sessions = overview?.sessions.filter(entry => entry.session.workspaceId === chosen.workspaceId && entry.session.projectId === chosen.projectId && (archived || entry.session.status === 'open')) ?? [];
  return <section className={styles.navigation} aria-label="会话导航"><button aria-label="新建会话" className={styles.newSession} onClick={() => { location.hash = withWorkbenchSelection(location.hash, { creatingSession: true }); }}>＋ 新建会话</button>
    {error && <p role="alert">{error}</p>}
    {sessions.map(({ session }) => <button key={session.id} aria-current={session.id === chosen.sessionId ? 'page' : undefined} onClick={() => { location.hash = withWorkbenchSelection(location.hash, { sessionId: session.id, creatingSession: false }); }}><span aria-hidden="true">◌</span>{session.name}{session.status === 'archived' ? ' · 已归档' : ''}</button>)}
    {overview && !sessions.length && <p>此工作区暂无{archived ? '' : '未归档'}会话。</p>}
    <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />显示归档会话</label>
  </section>;
}
function CreateDialog({ runtime, chosen, close }: ViewProps & { chosen: ReturnType<typeof readWorkbenchSelection>; close(): void }) {
  const composing = useRef(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOverview>(); const [agents, setAgents] = useState<AgentsOverview>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', projectId: chosen.projectId ?? '', workspaceId: chosen.workspaceId ?? '', profileId: '', commandId: crypto.randomUUID() });
  useEffect(() => { let active = true; const stops = [runtime.subscribe<WorkspaceOverview>('workspace.overview', { next(value) { if (active) setWorkspaces(workspaceOverviewSchema.parse(value)); }, error(failure) { if (active) setError(failure.message); } }, { intervalMs: 1000 }), runtime.subscribe<AgentsOverview>('agents.overview', { next(value) { if (active) setAgents(agentsOverviewSchema.parse(value)); }, error(failure) { if (active) setError(failure.message); } })]; return () => { active = false; for (const stop of stops) void stop(); }; }, [runtime]);
  const workspace = workspaces?.workspaces.find(item => item.id === form.workspaceId && item.projectId === form.projectId);
  const profile = agents?.profiles.find(item => item.profile.id === form.profileId);
  const provider = agents?.providers.find(item => item.id === profile?.profile.providerId);
  const update = (value: Partial<typeof form>) => setForm(current => ({ ...current, ...value, commandId: crypto.randomUUID() }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const receipt = await runtime.command<CommandReceipt<Session>>('sessions.create', { name: form.name, projectId: form.projectId, workspaceId: form.workspaceId, profileId: form.profileId }, form.commandId, { version: 1 });
      location.hash = withWorkbenchSelection(location.hash, { projectId: receipt.result.projectId, workspaceId: receipt.result.workspaceId, sessionId: receipt.result.id, creatingSession: false });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '创建失败，可使用同一命令重试'); }
    finally { setBusy(false); }
  }
  return <Modal title="新建会话" busy={busy} close={close}><form onSubmit={submit} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault(); }}><fieldset disabled={busy}>
    <label>会话名称<input autoFocus required maxLength={120} value={form.name} onChange={event => update({ name: event.target.value })} /></label>
    <label>项目<select required value={form.projectId} onChange={event => update({ projectId: event.target.value, workspaceId: '' })}><option value="">选择项目</option>{workspaces?.projects.filter(item => item.status === 'open').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>工作区<select required value={form.workspaceId} onChange={event => update({ workspaceId: event.target.value })}><option value="">选择工作区</option>{workspaces?.workspaces.filter(item => item.projectId === form.projectId && item.status === 'open').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {workspace && <p className={styles.path}>{workspace.directory}</p>}
    <label>Agent Profile<select required value={form.profileId} onChange={event => update({ profileId: event.target.value })}><option value="">选择 Agent Profile</option>{agents?.profiles.map(item => <option key={item.profile.id} value={item.profile.id}>{item.profile.name} · {agents.providers.find(candidate => candidate.id === item.profile.providerId)?.label ?? item.profile.providerId}</option>)}</select></label>
    {agents && !agents.profiles.length && <p>尚无 Agent Profile，请先在设置的 Agent 页面保存配置。</p>}
    {profile && <div className={styles.selection}><p>{provider?.label ?? profile.profile.providerId}</p><small>{profile.profile.providerId} · 配置版本 {profile.profile.revision}</small>{profile.availability !== 'available' && <p>当前配置不可用（{profile.reason}）；创建会话不会启动 Agent。</p>}</div>}
    <p>创建后尚未启动</p>
  </fieldset>{error && <p role="alert" className={styles.error}>{error}</p>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className={styles.primary} disabled={busy || !workspace || !profile}>{busy ? '正在创建…' : '创建会话'}</button></footer></form></Modal>;
}
function Create({ runtime }: ViewProps) {
  const chosen = useSelection(); const close = () => { location.hash = withWorkbenchSelection(location.hash, { creatingSession: false }); };
  return chosen.creatingSession ? <CreateDialog runtime={runtime} chosen={chosen} close={close} /> : null;
}
function Detail({ runtime }: ViewProps) {
  const chosen = useSelection(); const [revision, setRevision] = useState(0); const { overview, error } = useSessions(runtime, `${chosen.sessionId}:${revision}`);
  const [archive, setArchive] = useState<{ id: string; commandId: string }>(); const [busy, setBusy] = useState(false); const [archiveError, setArchiveError] = useState('');
  const [runError,setRunError]=useState('');
  const entry = overview?.sessions.find(item => item.session.id === chosen.sessionId); const session = entry?.session;
  if (error) return <div className={styles.detail}><p role="alert">{error}</p></div>;
  if (!overview) return <div className={styles.detail}><p role="status">正在加载会话…</p></div>;
  if (!session || !entry) return <div className={styles.detail}><h2>会话不可用</h2><p>此身份无法访问所选会话，或会话不存在。</p></div>;
  if (session.projectId !== chosen.projectId || session.workspaceId !== chosen.workspaceId) return <div className={styles.detail}><h2>会话与所选环境不匹配</h2><button onClick={() => { location.hash = withWorkbenchSelection(location.hash, { projectId: session.projectId, workspaceId: session.workspaceId }); }}>打开会话所属工作区</button></div>;
  async function changeRun(action:'start'|'end') {
    if(!session||!entry||busy)return;setBusy(true);setRunError('');
    try {await runtime.command(action==='start'?'sessions.startRun':'sessions.endRun',action==='start'?{sessionId:session.id}:{runId:entry.execution.state==='not-started'?'':entry.execution.runId},crypto.randomUUID(),{version:1});setRevision(value=>value+1);}
    catch(failure){setRunError(failure instanceof Error?failure.message:'运行操作失败');}finally{setBusy(false);}
  }
  async function submitArchive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!archive || busy) return; setBusy(true); setArchiveError('');
    try { await runtime.command('sessions.archive', { id: archive.id }, archive.commandId, { version: 1 }); setArchive(undefined); setRevision(value => value + 1); }
    catch (failure) { setArchiveError(failure instanceof Error ? failure.message : '归档失败，可使用同一命令重试'); }
    finally { setBusy(false); }
  }
  return <section className={styles.detail} aria-label="会话详情"><header className={styles.header}><h2>{session.name}</h2><span>{({'not-started':'尚未启动',starting:'正在启动',ready:'运行已就绪',stopping:'正在结束',stopped:'运行已结束',unknown:'运行状态未知'})[entry.execution.state]}</span>{session.status === 'open' && <button onClick={() => { setArchiveError(''); setArchive({ id: session.id, commandId: crypto.randomUUID() }); }}>归档会话</button>}</header>
    <div className={styles.body}>{session.status === 'archived' && <p role="status">会话已归档，历史与关联保留。</p>}
      {entry.environment.status !== 'open' && <p role="status">工作区或项目已归档或不可用。</p>}
      {entry.environment.directory.status !== 'available' && <p role="status">目录不可用；历史仍保留，启动前须重新验证工作区。</p>}
      <section className={styles.runToolbar} aria-label="运行控制">
        {session.status==='open'&&['not-started','stopped'].includes(entry.execution.state)&&<button className={styles.primary} disabled={busy||entry.environment.status!=='open'||entry.environment.directory.status!=='available'} onClick={()=>void changeRun('start')}>启动运行</button>}
        {['starting','ready'].includes(entry.execution.state)&&<button disabled={busy} onClick={()=>void changeRun('end')}>结束运行</button>}
        {runError&&<p role="alert">{runError}</p>}
      </section>
      {runtime.renderView(SESSION_MESSAGES)}
      {runtime.renderView(SESSION_TOOLS)}
      {runtime.renderView(SESSION_COMPOSER)}
      {entry.execution.state==='not-started' && <p className={styles.hint}>尚无原生历史，不能原生恢复。</p>}
      <details className={styles.runDetails}><summary>会话与运行详情</summary>
      <dl><dt>Agent</dt><dd>{session.providerLabel} <small>({session.profile.providerId})</small></dd><dt>配置</dt><dd>{session.profile.name} · 版本 {session.profile.revision}</dd><dt>真实目录</dt><dd className={styles.path}>{session.workspace.directory}</dd><dt>会话身份</dt><dd className={styles.path}>{session.id}</dd></dl>
      <section aria-label="运行信息">
        {entry.execution.state!=='not-started'&&<>
          <dl><dt>运行身份</dt><dd>{entry.execution.runId}</dd><dt>连接代次</dt><dd>{entry.execution.generation}</dd><dt>检测版本</dt><dd>{entry.execution.detectedVersion}</dd><dt>Node / ACP SDK</dt><dd>{entry.execution.runtime.nodeVersion} / {entry.execution.runtime.acpSdkVersion}</dd><dt>ACP 协议</dt><dd>{entry.execution.protocolVersion??'尚未协商'}</dd><dt>Agent 版本</dt><dd>{entry.execution.agentVersion??(entry.execution.state==='starting'?'尚未返回':'未报告')}</dd><dt>原生恢复能力</dt><dd>{entry.execution.loadSession===undefined?'尚未协商':entry.execution.loadSession?'Agent 支持；工作台恢复尚未开放':'不支持'}</dd><dt>子进程环境</dt><dd>仅 {entry.execution.environment.names.join('、')}，不继承 Host 环境</dd></dl>
          {entry.execution.reason&&<p role="status">{entry.execution.reason}</p>}
          {['starting','ready','stopping'].includes(entry.execution.state)&&<p>当前 Run 持有工作区写入权。关闭浏览器不会结束运行。</p>}
          {entry.execution.state==='unknown'&&<p>工作区保持阻塞；请通过本地维护核查，不能根据旧 PID 或超时解除。</p>}
          <p>结束运行将停止受管进程与登记任务后释放占用；下次启动会创建新的原生会话。此处不自动休眠。</p>
        </>}
        <p>工作区占用用于协调可信 Agent 和插件，不构成操作系统安全沙箱。</p>
      </section>
      <details><summary>创建时的配置选择</summary><dl><dt>Provider 定义</dt><dd>{session.profile.providerDefinitionVersion}</dd><dt>版本要求</dt><dd>{session.profile.versionRequirement}</dd><dt>参数</dt><dd><pre>{JSON.stringify(session.profile.parameters, null, 2)}</pre></dd><dt>认证方式</dt><dd>{session.profile.authentication}</dd></dl></details>
      </details>
    </div>
    {archive && <Modal title="归档会话" busy={busy} close={() => setArchive(undefined)}><form onSubmit={submitArchive}><p>保留会话历史、配置和工作区关联。归档不会停止 Run 或释放工作区占用。</p>{archiveError && <p role="alert" className={styles.error}>{archiveError}</p>}<footer><button type="button" disabled={busy} onClick={() => setArchive(undefined)}>取消</button><button autoFocus type="submit" disabled={busy}>{busy ? '正在归档…' : '确认归档'}</button></footer></form></Modal>}
  </section>;
}
export function activate(context: ClientPluginContext) { context.registerView('navigation', Navigation); context.registerView('create', Create); context.registerView('detail', Detail); context.registerView('composer', Composer); context.registerView('messages', Messages); context.registerView('tools', Tools); }
