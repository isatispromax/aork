import { useEffect, useRef, useState } from 'react';
import { SESSION_RECONCILIATION, reconciliationSnapshotSchema, type Reconciliation } from '@aork/contracts/reconciliation';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
interface SavedSession { id: string; name: string; workspaceId: string; profileId: string; workspace: { directory: string } }
const selected = () => new URLSearchParams(location.hash.slice(1));
function select(update: Record<string, string>) { const values = selected(); for (const [key, value] of Object.entries(update)) values.set(key, value); values.delete('createSession'); location.hash = values.toString(); }
function useQuery<T>(runtime: UiRuntime, name: string) {
  const [data, setData] = useState<T>(); const [error, setError] = useState('');
  useEffect(() => { const stop = runtime.subscribe<T>(name, { next: setData, error: failure => setError(failure.message) }, { intervalMs: 500 }); return () => { void stop(); }; }, [runtime, name]);
  return { data, error };
}
function useHash() { const [hash, setHash] = useState(location.hash); useEffect(() => { const update = () => setHash(location.hash); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []); return new URLSearchParams(hash.slice(1)); }
function Navigation({ runtime }: ViewProps) {
  const hash = useHash(); const { data } = useQuery<{ sessions: Array<{ session: SavedSession }> }>(runtime, 'sessions.overview');
  return <nav aria-label="独立会话索引"><button onClick={() => { const values = selected(); values.set('createSession', '1'); location.hash = values.toString(); }}>独立新建会话</button>{data?.sessions.filter(({ session }) => session.workspaceId === hash.get('workspace')).map(({ session }) => <button key={session.id} onClick={() => select({ workspace: session.workspaceId, session: session.id })}>{session.name}</button>)}</nav>;
}
function Create({ runtime }: ViewProps) {
  const hash = useHash(); const dialog = useRef<HTMLDialogElement>(null); const { data } = useQuery<{ profiles: Array<{ profile: { id: string; name: string } }> }>(runtime, 'agents.overview');
  const [name, setName] = useState(''); const [profileId, setProfileId] = useState(''); const [error, setError] = useState(''); const commandId = useRef(crypto.randomUUID());
  useEffect(() => { if (hash.get('createSession') === '1') dialog.current?.showModal(); else dialog.current?.close(); }, [hash.get('createSession')]);
  return <dialog ref={dialog} aria-label="独立创建会话"><form onSubmit={async event => { event.preventDefault(); try { const result = await runtime.command<{ result: SavedSession }>('sessions.create', { name, workspaceId: hash.get('workspace'), profileId }, commandId.current); select({ workspace: result.result.workspaceId, session: result.result.id }); } catch (failure) { setError(String(failure)); } }}><label>独立会话名称<input required value={name} onChange={event => { commandId.current = crypto.randomUUID(); setName(event.target.value); }} /></label><label>独立 Profile<select required value={profileId} onChange={event => { commandId.current = crypto.randomUUID(); setProfileId(event.target.value); }}><option value="">选择配置</option>{data?.profiles.map(({ profile }) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><button>独立保存会话</button>{error && <p role="alert">{error}</p>}</form></dialog>;
}
function Check({runtime,runId}:{runtime:UiRuntime;runId:string}) {
  const [value,setValue]=useState<Reconciliation|null>();const [error,setError]=useState('');const command=useRef<string|undefined>(undefined);
  useEffect(()=>{const stop=runtime.observeSnapshot(SESSION_RECONCILIATION,{runId},{next(result){setValue(reconciliationSnapshotSchema.parse(result).reconciliation);},error(failure){setError(failure.message);}},{owners:['sessions']});return()=>{void stop();};},[runtime,runId]);
  return <section aria-label="独立中断核对"><p>独立核对状态 {value?.status??'unavailable'}</p>{value?.status==='blocked'&&<button onClick={async()=>{command.current??=crypto.randomUUID();try{await runtime.command('sessions.recheckRun',{runId},command.current,{version:1});command.current=undefined;}catch(failure){setError(String(failure));}}}>独立再次核对</button>}{error&&<p role="alert">{error}</p>}</section>;
}
function Detail({ runtime }: ViewProps) {
  const hash = useHash(); const { data, error } = useQuery<{ sessions: Array<{ session: SavedSession;execution:{state:string;runId?:string} }> }>(runtime, 'sessions.overview'); const entry = data?.sessions.find(({ session }) => session.id === hash.get('session'));const session=entry?.session;
  return <section aria-label="独立会话详情"><h2>独立历史视图</h2>{session && <><p>{session.name}</p><p>{session.id}</p><p>{session.workspace.directory}</p></>}{entry?.execution.runId&&<Check key={entry.execution.runId} runtime={runtime} runId={entry.execution.runId}/>}<div>{runtime.renderView('aork.sessions.messages@1')}</div>{error && <p role="alert">{error}</p>}</section>;
}
export function activate(context: ClientPluginContext) { context.registerView('navigation', Navigation); context.registerView('create', Create); context.registerView('detail', Detail); }
