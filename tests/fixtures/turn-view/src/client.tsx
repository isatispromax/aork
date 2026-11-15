import { useEffect, useRef, useState } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { SESSION_INPUT_OPTIONS,SESSION_INPUT_EXTENSIONS,attachmentReferenceSchema } from '@aork/contracts/input';
import type { AttachmentReference,SessionInputContext } from '@aork/contracts/input';
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
        const parsed = value as SessionsOverview;
        const result = id ? await runtime.resource('sessions.timeline', { sessionId: id }) : undefined;
        if (active) { setOverview(parsed); setTimeline(result ? JSON.parse(new TextDecoder().decode(result.bytes)) as SessionTimeline : undefined); setError(''); }
      } catch (failure) { if (active) setError(String(failure)); }
    }, error(failure) { if (active) setError(failure.message); } }, { intervalMs: 500 });
    return () => { active = false; void stop(); };
  }, [runtime, id]);
  return { entry: overview?.sessions.find(item => item.session.id === id), timeline, error };
}
interface Draft {text:string;attachments:AttachmentReference[];commandId:string;uncertain?:{text:string;attachments:AttachmentReference[];commandId:string}}
function Composer({runtime}:ViewProps){const id=useSelected();return id?<ScopedComposer key={id} runtime={runtime} sessionId={id}/>:null;}
function ScopedComposer({ runtime,sessionId }: ViewProps&{sessionId:string}) {
  const { entry, error } = usePublicSession(runtime);const key=`independent-composer:${runtime.bootstrap.access.identity}:${sessionId}`;
  const [draft,setDraft]=useState<Draft>(()=>{try{const value=JSON.parse(sessionStorage.getItem(key)??'null');if(value&&typeof value.text==='string'&&typeof value.commandId==='string'&&attachmentReferenceSchema.array().max(4).safeParse(value.attachments).success)return value;}catch{}return{text:'',attachments:[],commandId:crypto.randomUUID()};});
  const latest=useRef(draft);const save=(value:Draft)=>{latest.current=value;setDraft(value);try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}};
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState(''); const composition = useRef(false); const accepted = useRef<Turn | undefined>(undefined);
  const turn = accepted.current && (!entry?.currentTurn || (entry.currentTurn.id !== accepted.current.id && entry.currentTurn.createdAt <= accepted.current.createdAt)) ? accepted.current : entry?.currentTurn;
  useEffect(() => { if (entry?.currentTurn?.id === accepted.current?.id) accepted.current = undefined; }, [entry]);
  const working = Boolean(turn && ['accepted', 'dispatching', 'running', 'cancelling'].includes(turn.state));
  async function send(retry=false){const current=latest.current;const attempt=retry?current.uncertain:{text:current.text,attachments:current.attachments,commandId:current.commandId};if(!attempt||busy||!entry||!attempt.text.trim()||!retry&&(working||entry.execution.state!=='ready'||entry.dispatchPaused||current.uncertain))return;setBusy(true);setFailure('');save({...current,uncertain:attempt});
    try{const receipt=await runtime.command<{result:Turn}>('sessions.sendText',{sessionId,text:attempt.text,...(attempt.attachments.length?{attachments:attempt.attachments}:{})},attempt.commandId);accepted.current=receipt.result;const next=latest.current;save({text:next.text===attempt.text?'':next.text,attachments:JSON.stringify(next.attachments)===JSON.stringify(attempt.attachments)?[]:next.attachments,commandId:crypto.randomUUID()});}
    catch(caught){setFailure(String(caught));}finally{setBusy(false);}}
  const context:SessionInputContext={version:1,sessionId,attachments:draft.attachments,disabled:busy||working||Boolean(draft.uncertain),onAttachmentsChange(attachments){save({...latest.current,attachments,commandId:crypto.randomUUID()});}};
  return <section aria-label="独立输入视图" style={{maxWidth:'100%',minWidth:0}}><p role="status" aria-label="独立当前轮次">{turn ? `${turn.id} · ${turn.state}` : '暂无轮次'}</p>
  {runtime.renderView(SESSION_INPUT_OPTIONS,context)}{runtime.renderExtensions(SESSION_INPUT_EXTENSIONS,context)}
  <form onSubmit={event=>{event.preventDefault();void send();}}><label>独立消息输入<textarea style={{maxWidth:'100%'}} value={draft.text} onChange={event => save({...latest.current,text:event.target.value,commandId:crypto.randomUUID()})} onCompositionStart={() => { composition.current = true; }} onCompositionEnd={() => { composition.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (composition.current || event.nativeEvent.isComposing)) event.preventDefault(); }} /></label><button disabled={busy || working || Boolean(draft.uncertain) || !entry || entry.execution.state !== 'ready' || entry.dispatchPaused}>独立发送</button></form>
  {draft.uncertain&&<button disabled={busy} onClick={()=>void send(true)}>独立重试原输入</button>}
  {working && <button disabled={busy || turn?.state === 'cancelling'} onClick={async () => { if (!turn) return; setBusy(true); try { await runtime.command('sessions.cancelTurn', { turnId: turn.id }, crypto.randomUUID()); } catch (caught) { setFailure(String(caught)); } finally { setBusy(false); } }}>独立取消轮次</button>}{(error || failure) && <p role="alert">{error || failure}</p>}</section>;
}
function AttachmentExtension({context}:ViewProps){if(!context||typeof context!=='object'||!('version'in context)||context.version!==1||!('onAttachmentsChange'in context)||typeof context.onAttachmentsChange!=='function')return <p role="alert">Missing public input context</p>;const input=context as SessionInputContext;return <section aria-label="独立附件扩展"><p>公开附件草稿：{input.attachments.length}</p><button disabled={input.disabled} onClick={()=>input.onAttachmentsChange([...input.attachments,{path:'browser-notes.txt',kind:'text'}])}>扩展添加笔记</button></section>;}
function Messages({ runtime }: ViewProps) {
  const { timeline, error } = usePublicSession(runtime);
  return <section aria-label="独立消息视图"><h3>独立消息视图</h3>{timeline?.messages.map(message => <p key={message.id} style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>)}{timeline?.turns.map(turn => <p key={turn.id}>{turn.state}</p>)}{error && <p role="alert">{error}</p>}</section>;
}
function Tools({ runtime }: ViewProps) {
  const { timeline, error } = usePublicSession(runtime);
  return <section aria-label="独立工具视图"><h3>独立工具视图</h3>{timeline?.tools.map(tool => <p key={`${tool.turnId}:${tool.toolCallId}`}>{tool.title} · {tool.status}</p>)}{error && <p role="alert">{error}</p>}</section>;
}
export function activate(context: ClientPluginContext) { context.registerView('composer', Composer); context.registerView('messages', Messages); context.registerView('tools', Tools); context.registerExtension('attachment',AttachmentExtension); }
