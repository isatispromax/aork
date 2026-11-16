import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import { overviewSchema as agentsOverviewSchema } from '@aork/contracts/agent';
import type { AgentsOverview } from '@aork/contracts/agent';
import { SESSION_COMPOSER, SESSION_MESSAGES, SESSION_TOOLS, sendTextSchema, sessionsOverviewSchema, sessionsProjectionSchema, sessionEnvironmentsSchema, sessionTimelineSchema, replyPageSchema } from '@aork/contracts/session';
import type { Session, SessionsOverview, SessionsProjection, SessionTimeline, Turn, ReplyPage } from '@aork/contracts/session';
import { INPUT_CARDS } from '@aork/contracts/structured-input';
import { INTERACTION_CARDS } from '@aork/contracts/interaction';
import { InputOptions } from './input-options.js';
import { TurnDetails } from './turn-detail.js';
import { ReconciliationPanel } from './reconciliation.js';
import { SESSION_INPUT_OPTIONS,SESSION_INPUT_EXTENSIONS,attachmentReferenceSchema } from '@aork/contracts/input';
import type { AttachmentReference,SessionInputContext } from '@aork/contracts/input';
import styles from './sessions.module.css';

function useSelection() {
  const [selection, setSelection] = useState(() => readWorkbenchSelection(location.hash));
  useEffect(() => { const change = () => setSelection(readWorkbenchSelection(location.hash)); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  return selection;
}
function useSessions(runtime: UiRuntime, refresh: string | number | null) {
  const [projection,setProjection]=useState<SessionsProjection>();
  const [environments,setEnvironments]=useState<Map<string,SessionsOverview['sessions'][number]['environment']>>();
  const [projectionError,setProjectionError]=useState('');const [environmentError,setEnvironmentError]=useState('');
  useEffect(()=>{let active=true;const stop=runtime.observeSnapshot<SessionsProjection>('sessions.overview',{}, {
    next(value){const parsed=sessionsProjectionSchema.parse(value);if(active){setProjection(parsed);setProjectionError('');}},error(failure){if(active)setProjectionError(failure.message);}
  },{owners:['sessions']});return()=>{active=false;void stop();};},[runtime,refresh]);
  useEffect(()=>{let active=true;const stop=runtime.subscribe('sessions.environments',{
    next(value){const parsed=sessionEnvironmentsSchema.parse(value);if(active){setEnvironments(new Map(parsed.environments.map(item=>[item.sessionId,item.environment])));setEnvironmentError('');}},error(failure){if(active)setEnvironmentError(failure.message);}
  },{intervalMs:1000});return()=>{active=false;void stop();};},[runtime,refresh]);
  const overview=projection&&environments?sessionsOverviewSchema.parse({sessions:projection.sessions.flatMap(item=>{const environment=environments.get(item.session.id);return environment?[{...item,environment}]:[];})}):undefined;
  return {overview,error:projectionError||environmentError,projectionError,environmentError};
}
function useTimeline(runtime: UiRuntime, sessionId: string | null) {
  const [timeline, setTimeline] = useState<SessionTimeline>(); const [error, setError] = useState('');
  useEffect(() => {setTimeline(undefined);setError('');if(!sessionId)return;let active=true;
    const stop=runtime.observeSnapshot<SessionTimeline>('sessions.timeline',{sessionId},{next(value){const parsed=sessionTimelineSchema.parse(value);if(active){setTimeline(parsed);setError('');}},error(failure){if(active)setError(failure.message);}},{owners:['sessions']});
    return()=>{active=false;void stop();};
  },[runtime,sessionId]);
  return { timeline: timeline?.sessionId === sessionId ? timeline : undefined, error };
}
const turnLabels: Record<Turn['state'], string> = { accepted: '排队中', queued: '排队中', removed: '已移除', dispatching: '正在发送', running: '执行中', cancelling: '取消中', completed: '已完成', cancelled: '已取消', failed: '执行失败', delivery_unknown: '交付结果未知', interrupted: '执行已中断' };
const activeTurn = (turn: Turn | undefined) => turn && ['dispatching', 'running', 'cancelling'].includes(turn.state);
const turnProgress = (turn: Turn) => ({ accepted: 0, queued: 0, removed: 4, dispatching: 1, running: 2, cancelling: 3, completed: 4, cancelled: 4, failed: 4, delivery_unknown: 4, interrupted: 4 })[turn.state];
function Messages({ runtime }: ViewProps) {
  const { sessionId,replyId } = useSelection(); const { timeline, error } = useTimeline(runtime, sessionId);
  if(replyId&&sessionId)return <SelectedReply key={replyId} runtime={runtime} sessionId={sessionId} activityId={replyId}/>;
  return <section className={styles.messages} aria-label="会话消息" aria-live="polite">
    {error && <p role="alert">{error}</p>}
    {!timeline && !error && <p role="status">正在读取对话…</p>}
    {timeline && !timeline.turns.length && <div className={styles.empty}><h3>从这里开始</h3><p>向 Agent 说明你想完成的工作。</p></div>}
    {timeline?.turns.map(turn => <article key={turn.id} className={styles.turn}>
      {(['user', 'agent'] as const).map(role => { const text = timeline.messages.filter(message => message.turnId === turn.id && message.role === role).map(message => message.text).join(''); const content=<div aria-label={role==='user'?'你的消息':'Agent 回复'} className={role==='user'?styles.userMessage:styles.agentMessage}><div className={styles.messageText}>{text}</div>{role==='user'&&timeline.messages.some(message=>message.turnId===turn.id&&message.role==='user'&&message.truncated)&&<small>输入预览已缩略</small>}</div>; const reply=timeline.completedReplies.find(item=>item.turnId===turn.id); return text ? <div key={role}>{role==='agent'&&reply?runtime.renderView('aork.workbench.read-tracker@1',{sessionId:timeline.sessionId,activityId:reply.activityId,content}):content}</div> : null; })}
      {turn.attachments?.length ? <ul className={styles.attachments}>{turn.attachments.map(item=><li key={`${item.path}:${item.kind}`}>{item.path} · {item.kind} · {item.size} B</li>)}</ul>:null}
      {turn.detailsOmitted&&<p className={styles.hint}>配置或附件详情已缩略{turn.configurationRevision!==undefined?` · 配置版本 ${turn.configurationRevision}`:''}{turn.attachmentCount!==undefined?` · ${turn.attachmentCount} 个附件`:''}，可展开完整记录。</p>}
      <TurnDetails runtime={runtime} turnId={turn.id} label={`查看完整输入 ${turn.acceptanceOrder}`}/>
      <footer className={styles.turnStatus}><span>{turnLabels[turn.state]}</span>{turn.stopReason && <span>{turn.stopReason}</span>}{turn.usage ? <span>用量 {turn.usage.used} / {turn.usage.size} · {turn.usage.cost ? `${turn.usage.cost.amount} ${turn.usage.cost.currency}` : '费用未知'}</span> : <span>用量未知 · 费用未知</span>}</footer>
      {turn.reason && turn.state!=='removed' && <p className={styles.error}>{turn.reason}</p>}{turn.state==='removed'&&<p className={styles.hint}>已移除的输入保留在会话记录中。</p>}
      {turn.state === 'delivery_unknown' && <p className={styles.hint}>无法确认 Agent 是否收到输入。此输入不会自动重发。</p>}
      {turn.state === 'interrupted' && <p className={styles.hint}>执行连接已中断，已保存的内容仍保留。此输入不会自动重发。</p>}
    </article>)}
    {timeline?.truncated && <p role="status">此视图缩略或省略了部分内容；原始输入与配置可按轮次展开查看。</p>}
  </section>;
}
function SelectedReply({runtime,sessionId,activityId}:ViewProps&{sessionId:string;activityId:string}){
 const [after,setAfter]=useState('0');const [page,setPage]=useState<ReplyPage>();const [messages,setMessages]=useState<ReplyPage['messages']>([]);const [error,setError]=useState('');
 useEffect(()=>{let live=true;const stop=runtime.observeSnapshot('sessions.reply',{turnId:activityId,after},{next(value){const parsed=replyPageSchema.parse(value);if(parsed.sessionId!==sessionId)throw Error('Reply belongs to another Session');if(live){setPage(parsed);setMessages(current=>[...new Map([...current,...parsed.messages].map(message=>[message.id,message])).values()].sort((a,b)=>a.sequence-b.sequence));setError('');}},error(failure){if(live)setError(failure.message);}},{owners:['sessions']});return()=>{live=false;void stop();};},[runtime,sessionId,activityId,after]);
 const content=<article aria-label="选中的完成回复" className={styles.agentMessage}><div className={styles.messageText}>{messages.map(message=>message.text).join('')}</div></article>;
 return <section aria-label="会话消息"><button onClick={()=>{const values=new URLSearchParams(location.hash.slice(1));values.delete('reply');location.hash=values.toString();}}>返回会话时间线</button>{error&&<p role="alert">{error}</p>}{page&&!page.next&&!error?runtime.renderView('aork.workbench.read-tracker@1',{sessionId,activityId,content}):content}{page?.next&&<button onClick={()=>setAfter(page.next!)}>展开后续回复内容</button>}</section>;
}
function Tools({ runtime }: ViewProps) {
  const { sessionId } = useSelection(); const { timeline, error } = useTimeline(runtime, sessionId);
  if (!error && !timeline?.tools.length) return null;
  return <section className={styles.tools} aria-label="工具报告"><h3>工具报告</h3>{error && <p role="alert">{error}</p>}{timeline?.tools.map(tool => <details key={`${tool.turnId}:${tool.toolCallId}`} className={styles.tool}><summary><span>{tool.title}</span><small>{({ pending: '等待中', in_progress: '执行中', completed: '已完成', failed: '失败' })[tool.status]}</small></summary>{tool.text && <pre>{tool.text}</pre>}<p>Agent 的执行报告，仅供查看。</p></details>)}</section>;
}
interface Draft { text: string; attachments?:AttachmentReference[]; commandId: string; uncertain?: { text: string;attachments?:AttachmentReference[]; commandId: string } }
const drafts = new Map<string, Draft>();
function readDraft(key: string): Draft {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (saved && typeof saved === 'object' && 'text' in saved && typeof saved.text === 'string' && 'commandId' in saved && typeof saved.commandId === 'string') {
      const value = saved as Draft;
      if(attachmentReferenceSchema.array().max(4).safeParse(value.attachments??[]).success&&(!value.uncertain || (attachmentReferenceSchema.array().max(4).safeParse(value.uncertain.attachments??[]).success&&typeof value.uncertain.text === 'string' && typeof value.uncertain.commandId === 'string'))) return value;
    }
  } catch { /* Storage can be unavailable; the mounted composer still retains its command identity. */ }
  return drafts.get(key) ?? { text: '', commandId: crypto.randomUUID() };
}
const rejectedSendCodes = new Set(['SESSION_QUEUE_FULL','INVALID_PAYLOAD', 'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'SESSION_TURN_ACTIVE', 'RUN_NOT_READY', 'SESSION_DISPATCH_PAUSED', 'SESSION_UNAVAILABLE', 'RUNTIME_UNAVAILABLE','RUN_INPUT_UNSUPPORTED','RUN_INPUT_TOO_LARGE','RUN_INPUT_FORMAT_UNSUPPORTED','RUN_CONFIGURATION_BUSY','RUN_CONFIGURATION_CHANGED','WORKSPACE_PATH_INVALID','WORKSPACE_FILE_FAILED','WORKSPACE_SYMLINK_REJECTED','WORKSPACE_FILE_TOO_LARGE','WORKSPACE_NOT_FILE','WORKSPACE_PATH_OUTSIDE','WORKSPACE_DIRECTORY_CHANGED','WORKSPACE_READ_ONLY','WORKSPACE_FILE_CHANGED']);
function Composer({ runtime }: ViewProps) { const { sessionId } = useSelection(); return sessionId ? <SessionComposer key={sessionId} runtime={runtime} sessionId={sessionId} /> : null; }
function SessionComposer({ runtime, sessionId }: ViewProps & { sessionId: string }) {
  const { overview, error: queryError } = useSessions(runtime, sessionId);
  const { timeline, error: timelineError } = useTimeline(runtime, sessionId);
  const [allowNewContext,setAllowNewContext] = useState(false);
  const queueCommands=useRef(new Map<string,string>());
  const storageKey = `aork.composer:${runtime.bootstrap.access.identity}:${sessionId}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(storageKey));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [receivedTurn, setReceivedTurn] = useState<Turn>(); const [cancel, setCancel] = useState<{ turnId: string; commandId: string }>();
  const input = useRef<HTMLTextAreaElement>(null); const composing = useRef(false); const sending = useRef(false); const latestDraft = useRef(draft);
  const entry = overview?.sessions.find(item => item.session.id === sessionId);
  const queued=timeline?.turns.filter(item=>item.state==='queued'||item.state==='accepted')??[];
  const currentRun=entry&&entry.execution.state!=='not-started'?entry.execution:undefined;
  const newContext=Boolean(currentRun&&queued.some(item=>item.runId!==currentRun.runId||item.generation!==currentRun.generation));
  const authoritative = entry?.currentTurn;
  const turn = receivedTurn && (!authoritative || (receivedTurn.id === authoritative.id ? turnProgress(receivedTurn) > turnProgress(authoritative) : receivedTurn.acceptanceOrder >= authoritative.acceptanceOrder)) ? receivedTurn : authoritative;
  const working = Boolean(activeTurn(turn));
  const canSend = Boolean(entry && entry.session.status === 'open' && entry.execution.state === 'ready' && entry.environment.status === 'open' && entry.environment.directory.status === 'available' && !queryError && !(entry.execution.configuration&&['accepted','dispatching','delivery_unknown'].includes(entry.execution.configuration.state)));
  function update(next: Draft) { latestDraft.current = next; drafts.set(storageKey, next); try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* The in-memory draft remains available when browser storage is full or disabled. */ } setDraft(next); }
  useEffect(() => { if (receivedTurn && authoritative && ((authoritative.id === receivedTurn.id && turnProgress(authoritative) >= turnProgress(receivedTurn)) || authoritative.acceptanceOrder > receivedTurn.acceptanceOrder)) setReceivedTurn(undefined); }, [receivedTurn, authoritative]);
  useEffect(() => { input.current?.focus(); }, [sessionId]);
  useEffect(() => { const element = input.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; } }, [draft.text]);
  async function submit(retry = false) {
    const current = latestDraft.current; const attempt = retry ? current.uncertain : { text: current.text,...(current.attachments?.length?{attachments:current.attachments}:{}), commandId: current.commandId };
    if (!attempt || !attempt.text.trim() || sending.current || (!retry && (!canSend || current.uncertain))) return;
    const checked = sendTextSchema.safeParse({ sessionId, text: attempt.text,...(attempt.attachments?.length?{attachments:attempt.attachments}:{}) });
    if (!checked.success) { setError(checked.error.issues[0]?.message ?? '输入无效'); return; }
    sending.current = true; setBusy(true); setError('');
    update({ ...current, uncertain: attempt });
    try {
      const receipt = await runtime.command<CommandReceipt<Turn>>('sessions.sendText', { sessionId, text: attempt.text,...(attempt.attachments?.length?{attachments:attempt.attachments}:{}) }, attempt.commandId, { version: 1 });
      if (receipt.result.state !== 'queued' && receipt.result.state !== 'accepted') setReceivedTurn(receipt.result);
      const latest = latestDraft.current; update({ text: latest.text === attempt.text ? '' : latest.text,attachments:JSON.stringify(latest.attachments??[])===JSON.stringify(attempt.attachments??[])?[]:latest.attachments??[], commandId: crypto.randomUUID() });
      input.current?.focus();
    } catch (failure) {
      if (failure instanceof Error && 'code' in failure && typeof failure.code === 'string' && rejectedSendCodes.has(failure.code)) { const latest = latestDraft.current; update({ text: latest.text,attachments:latest.attachments??[], commandId: crypto.randomUUID() }); }
      else update({ ...latestDraft.current, uncertain: attempt });
      setError(failure instanceof Error ? failure.message : '发送结果未确认');
    }
    finally { sending.current = false; setBusy(false); }
  }
  async function cancelTurn() {
    if (!turn || !activeTurn(turn) || turn.state === 'cancelling' || busy) return;
    const attempt = cancel?.turnId === turn.id ? cancel : { turnId: turn.id, commandId: crypto.randomUUID() }; setCancel(attempt); setBusy(true); setError('');
    try { const receipt = await runtime.command<CommandReceipt<Turn>>('sessions.cancelTurn', { turnId: attempt.turnId }, attempt.commandId, { version: 1 }); setReceivedTurn(receipt.result); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '取消结果未确认，可重试'); }
    finally { setBusy(false); }
  }
  async function queueAction(name:'removeQueuedTurn'|'continueQueue',turnId?:string){
    if(busy)return;const key=name==='removeQueuedTurn'?`${name}:${turnId}`:`${name}:${currentRun?.runId}:${allowNewContext}`;const commandId=queueCommands.current.get(key)??crypto.randomUUID();queueCommands.current.set(key,commandId);setBusy(true);setError('');
    try{await runtime.command(`sessions.${name}`,name==='removeQueuedTurn'?{turnId}:{sessionId,runId:currentRun?.runId,allowNewContext},commandId,{version:1});queueCommands.current.delete(key);}
    catch(failure){setError(failure instanceof Error?failure.message:'队列操作结果未确认，可重试');}finally{setBusy(false);}
  }
  const inputContext:SessionInputContext={version:1,sessionId,attachments:draft.attachments??[],disabled:busy||Boolean(draft.uncertain),onAttachmentsChange(attachments){update({...latestDraft.current,attachments,commandId:crypto.randomUUID()});}};
  return <section className={styles.composerArea} aria-label="会话输入">
    {(queued.length>0||entry?.dispatchPaused)&&<section className={styles.queue} aria-label="待发队列"><header><strong>待发队列 · {queued.length}</strong><span>{entry?.dispatchPaused?'已暂停':'按受理顺序执行'}</span></header>
      <ol>{queued.map(item=><li key={item.id}><span>{timeline?.messages.find(message=>message.id===`${item.id}:user`)?.text??'已保存的输入（文本未包含在有界视图）'}{timeline?.messages.find(message=>message.id===`${item.id}:user`)?.truncated&&<small>（预览已缩略）</small>}</span><button type="button" aria-label={`移除排队输入 ${item.acceptanceOrder}`} disabled={busy} onClick={()=>void queueAction('removeQueuedTurn',item.id)}>移除</button><TurnDetails runtime={runtime} turnId={item.id} label={`查看完整排队输入 ${item.acceptanceOrder}`}/></li>)}</ol>
      {entry?.dispatchPaused&&<><p role="status">会话派发已暂停。继续只执行排队输入；交付结果未知或已中断的输入不会重发。</p>{newContext&&<label><input type="checkbox" checked={allowNewContext} onChange={event=>setAllowNewContext(event.target.checked)}/>我选择在当前新运行的原生上下文中执行这些排队输入</label>}<button type="button" disabled={busy||working||!canSend||Boolean(timelineError)||(newContext&&!allowNewContext)} onClick={()=>void queueAction('continueQueue')}>继续队列</button></>}
    </section>}
    {runtime.renderView(SESSION_INPUT_OPTIONS,inputContext)}
    {runtime.renderExtensions(SESSION_INPUT_EXTENSIONS,inputContext)}
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className={styles.inputLabel} htmlFor={`message-${sessionId}`}>消息输入</label>
      <textarea ref={input} id={`message-${sessionId}`} value={draft.text} maxLength={16000} rows={1} placeholder="描述你想完成的工作…" onChange={event => update({ ...latestDraft.current, text: event.target.value, commandId: crypto.randomUUID() })} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; void submit(); } }} />
      <footer className={styles.composerFooter}><div><span title={entry?.session.providerLabel}>{entry?.session.profile.name ?? 'Agent'}</span><small>{canSend?(working||entry?.dispatchPaused?'Enter 加入队列 · Shift+Enter 换行':'Enter 发送 · Shift+Enter 换行'):'启动运行后可发送'}</small></div>{working ? <button type="button" disabled={busy || turn?.state === 'cancelling'} onClick={() => void cancelTurn()}>{turn?.state === 'cancelling' ? '取消中…' : '取消当前轮次'}</button> : null}<button type="submit" className={styles.send} disabled={busy || !canSend || !draft.text.trim() || Boolean(draft.uncertain)} aria-label="发送消息" title={working||entry?.dispatchPaused?'加入队列':'发送消息'}>↑</button></footer>
    </form>
    {draft.uncertain && <div className={styles.retry} role="status"><p>发送结果未确认。重试会查询或受理同一条输入，不会创建另一轮。</p><button disabled={busy} onClick={() => void submit(true)}>重试原输入</button></div>}
    {(error || queryError || timelineError) && <p role="alert" className={styles.error}>{error || queryError || timelineError}</p>}
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
  return <section className={styles.navigation} aria-label="会话导航">
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
function Detail({ runtime, context }: ViewProps) {
  const chosen = useSelection(); const [revision, setRevision] = useState(0); const { overview, error, projectionError, environmentError } = useSessions(runtime, `${chosen.sessionId}:${revision}`);
  const [archive, setArchive] = useState<{ id: string; commandId: string }>(); const [busy, setBusy] = useState(false); const [archiveError, setArchiveError] = useState('');
  const [runError,setRunError]=useState('');
  const entry = overview?.sessions.find(item => item.session.id === chosen.sessionId); const session = entry?.session;
  if(context==='menu'&&(!overview||!session||!entry))return null;
  if(context==='header'&&(!overview||!session||!entry))return <span>会话</span>;
  if (error && !overview) return <div className={styles.detail}><p role="alert">{error}</p></div>;
  if (!overview) return <div className={styles.detail}><p role="status">正在加载会话…</p></div>;
  if (!session || !entry) return <div className={styles.detail}><h2>会话不可用</h2><p>此身份无法访问所选会话，或会话不存在。</p></div>;
  if(context==='header'&&(!session||!entry||session.projectId!==chosen.projectId||session.workspaceId!==chosen.workspaceId))return <span>会话环境待确认</span>;
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
  const header=<header className={styles.header}><h2>{session.name}</h2><span>{({'not-started':'尚未启动',starting:'正在启动',ready:'运行已就绪',stopping:'正在结束',stopped:'运行已结束',unknown:'运行状态未知'})[entry.execution.state]}</span></header>;
  const archiveModal=archive && <Modal title="归档会话" busy={busy} close={() => setArchive(undefined)}><form onSubmit={submitArchive}><p>保留会话历史、配置和工作区关联。归档不会停止 Run 或释放工作区占用。</p>{archiveError && <p role="alert" className={styles.error}>{archiveError}</p>}<footer><button type="button" disabled={busy} onClick={() => setArchive(undefined)}>取消</button><button autoFocus type="submit" disabled={busy}>{busy ? '正在归档…' : '确认归档'}</button></footer></form></Modal>;
  if(context==='header')return header;
  if(context==='menu')return <>{['starting','ready'].includes(entry.execution.state)&&<button disabled={busy} onClick={()=>void changeRun('end')}>结束运行</button>}{session.status==='open'&&<button onClick={()=>{setArchiveError('');setArchive({id:session.id,commandId:crypto.randomUUID()});}}>归档会话</button>}{runError&&<p role="alert">{runError}</p>}{archiveModal}</>;
  return <section className={styles.detail} aria-label="会话详情">{!(context&&typeof context==='object'&&'embedded' in context)&&header}
    <div className={styles.body}>{session.status === 'archived' && <p role="status">会话已归档，历史与关联保留。</p>}
      {projectionError && <p role="alert" className={styles.error}>会话状态更新失败，已保存历史仍可查看；等待重新同步。{projectionError}</p>}
      {environmentError && <p role="alert" className={styles.error}>工作区状态检查失败，保留上次观察结果；启动和发送暂不可用。{environmentError}</p>}
      {entry.environment.status !== 'open' && <p role="status">工作区或项目已归档或不可用。</p>}
      {entry.environment.directory.status !== 'available' && <p role="status">目录不可用；历史仍保留，启动前须重新验证工作区。</p>}
      {(['not-started','stopped'].includes(entry.execution.state)||runError)&&<section className={styles.runToolbar} aria-label="运行控制">
        {session.status==='open'&&['not-started','stopped'].includes(entry.execution.state)&&<button className={styles.primary} disabled={busy||Boolean(error)||entry.environment.status!=='open'||entry.environment.directory.status!=='available'} onClick={()=>void changeRun('start')}>启动运行</button>}
        {runError&&<p role="alert">{runError}</p>}
      </section>}
      {!(context&&typeof context==='object'&&'embedded' in context)&&runtime.renderView('aork.sessions.actions@1')}
      {['unknown','stopped'].includes(entry.execution.state)&&entry.execution.state!=='not-started'&&<ReconciliationPanel key={entry.execution.runId} runtime={runtime} runId={entry.execution.runId} state={entry.execution.state}/>}
      {runtime.renderView(SESSION_MESSAGES)}
      {runtime.renderView(SESSION_TOOLS)}
      {runtime.renderView(INTERACTION_CARDS)}
      {runtime.renderView(INPUT_CARDS)}
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
export function activate(context: ClientPluginContext) { context.registerExtension('menu-actions',({runtime})=>new URLSearchParams(location.hash.slice(1)).get('session')?<>{runtime.renderView('aork.sessions.actions@1')}</>:null); context.registerView('actions',props=><Detail {...props} context="menu"/>);context.registerView('header',props=><Detail {...props} context="header"/>); context.registerView('navigation', Navigation); context.registerView('create', Create); context.registerView('detail', Detail); context.registerView('composer', Composer); context.registerView('messages', Messages); context.registerView('tools', Tools); context.registerView('input-options',InputOptions); }
