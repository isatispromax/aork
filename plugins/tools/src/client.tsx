import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { readWorkbenchSelection } from '@aork/contracts/workspace';
import type { ToolCallRecord, ToolCatalogEntry, ToolRef, RunToolSnapshot } from '@aork/contracts/tools';
import styles from './tools.module.css';
interface SelectionView {
    archived:boolean;
    selection: {
        sessionId: string;
        revision: number;
        tools: ToolRef[];
    };
    runs: {
        snapshot: RunToolSnapshot;
        state: 'planned' | 'live' | 'revoked';
    }[];
}
function Selection({ runtime }: ViewProps) {
    const [sessionId, setSessionId] = useState(() => readWorkbenchSelection(location.hash).sessionId);
    const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
    const [value, setValue] = useState<SelectionView>();
    const [calls, setCalls] = useState<ToolCallRecord[]>([]);
    const [truncated, setTruncated] = useState(false);
    const [draft, setDraft] = useState<ToolRef[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { const change = () => setSessionId(readWorkbenchSelection(location.hash).sessionId); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
    useEffect(() => { let active = true; void runtime.query<{
        tools: ToolCatalogEntry[];
    }>('tools.catalog').then(value => { if (active)
        setCatalog(value.tools); }).catch(failure => { if (active)
        setError(failure.message); }); return () => { active = false; }; }, [runtime]);
    useEffect(() => {
        setValue(undefined);
        setCalls([]);
        setError('');
        if (!sessionId)
            return;
        let active = true;
        let revision = 0;
        const selection = runtime.observeSnapshot<SelectionView>('tools.session', { sessionId }, { next(next) { if (!active)
                return; setValue(next); if (revision !== next.selection.revision) {
                revision = next.selection.revision;
                setDraft(next.selection.tools);
            } setError(''); }, error(failure) { if (active)
                setError(failure.message); } }, { owners: ['tools'] });
        const records = runtime.observeSnapshot<{
            calls: ToolCallRecord[];
            truncated: boolean;
        }>('tools.calls', { sessionId }, { next(next) { if (active) {
                setCalls(next.calls);
                setTruncated(next.truncated);
            } }, error(failure) { if (active)
                setError(failure.message); } }, { owners: ['tools'] });
        return () => { active = false; void selection(); void records(); };
    }, [runtime, sessionId]);
    if (!sessionId)
        return null;
    const latest = value?.runs.at(-1);
    const selected = (tool: ToolCatalogEntry) => draft.some(ref => ref.id === tool.id && ref.definitionVersion === tool.definitionVersion);
    async function save() { if (!value || busy)
        return; setBusy(true); setError(''); try {
        await runtime.command('tools.replaceSessionSelection', { sessionId, expectedRevision: value.selection.revision, tools: draft }, crypto.randomUUID(), { version: 1 });
    }
    catch (failure) {
        setError(failure instanceof Error ? failure.message : '工具选择未保存');
    }
    finally {
        setBusy(false);
    } }
    async function revoke() { if (!latest || busy)
        return; setBusy(true); setError(''); try {
        await runtime.command('tools.revokeRun', { runId: latest.snapshot.run.runId }, crypto.randomUUID(), { version: 1 });
    }
    catch (failure) {
        setError(failure instanceof Error ? failure.message : '撤销结果未确认');
    }
    finally {
        setBusy(false);
    } }
    return <section className={styles.tools} role="group" aria-label="工作台工具">
  <details><summary><span>选择下次运行工具</span> <span>已保存 {value?.selection.tools.length ?? 0} 项工具</span></summary><p>更改用于下次运行。当前运行保留已捕获的版本。</p>
   <fieldset disabled={busy || !value || value.archived}><legend>可用工作台工具</legend>{catalog.map(tool => <label key={tool.id}><input type="checkbox" aria-label={tool.title} checked={selected(tool)} onChange={event => setDraft(event.target.checked ? [...draft, { id: tool.id, definitionVersion: tool.definitionVersion }] : draft.filter(ref => ref.id !== tool.id))}/><span>{tool.title}<small>{tool.id} · {tool.definitionVersion} · {tool.access === 'write' ? '写入' : '读取'}</small></span></label>)}</fieldset>
   <button type="button" disabled={busy || !value || value.archived} onClick={() => void save()}>保存下次运行工具</button>
   {latest && <p>当前运行工具：{latest.snapshot.tools.map(tool => tool.title).join('、') || '无'} · {latest.state === 'revoked' ? '已撤销' : latest.state === 'live' ? '有效' : '待启动'}</p>}
   {latest?.state === 'live' && latest.snapshot.tools.length > 0 && <button type="button" disabled={busy} onClick={() => void revoke()}>撤销本次运行工具</button>}
  </details>
  {error && <p role="alert">{error}</p>}
  {calls.length > 0 && <section aria-label="工作台实际工具调用"><h3>工作台实际工具调用</h3><p>由 Host 记录，与 Agent 工具报告分别显示。</p>{calls.map(call => <details key={call.id}><summary>{call.tool.id} <span>{({ running: '执行中', succeeded: '已成功', failed: '失败', cancelled: '已取消', unknown: '结果未知' })[call.state]}</span></summary><small>{call.tool.definitionVersion} · {call.createdAt}{call.cancellationRequested ? ' · 曾请求取消' : ''}</small>{call.errorCode && <p>{call.errorCode}</p>}{call.result?.content.map((content, index) => <pre key={index}>{content.text}</pre>)}</details>)}{truncated && <p>仅显示有界调用历史；较早的大结果已省略。</p>}</section>}
 </section>;
}
export function activate(context: ClientPluginContext) { context.registerView('selection', Selection); }
