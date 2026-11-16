import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { sessionTimelineSchema, type SessionTimeline } from '@aork/contracts/session';

/** One persistent public slot. It deliberately has no activity/session key. */
function Layout({ runtime }: ViewProps) {
    const [hash, setHash] = useState(location.hash);
    useEffect(() => { const change = () => setHash(location.hash); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
    const sessionIds = (new URLSearchParams(hash.slice(1)).get('slotSessions') ?? '').split(',').filter(Boolean);
    return <main style={{ maxWidth: 780, margin: '24px auto', fontFamily: 'var(--aork-font)' }}><h1>独立单槽读者</h1>{runtime.renderView('aork.sessions.messages@1', { sessionIds })}</main>;
}
function Messages({ runtime, context }: ViewProps) {
    const sessionIds = (context as { sessionIds: string[] }).sessionIds;
    const key = sessionIds.join(',');
    const [snapshots, setSnapshots] = useState<Record<string, SessionTimeline>>({});
    const [selected, setSelected] = useState('');
    const [covered, setCovered] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        const stops = sessionIds.map(sessionId => runtime.observeSnapshot('sessions.timeline', { sessionId }, {
            next(value) { if (active) { setSnapshots(current => ({ ...current, [sessionId]: sessionTimelineSchema.parse(value) })); setError(''); } },
            error(failure) { if (active) setError(failure.message); },
        }, { owners: ['sessions'] }));
        return () => { active = false; for (const stop of stops) void stop(); };
    }, [runtime, key]);
    const replies = sessionIds.flatMap(sessionId => (snapshots[sessionId]?.completedReplies ?? []).map(reply => ({
        sessionId, activityId: reply.activityId,
        text: snapshots[sessionId]!.messages.filter(message => message.turnId === reply.turnId && message.role === 'agent').map(message => message.text).join(''),
    })));
    const reply = replies.find(value => `${value.sessionId}:${value.activityId}` === selected);
    return <section aria-label="独立单槽消息">
        {error && <p role="alert">{error}</p>}
        <nav aria-label="选择完成回复">{replies.map((value, index) => <button key={value.activityId} onClick={() => setSelected(`${value.sessionId}:${value.activityId}`)}>阅读回复 {index + 1}</button>)}</nav>
        <label><input type="checkbox" aria-label="覆盖读槽" checked={covered} onChange={event => setCovered(event.target.checked)} />覆盖读槽</label>
        <div style={{ position: 'relative', marginTop: 20 }} data-aork-read-visibility={covered ? 'covered' : undefined}>
            {covered && <div aria-label="读槽遮挡层" style={{ position: 'absolute', inset: 0, zIndex: 1, background: '#fff', pointerEvents: 'none' }} />}
            {reply && runtime.renderView('aork.workbench.read-tracker@1', {
                sessionId: reply.sessionId, activityId: reply.activityId,
                content: <article aria-label="单槽当前回复"><p>{reply.text}</p><input aria-label="读槽批注" defaultValue="" /></article>,
            })}
        </div>
    </section>;
}
export function activate(context: ClientPluginContext) { context.registerView('layout', Layout); context.registerView('messages', Messages); }
