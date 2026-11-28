import {Recovery,NativeHistory} from './recovery.js';
import{SESSION_RECOVERY,SESSION_NATIVE_HISTORY}from'@aork/contracts/recovery';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import { overviewSchema as agentsOverviewSchema } from '@aork/contracts/agent';
import type { AgentsOverview } from '@aork/contracts/agent';
import { SESSION_COMPOSER, SESSION_CREATE, SESSION_MESSAGES, SESSION_TOOLS, sendTextSchema, sessionsOverviewSchema, sessionsProjectionSchema, sessionEnvironmentsSchema, sessionTimelineSchema, replyPageSchema } from '@aork/contracts/session';
import type { Session, SessionsOverview, SessionsProjection, SessionTimeline, Turn, ReplyPage } from '@aork/contracts/session';
import {TOOL_SELECTION} from '@aork/contracts/tools';

import { INPUT_CARDS } from '@aork/contracts/structured-input';

import { INTERACTION_CARDS } from '@aork/contracts/interaction';
import { InputOptions } from './input-options.js';
import { Handoff, Linkage, HandoffModalHost } from './handoff.js';
import { TurnDetails } from './turn-detail.js';
import { ReconciliationPanel } from './reconciliation.js';
import { SESSION_INPUT_OPTIONS,SESSION_INPUT_EXTENSIONS,attachmentTarget } from '@aork/contracts/input';
import type { SessionInputContext } from '@aork/contracts/input';
import { composerState } from './composer-draft.js';
import { SessionRows } from './session-rows.js';
import { WorkspacePickerField } from './workspace-picker.js';
import styles from './sessions.module.css';
import createStyles from './create-session.module.css';

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
      {turn.attachments?.length ? <ul className={styles.attachments}>{turn.attachments.map(item=>{const target=attachmentTarget(item);return <li key={`${target.kind==='workspace-file'?target.path:target.versionId}:${item.kind}`}>{target.kind==='workspace-file'?target.path:`产物版本 ${target.versionId}`} · {item.kind} · {item.size} B</li>;})}</ul>:null}
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
const rejectedSendCodes = new Set(['SESSION_QUEUE_FULL','INVALID_PAYLOAD', 'INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'SESSION_TURN_ACTIVE', 'RUN_NOT_READY', 'SESSION_DISPATCH_PAUSED', 'SESSION_UNAVAILABLE', 'RUNTIME_UNAVAILABLE','RUN_INPUT_UNSUPPORTED','RUN_INPUT_TOO_LARGE','RUN_INPUT_FORMAT_UNSUPPORTED','RUN_CONFIGURATION_BUSY','RUN_CONFIGURATION_CHANGED','WORKSPACE_PATH_INVALID','WORKSPACE_FILE_FAILED','WORKSPACE_SYMLINK_REJECTED','WORKSPACE_FILE_TOO_LARGE','WORKSPACE_NOT_FILE','WORKSPACE_PATH_OUTSIDE','WORKSPACE_DIRECTORY_CHANGED','WORKSPACE_FILE_CHANGED']);
function Composer({ runtime }: ViewProps) { const { sessionId } = useSelection(); return sessionId ? <SessionComposer key={sessionId} runtime={runtime} sessionId={sessionId} /> : null; }
function SessionComposer({ runtime, sessionId }: ViewProps & { sessionId: string }) {
  const { overview, error: queryError } = useSessions(runtime, sessionId);
  const { timeline, error: timelineError } = useTimeline(runtime, sessionId);
  const [allowNewContext,setAllowNewContext] = useState(false);
  const queueCommands=useRef(new Map<string,string>());
  const store = composerState(`aork.composer:${runtime.bootstrap.access.identity}:${sessionId}`);
  const { draft, operation } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [receivedTurn, setReceivedTurn] = useState<Turn>(); const [cancel, setCancel] = useState<{ turnId: string; commandId: string }>();
  const input = useRef<HTMLTextAreaElement>(null); const composing = useRef(false);
  const entry = overview?.sessions.find(item => item.session.id === sessionId);
  const queued=timeline?.turns.filter(item=>item.state==='queued'||item.state==='accepted')??[];
  const currentRun=entry&&entry.execution.state!=='not-started'?entry.execution:undefined;
  const newContext=Boolean(currentRun&&queued.some(item=>item.runId!==currentRun.runId||item.generation!==currentRun.generation));
  const authoritative = entry?.currentTurn;
  const turn = receivedTurn && (!authoritative || (receivedTurn.id === authoritative.id ? turnProgress(receivedTurn) > turnProgress(authoritative) : receivedTurn.acceptanceOrder >= authoritative.acceptanceOrder)) ? receivedTurn : authoritative;
  const working = Boolean(activeTurn(turn));
  const canSend = Boolean(entry && entry.session.status === 'open' && entry.execution.state === 'ready' && entry.environment.status === 'open' && entry.environment.directory.status === 'available' && !queryError && !(entry.execution.configuration&&['accepted','dispatching','delivery_unknown'].includes(entry.execution.configuration.state)));
  useEffect(() => { if (receivedTurn && authoritative && ((authoritative.id === receivedTurn.id && turnProgress(authoritative) >= turnProgress(receivedTurn)) || authoritative.acceptanceOrder > receivedTurn.acceptanceOrder)) setReceivedTurn(undefined); }, [receivedTurn, authoritative]);
  useEffect(() => { input.current?.focus(); }, [sessionId]);
  useEffect(() => { const element = input.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; } }, [draft.text]);
  async function submit(retry = false) {
    const { draft: current, operation } = store.getSnapshot();
    if (operation || (!retry && (!canSend || current.uncertain))) return;
    const attempt = retry ? current.uncertain : { text: current.text, commandId: current.commandId, ...(current.attachments?.length ? { attachments: current.attachments } : {}) };
    if (!attempt?.text.trim()) return;
    const payload = { sessionId, text: attempt.text, ...(attempt.attachments?.length ? { attachments: attempt.attachments } : {}) };
    const checked = sendTextSchema.safeParse(payload);
    if (!checked.success) { setError(checked.error.issues[0]?.message ?? '输入无效'); return; }
    store.setOperation('send');
    setError('');
    store.save({ ...current, uncertain: attempt });
    try {
      const receipt = await runtime.command<CommandReceipt<Turn>>('sessions.sendText', payload, attempt.commandId, { version: 1 });
      if (receipt.result.state !== 'queued' && receipt.result.state !== 'accepted') setReceivedTurn(receipt.result);
      const latest = store.getSnapshot().draft;
      store.save({
        text: latest.commandId === attempt.commandId ? '' : latest.text,
        attachments: JSON.stringify(latest.attachments ?? []) === JSON.stringify(attempt.attachments ?? []) ? [] : latest.attachments ?? [],
        commandId: crypto.randomUUID(),
      });
      input.current?.focus();
    } catch (failure) {
      if (failure instanceof Error && 'code' in failure && typeof failure.code === 'string' && rejectedSendCodes.has(failure.code)) {
        const { text, attachments = [] } = store.getSnapshot().draft;
        store.save({ text, attachments, commandId: crypto.randomUUID() });
      }
      setError(failure instanceof Error ? failure.message : '发送结果未确认');
    }
    finally { store.setOperation(null); }
  }
  async function cancelTurn() {
    if (!turn || !activeTurn(turn) || turn.state === 'cancelling' || store.getSnapshot().operation) return;
    const attempt = cancel?.turnId === turn.id ? cancel : { turnId: turn.id, commandId: crypto.randomUUID() }; setCancel(attempt); store.setOperation('turn-control'); setError('');
    try { const receipt = await runtime.command<CommandReceipt<Turn>>('sessions.cancelTurn', { turnId: attempt.turnId }, attempt.commandId, { version: 1 }); setReceivedTurn(receipt.result); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '取消结果未确认，可重试'); }
    finally { store.setOperation(null); }
  }
  async function queueAction(name:'removeQueuedTurn'|'continueQueue',turnId?:string){
    if(store.getSnapshot().operation)return;const key=name==='removeQueuedTurn'?`${name}:${turnId}`:`${name}:${currentRun?.runId}:${allowNewContext}`;const commandId=queueCommands.current.get(key)??crypto.randomUUID();queueCommands.current.set(key,commandId);store.setOperation('turn-control');setError('');
    try{await runtime.command(`sessions.${name}`,name==='removeQueuedTurn'?{turnId}:{sessionId,runId:currentRun?.runId,allowNewContext},commandId,{version:1});queueCommands.current.delete(key);}
    catch(failure){setError(failure instanceof Error?failure.message:'队列操作结果未确认，可重试');}finally{store.setOperation(null);}
  }
  const inputContext:SessionInputContext={version:1,sessionId,attachments:draft.attachments??[],disabled:busy||Boolean(draft.uncertain),onAttachmentsChange(attachments){
    const { draft: current, operation } = store.getSnapshot();
    if (!operation && !current.uncertain) store.save({ ...current, attachments, commandId: crypto.randomUUID() });
  }};
  return <section className={styles.composerArea} aria-label="会话输入">
    <div className={styles.inputAccessories}>
    {(queued.length>0||entry?.dispatchPaused)&&<section className={styles.queue} aria-label="待发队列"><header><strong>待发队列 · {queued.length}</strong><span>{entry?.dispatchPaused?'已暂停':'按受理顺序执行'}</span></header>
      <ol>{queued.map(item=><li key={item.id}><span>{timeline?.messages.find(message=>message.id===`${item.id}:user`)?.text??'已保存的输入（文本未包含在有界视图）'}{timeline?.messages.find(message=>message.id===`${item.id}:user`)?.truncated&&<small>（预览已缩略）</small>}</span><button type="button" aria-label={`移除排队输入 ${item.acceptanceOrder}`} disabled={busy} onClick={()=>void queueAction('removeQueuedTurn',item.id)}>移除</button><TurnDetails runtime={runtime} turnId={item.id} label={`查看完整排队输入 ${item.acceptanceOrder}`}/></li>)}</ol>
      {entry?.dispatchPaused&&<><p role="status">会话派发已暂停。继续只执行排队输入；交付结果未知或已中断的输入不会重发。</p>{newContext&&<label><input type="checkbox" checked={allowNewContext} onChange={event=>setAllowNewContext(event.target.checked)}/>我选择在当前新运行的原生上下文中执行这些排队输入</label>}<button type="button" disabled={busy||working||!canSend||Boolean(timelineError)||(newContext&&!allowNewContext)} onClick={()=>void queueAction('continueQueue')}>继续队列</button></>}
    </section>}
      {runtime.renderView(SESSION_INPUT_OPTIONS,inputContext)}
      {runtime.renderExtensions(SESSION_INPUT_EXTENSIONS,inputContext)}
    </div>
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className={styles.inputLabel} htmlFor={`message-${sessionId}`}>消息输入</label>
      <textarea ref={input} id={`message-${sessionId}`} value={draft.text} maxLength={16000} rows={1} placeholder="描述你想完成的工作…" onChange={event => store.save({ ...store.getSnapshot().draft, text: event.target.value, commandId: crypto.randomUUID() })} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; void submit(); } }} />
      <footer className={styles.composerFooter}><div><span title={entry?.session.providerLabel}>{entry?.session.profile.name ?? 'Agent'}</span><small>{canSend?(working||entry?.dispatchPaused?'Enter 加入队列 · Shift+Enter 换行':'Enter 发送 · Shift+Enter 换行'):'启动运行后可发送'}</small></div>{working ? <button type="button" disabled={busy || turn?.state === 'cancelling'} onClick={() => void cancelTurn()}>{turn?.state === 'cancelling' ? '取消中…' : '取消当前轮次'}</button> : null}<button type="submit" className={styles.send} disabled={busy || !canSend || !draft.text.trim() || Boolean(draft.uncertain)} aria-label="发送消息" title={working||entry?.dispatchPaused?'加入队列':'发送消息'}>↑</button></footer>
    </form>
    {operation === 'send' && <p className={styles.hint} role="status">正在提交消息…</p>}
    {draft.uncertain && operation !== 'send' && <div className={styles.retry} role="status"><p>发送结果未确认。重试会查询或受理同一条输入，不会创建另一轮。</p><button disabled={busy} onClick={() => void submit(true)}>重试原输入</button></div>}
    {(error || queryError || timelineError) && <p role="alert" className={styles.error}>{error || queryError || timelineError}</p>}
  </section>;
}
function Modal({ title, busy, close, children }: { title: string; busy: boolean; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); }; }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) close(); }}><h2>{title}</h2>{children}</dialog>;
}
function creationScope({ workspaceId, sessionId }: ReturnType<typeof readWorkbenchSelection>) {
  return `${workspaceId}:${sessionId}`;
}
function CreateForm({ runtime, chosen, close, inline }: ViewProps & { chosen: ReturnType<typeof readWorkbenchSelection>; close(): void; inline: boolean }) {
  const composing = useRef(false);
  const mounted = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const headingId = useId();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (!inline) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The mobile navigation drawer restores its opener as it closes on route change.
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (!restoreFocus.current) return;
      requestAnimationFrame(() => {
        const candidates = [
          opener,
          ...document.querySelectorAll<HTMLElement>('[data-create-session-trigger]'),
          document.querySelector<HTMLElement>('[data-workbench-navigation-toggle]'),
        ];
        const visible = candidates.find(element => element && element !== document.body && element.getClientRects().length && !element.closest('[inert]'));
        visible?.focus({ preventScroll: true });
      });
    };
  }, [inline]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOverview>();
  const [agents, setAgents] = useState<AgentsOverview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({ name: '', workspaceId: chosen.workspaceId ?? '', profileId: '', commandId: crypto.randomUUID() }));
  useEffect(() => {
    let active = true;
    const stops = [
      runtime.subscribe<WorkspaceOverview>('workspace.overview', {
        next(value) { if (active) setWorkspaces(workspaceOverviewSchema.parse(value)); },
        error(failure) { if (active) setError(failure.message); },
      }, { intervalMs: 1000 }),
      runtime.subscribe<AgentsOverview>('agents.overview', {
        next(value) { if (active) setAgents(agentsOverviewSchema.parse(value)); },
        error(failure) { if (active) setError(failure.message); },
      }),
    ];
    return () => {
      active = false;
      for (const stop of stops) void stop();
    };
  }, [runtime]);
  const workspace = workspaces?.workspaces.find(item => item.id === form.workspaceId);
  const profile = agents?.profiles.find(item => item.profile.id === form.profileId);
  const provider = agents?.providers.find(item => item.id === profile?.profile.providerId);
  const update = (value: Partial<typeof form>) => setForm(current => ({ ...current, ...value, commandId: crypto.randomUUID() }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { name, workspaceId, profileId, commandId } = form;
      const receipt = await runtime.command<CommandReceipt<Session>>('sessions.create', { name, workspaceId, profileId }, commandId, { version: 1 });
      const currentHash = location.hash;
      const current = readWorkbenchSelection(currentHash);
      if (mounted.current && current.creatingSession && creationScope(current) === creationScope(chosen)) {
        location.hash = withWorkbenchSelection(currentHash, { workspaceId: receipt.result.workspaceId, sessionId: receipt.result.id, creatingSession: false });
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '创建失败，可使用同一命令重试');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const cancel = () => {
    restoreFocus.current = inline;
    close();
  };
  const workspaceField = <label>工作区
    <WorkspacePickerField runtime={runtime} workspaces={workspaces?.workspaces ?? []} value={form.workspaceId} onChange={id => update({ workspaceId: id })} />
  </label>;
  const profileField = <label>Agent Profile
    <select required value={form.profileId} onChange={event => update({ profileId: event.target.value })}>
      <option value="">选择 Agent Profile</option>
      {agents?.profiles.map(({ profile }) => <option key={profile.id} value={profile.id}>{profile.name} · {agents.providers.find(candidate => candidate.id === profile.providerId)?.label ?? profile.providerId}</option>)}
    </select>
  </label>;
  const fields = <form onSubmit={submit} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
    const isComposing = composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && isComposing) event.preventDefault();
    if (inline && !busy && event.key === 'Escape' && !event.defaultPrevented && !isComposing && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      cancel();
    }
  }}>
    <fieldset disabled={busy}>
      <label className={inline ? createStyles.name : undefined}>会话名称
        <input ref={input} autoFocus={!inline} required maxLength={120} placeholder={inline ? '输入会话名称' : undefined} value={form.name} onChange={event => update({ name: event.target.value })} />
      </label>
      {inline ? <div className={createStyles.selectors}>{workspaceField}{profileField}</div> : workspaceField}
      {workspace && <p className={styles.path}>{workspace.directory}</p>}
      {!inline && profileField}
      {agents && !agents.profiles.length && <p>尚无 Agent Profile，请先在设置的 Agent 页面保存配置。</p>}
      {profile && <div className={styles.selection}>
        <p>{provider?.label ?? profile.profile.providerId}</p>
        <small>{profile.profile.providerId} · 配置版本 {profile.profile.revision}</small>
        {profile.availability !== 'available' && <p>当前配置不可用（{profile.reason}）；创建会话不会启动 Agent。</p>}
      </div>}
      <p>创建后尚未启动</p>
    </fieldset>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer>
      <button type="button" disabled={busy} onClick={cancel}>取消</button>
      <button type="submit" className={inline ? createStyles.primary : styles.primary} disabled={busy || !workspace || !profile}>{busy ? '正在创建…' : '创建会话'}</button>
    </footer>
  </form>;
  return inline ? <section className={createStyles.surface} aria-labelledby={headingId}>
    <div className={createStyles.stack}>
      <h1 id={headingId}>新建会话</h1>
      {fields}
    </div>
  </section> : <Modal title="新建会话" busy={busy} close={close}>{fields}</Modal>;
}
function Create({ runtime, context }: ViewProps) {
  const chosen = useSelection();
  const close = () => { location.hash = withWorkbenchSelection(location.hash, { creatingSession: false }); };
  const inline = Boolean(context && typeof context === 'object' && 'inline' in context && context.inline === true);
  return chosen.creatingSession ? <CreateForm key={creationScope(chosen)} runtime={runtime} chosen={chosen} close={close} inline={inline} /> : null;
}
function Detail(props: ViewProps) {
  const chosen = useSelection();
  return <SessionDetail key={`${chosen.workspaceId}:${chosen.sessionId}`} {...props} chosen={chosen}/>;
}
function SessionDetail({ runtime, context, chosen }: ViewProps & { chosen: ReturnType<typeof readWorkbenchSelection> }) {
  const [revision, setRevision] = useState(0); const { overview, error, projectionError, environmentError } = useSessions(runtime, revision);
  const [busy, setBusy] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [runError,setRunError]=useState('');
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (chosen.replyId && transcript.current) transcript.current.scrollTop = 0;
  }, [chosen.replyId]);
  const entry = overview?.sessions.find(item => item.session.id === chosen.sessionId); const session = entry?.session;
  if(context==='menu'&&(!overview||!session||!entry))return null;
  if(context==='header'&&(!overview||!session||!entry))return <span>会话</span>;
  if (error && !overview) return <div className={styles.detail}><p role="alert">{error}</p></div>;
  if (!overview) return <div className={styles.detail}><p role="status">正在加载会话…</p></div>;
  if (!session || !entry) return <div className={styles.detail}><h2>会话不可用</h2><p>此身份无法访问所选会话，或会话不存在。</p></div>;
  if(context==='header'&&(!session||!entry||session.workspaceId!==chosen.workspaceId))return <span>会话环境待确认</span>;
  if (session.workspaceId !== chosen.workspaceId) return <div className={styles.detail}><h2>会话与所选环境不匹配</h2><button onClick={() => { location.hash = withWorkbenchSelection(location.hash, { workspaceId: session.workspaceId }); }}>打开会话所属工作区</button></div>;
  async function changeRun(action:'start'|'end') {
    if(!session||!entry||busy)return;setBusy(true);setRunError('');
    try {await runtime.command(action==='start'?'sessions.startRun':'sessions.endRun',action==='start'?{sessionId:session.id}:{runId:entry.execution.state==='not-started'?'':entry.execution.runId},crypto.randomUUID(),{version:1});setRevision(value=>value+1);}
    catch(failure){setRunError(failure instanceof Error?failure.message:'运行操作失败');}finally{setBusy(false);}
  }
  const header = <header className={styles.header}>
    <span className={styles.workspaceCrumb} title={session.workspace.name}>{session.workspace.name}</span>
    <span aria-hidden="true">/</span>
    <h2 title={session.name}>{session.name}</h2>
    <span>{({'not-started':'尚未启动',starting:'正在启动',ready:'运行已就绪',stopping:'正在结束',stopped:'运行已结束',unknown:'运行状态未知'})[entry.execution.state]}</span>
  </header>;
  if(context==='header')return header;
  if(context==='menu')return <>{['starting','ready'].includes(entry.execution.state)&&<button disabled={busy} onClick={()=>void changeRun('end')}>结束运行</button>}<button onClick={()=>setHandoffOpen(true)}>交接到新会话…</button>{runError&&<p role="alert">{runError}</p>}{handoffOpen&&<HandoffModalHost runtime={runtime} sourceSessionId={session.id} close={()=>setHandoffOpen(false)} busy={false}/>}</>;
  const embedded = Boolean(context && typeof context === 'object' && 'embedded' in context);
  return <section className={`${styles.detail}${embedded ? ` ${styles.embeddedDetail}` : ''}`} aria-label="会话详情">{!embedded && header}
    <div className={styles.transcript} ref={transcript} tabIndex={embedded ? 0 : undefined} aria-label={embedded ? '会话记录' : undefined} role={embedded ? 'region' : undefined}>
    <div className={styles.body}>{session.status === 'archived' && <p role="status">会话已归档，历史与关联保留。</p>}
      {projectionError && <p role="alert" className={styles.error}>会话状态更新失败，已保存历史仍可查看；等待重新同步。{projectionError}</p>}
      {environmentError && <p role="alert" className={styles.error}>工作区状态检查失败，保留上次观察结果；启动和发送暂不可用。{environmentError}</p>}
      {entry.environment.status !== 'open' && <p role="status">工作区不可用。</p>}
      {entry.environment.directory.status !== 'available' && <p role="status">目录不可用；历史仍保留，启动前须重新验证工作区。</p>}
      {(entry.execution.state==='not-started'||runError)&&<section className={styles.runToolbar} aria-label="运行控制">
        {session.status==='open'&&entry.execution.state==='not-started'&&<button className={styles.primary} disabled={busy||Boolean(error)||entry.environment.status!=='open'||entry.environment.directory.status!=='available'} onClick={()=>void changeRun('start')}>启动运行</button>}
        {runError&&<p role="alert">{runError}</p>}
      </section>}
      {(session.linkedFrom||entry.linkedTo.length>0)&&<Linkage runtime={runtime} session={session} ready={entry.execution.state==='ready'} workspaceOpen={entry.environment.status==='open'} linkedTo={entry.linkedTo}/>}
      {runtime.renderView(TOOL_SELECTION)}
      {['unknown','stopped'].includes(entry.execution.state)&&entry.execution.state!=='not-started'&&<ReconciliationPanel key={entry.execution.runId} runtime={runtime} runId={entry.execution.runId} state={entry.execution.state}/>}
      {runtime.renderView(SESSION_RECOVERY)}

      {runtime.renderView(SESSION_MESSAGES)}
      {runtime.renderView(SESSION_NATIVE_HISTORY)}
      {runtime.renderView(SESSION_TOOLS)}
      {runtime.renderView(INTERACTION_CARDS)}
      {runtime.renderView(INPUT_CARDS)}
      {entry.execution.state==='not-started' && <p className={styles.hint}>尚无原生历史，不能原生恢复。</p>}
      <details className={styles.runDetails}><summary>会话与运行详情</summary>
      <dl><dt>Agent</dt><dd>{session.providerLabel} <small>({session.profile.providerId})</small></dd><dt>配置</dt><dd>{session.profile.name} · 版本 {session.profile.revision}</dd><dt>真实目录</dt><dd className={styles.path}>{session.workspace.directory}</dd><dt>会话身份</dt><dd className={styles.path}>{session.id}</dd></dl>
      <section aria-label="运行信息">
        {entry.execution.state!=='not-started'&&<>
          <dl><dt>运行身份</dt><dd>{entry.execution.runId}</dd><dt>连接代次</dt><dd>{entry.execution.generation}</dd><dt>检测版本</dt><dd>{entry.execution.detectedVersion}</dd><dt>Node / ACP SDK</dt><dd>{entry.execution.runtime.nodeVersion} / {entry.execution.runtime.acpSdkVersion}</dd><dt>ACP 协议</dt><dd>{entry.execution.protocolVersion??'尚未协商'}</dd><dt>Agent 版本</dt><dd>{entry.execution.agentVersion??(entry.execution.state==='starting'?'尚未返回':'未报告')}</dd><dt>原生恢复能力</dt><dd>{entry.execution.loadSession===undefined?'尚未协商':entry.execution.loadSession?'Agent 声明支持；恢复时再次验证':'不支持'}</dd><dt>子进程环境</dt><dd>仅 {entry.execution.environment.names.join('、')}，不继承 Host 环境</dd></dl>
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
    </div>
    <div className={styles.composerDock}>
      <div className={styles.body}>{runtime.renderView(SESSION_COMPOSER)}</div>
    </div>
  </section>;
}
function SessionMenuActions({ runtime }: ViewProps) {
  const { sessionId, creatingSession } = useSelection();
  if (!sessionId || (creatingSession && runtime.bootstrap.ui.providers[SESSION_CREATE] === 'sessions:create')) return null;
  return <>{runtime.renderView('aork.sessions.actions@1')}</>;
}

export function activate(context: ClientPluginContext) { context.registerView('recovery',Recovery); context.registerView('native-history',NativeHistory); context.registerView('handoff',Handoff); context.registerExtension('menu-actions',SessionMenuActions); context.registerView('actions',props=><Detail {...props} context="menu"/>);context.registerView('header',props=><Detail {...props} context="header"/>); context.registerView('rows', SessionRows); context.registerView('create', Create); context.registerView('detail', Detail); context.registerView('composer', Composer); context.registerView('messages', Messages); context.registerView('tools', Tools); context.registerView('input-options',InputOptions); }
