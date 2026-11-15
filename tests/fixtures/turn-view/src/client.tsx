import { useEffect, useRef, useState } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { sessionTimelineSchema, sessionsOverviewSchema } from '@aork/contracts/session';
import type { SessionTimeline, SessionsOverview, Turn } from '@aork/contracts/session';
function useSelected() {
  const read = () => new URLSearchParams(location.hash.slice(1)).get('session');
  const [id, setId] = useState(read);
  useEffect(() => { const update = () => setId(read()); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  return id;
}
function usePublicSession(runtime: UiRuntime) {
  const id = useSelected(); const [overview, setOverview] = useState<SessionsOverview>(); const [timeline, setTimeline] = useState<SessionTimeline>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const stop = runtime.subscribe('sessions.overview', { async next(value) {
      try {
        const parsed = sessionsOverviewSchema.parse(value);
        const result = id ? await runtime.resource('sessions.timeline', { sessionId: id }) : undefined;
        if (active) { setOverview(parsed); setTimeline(result ? sessionTimelineSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes))) : undefined); setError(''); }
      } catch (failure) { if (active) setError(String(failure)); }
    }, error(failure) { if (active) setError(failure.message); } }, { intervalMs: 500 });
    return () => { active = false; void stop(); };
  }, [runtime, id]);
  return { entry: overview?.sessions.find(item => item.session.id === id), timeline, error };
}
function Composer({ runtime }: ViewProps) {
  const { entry, error } = usePublicSession(runtime); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [failure, setFailure] = useState(''); const commandId = useRef(crypto.randomUUID()); const composition = useRef(false); const accepted = useRef<Turn>();
  const turn = entry?.currentTurn?.id === accepted.current?.id ? entry?.currentTurn : accepted.current ?? entry?.currentTurn;
  const working = turn && ['accepted', 'dispatching', 'running', 'cancelling'].includes(turn.state);
  return <section aria-label="独立输入视图"><form onSubmit={async event => {
    event.preventDefault(); if (!entry || busy || working || !text.trim() || entry.execution.state !== 'ready' || entry.dispatchPaused) return;
    setBusy(true); setFailure('');
    try { const receipt = await runtime.command<{ result: Turn }>('sessions.sendText', { sessionId: entry.session.id, text }, commandId.current); accepted.current = receipt.result; setText(''); commandId.current = crypto.randomUUID(); }
    catch (caught) { setFailure(String(caught)); }
    finally { setBusy(false); }
  }}><label>独立消息输入<textarea value={text} onChange={event => { setText(event.target.value); commandId.current = crypto.randomUUID(); }} onCompositionStart={() => { composition.current = true; }} onCompositionEnd={() => { composition.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (composition.current || event.nativeEvent.isComposing)) event.preventDefault(); }} /></label><button disabled={busy || Boolean(working) || !entry || entry.execution.state !== 'ready' || entry.dispatchPaused}>独立发送</button></form>{working && <button disabled={busy || turn?.state === 'cancelling'} onClick={async () => { if (!turn) return; setBusy(true); try { await runtime.command('sessions.cancelTurn', { turnId: turn.id }, crypto.randomUUID()); } catch (caught) { setFailure(String(caught)); } finally { setBusy(false); } }}>独立取消轮次</button>}{(error || failure) && <p role="alert">{error || failure}</p>}</section>;
}
function Messages({ runtime }: ViewProps) {
  const { timeline, error } = usePublicSession(runtime);
  return <section aria-label="独立消息视图"><h3>独立消息视图</h3>{timeline?.messages.map(message => <p key={message.id} style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>)}{timeline?.turns.map(turn => <p key={turn.id}>{turn.state}</p>)}{error && <p role="alert">{error}</p>}</section>;
}
function Tools({ runtime }: ViewProps) {
  const { timeline, error } = usePublicSession(runtime);
  return <section aria-label="独立工具视图"><h3>独立工具视图</h3>{timeline?.tools.map(tool => <p key={`${tool.turnId}:${tool.toolCallId}`}>{tool.title} · {tool.status}</p>)}{error && <p role="alert">{error}</p>}</section>;
}
export function activate(context: ClientPluginContext) { context.registerView('composer', Composer); context.registerView('messages', Messages); context.registerView('tools', Tools); }
