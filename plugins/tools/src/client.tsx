import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { readWorkbenchSelection } from '@aork/contracts/workspace';
import {toolCallSchema} from '@aork/contracts/tools';
import type { ToolCallRecord, ToolCallSummary, ToolCatalogEntry, ToolRef, RunToolSnapshot } from '@aork/contracts/tools';
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
    const [catalogLoaded,setCatalogLoaded]=useState(false);
    const [value, setValue] = useState<SelectionView>();
    const [calls, setCalls] = useState<ToolCallSummary[]>([]);
    const [truncated, setTruncated] = useState(false);
    const [detail,setDetail]=useState<ToolCallRecord>();const [detailBusy,setDetailBusy]=useState<string>();const [detailError,setDetailError]=useState('');
    const [draft, setDraft] = useState<ToolRef[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { const change = () => setSessionId(readWorkbenchSelection(location.hash).sessionId); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
    useEffect(() => { let active = true;setCatalogLoaded(false); void runtime.query<{
        tools: ToolCatalogEntry[];
    }>('tools.catalog').then(value => { if (active)
        {setCatalog(value.tools);setCatalogLoaded(true);} }).catch(failure => { if (active)
        setError(failure.message); }); return () => { active = false; }; }, [runtime]);
    useEffect(() => {
        setValue(undefined);
        setCalls([]);setDetail(undefined);setDetailError('');
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
            calls: ToolCallSummary[];
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
    const unavailable=catalogLoaded?draft.filter(ref=>!catalog.some(tool=>tool.id===ref.id&&tool.definitionVersion===ref.definitionVersion)):[];
    const selected = (tool: ToolCatalogEntry) => draft.some(ref => ref.id === tool.id && ref.definitionVersion === tool.definitionVersion);
    async function loadDetail(id:string){setDetail(undefined);setDetailError('');setDetailBusy(id);try{const response=await runtime.resource('tools.call',{callId:id});setDetail(toolCallSchema.parse(JSON.parse(new TextDecoder().decode(response.bytes))));}catch(failure){setDetailError(failure instanceof Error?failure.message:'读取调用结果失败');}finally{setDetailBusy(undefined);}}
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
   <fieldset disabled={busy || !value || value.archived}><legend>可用工作台工具</legend>{catalog.map(tool => <label key={tool.id}><input type="checkbox" aria-label={tool.title} checked={selected(tool)} onChange={event => setDraft(event.target.checked ? [...draft.filter(ref=>ref.id!==tool.id), { id: tool.id, definitionVersion: tool.definitionVersion }] : draft.filter(ref => ref.id !== tool.id))}/><span>{tool.title}<small>{tool.id} · {tool.definitionVersion} · {tool.access === 'write' ? '写入' : '读取'}</small></span></label>)}</fieldset>
   {unavailable.length>0&&<fieldset disabled={busy||!value||value.archived}><legend>不可用的已选工具</legend>{unavailable.map(ref=><div key={`${ref.id}:${ref.definitionVersion}`}><small>{ref.id} · {ref.definitionVersion} · 当前提供者不可用</small><button type="button" aria-label={`移除不可用工具 ${ref.id} ${ref.definitionVersion}`} onClick={()=>setDraft(draft.filter(item=>item.id!==ref.id))}>移除</button></div>)}</fieldset>}
   <button type="button" disabled={busy||!value||value.archived||draft.length===0} onClick={()=>setDraft([])}>清空工具选择</button>
   <button type="button" disabled={busy || !value || value.archived} onClick={() => void save()}>保存下次运行工具</button>
   {latest && <p>当前运行工具：{latest.snapshot.tools.map(tool => tool.title).join('、') || '无'} · {latest.state === 'revoked' ? '已撤销' : latest.state === 'live' ? '有效' : '待启动'}</p>}
   {latest?.state === 'live' && latest.snapshot.tools.length > 0 && <button type="button" disabled={busy} onClick={() => void revoke()}>撤销本次运行工具</button>}
  </details>
  {error && <p role="alert">{error}</p>}
  {calls.length > 0 && <section aria-label="工作台实际工具调用"><h3>工作台实际工具调用</h3><p>由 Host 记录，与 Agent 工具报告分别显示。</p>{calls.map(call => <details key={call.id}><summary>{call.tool.id} <span>{({ running: '执行中', succeeded: '已成功', failed: '失败', cancelled: '已取消', unknown: '结果未知' })[call.state]}</span></summary><small>{call.tool.definitionVersion} · {call.createdAt}{call.cancellationRequested ? ' · 曾请求取消' : ''}</small>{call.errorCode && <p>{call.errorCode}</p>}{call.resultOmitted&&<><p>结果正文未包含在列表中。</p><button type="button" disabled={Boolean(detailBusy)} onClick={()=>void loadDetail(call.id)}>{detailBusy===call.id?'正在读取…':'查看完整工具结果'}</button></>}{detail?.id===call.id&&<>{detail.result?.content.map((content,index)=><pre key={index}>{content.text}</pre>)}{detail.result?.structuredContent&&<pre>{JSON.stringify(detail.result.structuredContent)}</pre>}</>}</details>)}{detailError&&<p role="alert">{detailError}</p>}{truncated && <p>仅显示最近 100 条历史及仍在执行的调用；完整结果可按调用标识读取。</p>}</section>}
 </section>;
}
export function activate(context: ClientPluginContext) { context.registerView('selection', Selection); }
