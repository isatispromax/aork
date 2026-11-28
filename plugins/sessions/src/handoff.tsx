import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import { overviewSchema as agentsOverviewSchema } from '@aork/contracts/agent';
import type { AgentsOverview } from '@aork/contracts/agent';
import { artifactListSchema, artifactDetailSchema } from '@aork/contracts/artifact';
import type { ArtifactList, ArtifactDetail } from '@aork/contracts/artifact';
import { sessionsProjectionSchema, sessionReferencesSchema, handoffPageSchema, type SessionsProjection, type Session, type SessionHandoff, type SessionReferences } from '@aork/contracts/session';
import type { FileListing, FileSearch } from '@aork/contracts/workspace';
import styles from './sessions.module.css';

function HandoffModal({ title, busy, close, children }: { title: string; busy: boolean; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); }; }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) close(); }}><h2>{title}</h2>{children}</dialog>;
}
const kindLabels = { text: '文字上下文', image: '图片', audio: '音频' } as const;
type CarryKind = keyof typeof kindLabels;

/** Explicit context handoff: only user-selected content travels; no native history,
 * native session identity or lossless migration is claimed. */
export function Handoff(props: ViewProps) {
  const context = props.context as { sourceSessionId?: string; close?: () => void };
  if (!context || typeof context !== 'object' || typeof context.sourceSessionId !== 'string' || typeof context.close !== 'function') return <p role="alert">交接上下文需要来源会话。</p>;
  return <HandoffDialog runtime={props.runtime} sourceSessionId={context.sourceSessionId} close={context.close} />;
}
function HandoffDialog({ runtime, sourceSessionId, close }: { runtime: UiRuntime; sourceSessionId: string; close(): void }) {
  const [projection, setProjection] = useState<SessionsProjection>();
  const [workspaces, setWorkspaces] = useState<WorkspaceOverview>();
  const [agents, setAgents] = useState<AgentsOverview>();
  const [artifacts, setArtifacts] = useState<ArtifactList>();
  const [artifactError, setArtifactError] = useState('');
  const [detail, setDetail] = useState<ArtifactDetail>();
  const [files, setFiles] = useState<FileListing['entries']>([]);
  const [query, setQuery] = useState('');
  const [pickedFiles, setPickedFiles] = useState<Array<{ path: string; kind: CarryKind }>>([]);
  const [pickedArtifact, setPickedArtifact] = useState<{ artifactId: string; versionId: string; ordinal: number; kind: CarryKind }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const source = projection?.sessions.find(entry => entry.session.id === sourceSessionId);
  const [form, setForm] = useState({ name: '', workspaceId: '', profileId: '', summary: '', commandId: crypto.randomUUID() });
  useEffect(() => { const stop = runtime.observeSnapshot<SessionsProjection>('sessions.overview', {}, { next(value) { setProjection(sessionsProjectionSchema.parse(value)); }, error(failure) { setError(failure.message); } }, { owners: ['sessions'] }); return () => { void stop(); }; }, [runtime]);
  useEffect(() => { const stops = [runtime.subscribe<WorkspaceOverview>('workspace.overview', { next(value) { setWorkspaces(workspaceOverviewSchema.parse(value)); }, error(failure) { setError(failure.message); } }, { intervalMs: 1000 }), runtime.subscribe<AgentsOverview>('agents.overview', { next(value) { setAgents(agentsOverviewSchema.parse(value)); }, error(failure) { setError(failure.message); } })]; return () => { for (const stop of stops) void stop(); }; }, [runtime]);
  useEffect(() => { if (source && !form.name && !form.workspaceId) setForm(current => ({ ...current, name: `交接自 ${source.session.name}`.slice(0, 120), workspaceId: source.session.workspaceId })); }, [source?.session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!source) return; const stop = runtime.observeSnapshot<ArtifactList>('artifacts.list', { workspaceId: source.session.workspaceId }, { next(value) { setArtifacts(artifactListSchema.parse(value)); setArtifactError(''); }, error(failure) { setArtifactError(failure.message); } }, { owners: ['artifacts'] }); return () => { void stop(); }; }, [runtime, source?.session.workspaceId]);
  useEffect(() => { if (!pickedArtifact) { setDetail(undefined); return; } const stop = runtime.observeSnapshot<ArtifactDetail>('artifacts.detail', { artifactId: pickedArtifact.artifactId, versionId: pickedArtifact.versionId }, { next(value) { setDetail(artifactDetailSchema.parse(value)); }, error(failure) { setArtifactError(failure.message); } }, { owners: ['artifacts'] }); return () => { void stop(); }; }, [runtime, pickedArtifact?.artifactId, pickedArtifact?.versionId]);
  async function browse() { if (!source || busy) return; setBusy(true); setError(''); try { const response = await runtime.resource(query ? 'workspace.search' : 'workspace.files', query ? { workspaceId: source.session.workspaceId, query } : { workspaceId: source.session.workspaceId, path: '' }); const result = JSON.parse(new TextDecoder().decode(response.bytes)) as FileListing | FileSearch; setFiles(result.entries.filter(item => item.kind === 'file')); if (result.truncated) setError('文件列表已截断，请使用更精确的文件名搜索。'); } catch (failure) { setError(failure instanceof Error ? failure.message : '读取工作区文件失败'); } finally { setBusy(false); } }
  const update = (value: Partial<typeof form>) => setForm(current => ({ ...current, ...value, commandId: crypto.randomUUID() }));
  const carryCount = pickedFiles.length + (pickedArtifact ? 1 : 0);
  const workspace = workspaces?.workspaces.find(item => item.id === form.workspaceId);
  const profile = agents?.profiles.find(item => item.profile.id === form.profileId);
  const provider = agents?.providers.find(item => item.id === profile?.profile.providerId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !source) return; setBusy(true); setError('');
    const payload = { sourceSessionId, name: form.name, workspaceId: form.workspaceId, profileId: form.profileId, carry: { ...(form.summary.trim() ? { summary: form.summary } : {}), files: pickedFiles.map(file => ({ workspaceId: source.session.workspaceId, path: file.path, kind: file.kind })), ...(pickedArtifact ? { artifactVersions: [{ versionId: pickedArtifact.versionId, kind: pickedArtifact.kind }] } : {}) } };
    try {
      const receipt = await runtime.command<CommandReceipt<Session>>('sessions.createLinked', payload, form.commandId, { version: 1 });
      location.hash = withWorkbenchSelection(location.hash, { workspaceId: receipt.result.workspaceId, sessionId: receipt.result.id, creatingSession: false });
      close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '创建失败，可使用同一命令重试'); } finally { setBusy(false); }
  }
  if (!source) return <p role="status">正在读取来源会话…</p>;
  return <form onSubmit={submit} aria-label="交接新会话">
    <p>创建一个关联新会话并只携带下面明确选择的内容。这不是原生会话恢复：不迁移原生历史，也不跨 Provider 复用原生会话 ID；来源会话及其记录保持不变。</p>
    <fieldset disabled={busy}>
      <label>新会话名称<input autoFocus required maxLength={120} value={form.name} onChange={event => update({ name: event.target.value })} /></label>
      <label>目标工作区<select required value={form.workspaceId} onChange={event => update({ workspaceId: event.target.value })}><option value="">选择工作区</option>{workspaces?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {workspace && <p className={styles.path}>{workspace.directory}</p>}
      <label>目标 Agent Profile（可换 Agent Provider）<select required value={form.profileId} onChange={event => update({ profileId: event.target.value })}><option value="">选择 Agent Profile</option>{agents?.profiles.map(item => <option key={item.profile.id} value={item.profile.id}>{item.profile.name} · {agents.providers.find(candidate => candidate.id === item.profile.providerId)?.label ?? item.profile.providerId}</option>)}</select></label>
      {profile && <p className={styles.hint}>{provider?.label ?? profile.profile.providerId} · 配置版本 {profile.profile.revision}{profile.availability !== 'available' ? ' · 当前配置不可用，创建后仍需先修复配置才能启动' : ''}</p>}
      <label>携带摘要（将成为新会话的第一条输入文本）<textarea value={form.summary} maxLength={16000} rows={3} placeholder="概述已完成的工作与接下来要做什么…" onChange={event => update({ summary: event.target.value })} /></label>
      <fieldset>
        <legend>携带工作区文件（来自来源工作区；跨工作区会复制到目标工作区的受控路径）</legend>
        <div className={styles.queue}>
          <label>文件名搜索<input value={query} maxLength={120} onChange={event => setQuery(event.target.value)} /></label>
          <button type="button" disabled={busy} onClick={() => void browse()}>查找来源工作区文件</button>
          <label>文件<select aria-label="携带文件选择" value="" disabled={busy || !files.length} onChange={event => { const item = files.find(file => file.path === event.target.value); if (item && carryCount < 4 && !pickedFiles.some(picked => picked.path === item.path)) setPickedFiles(current => [...current, { path: item.path, kind: 'text' }]); }}><option value="">{files.length ? '选择文件' : '先查找文件'}</option>{files.map(item => <option key={item.path} value={item.path}>{item.path} · {item.size} B</option>)}</select></label>
          {pickedFiles.map((picked, index) => <label key={picked.path}>文件 {picked.path}<select value={picked.kind} onChange={event => setPickedFiles(current => current.map((item, position) => position === index ? { ...item, kind: event.target.value as CarryKind } : item))}>{(Object.keys(kindLabels) as CarryKind[]).map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select><button type="button" onClick={() => setPickedFiles(current => current.filter((_, position) => position !== index))}>移除</button></label>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>携带产物版本（受理时读取不可变内容）</legend>
        {artifactError && <p role="alert">{artifactError}</p>}
        <label>产物<select aria-label="携带产物选择" value={pickedArtifact?.artifactId ?? ''} onChange={event => { const item = artifacts?.artifacts.find(candidate => candidate.id === event.target.value); setPickedArtifact(item ? { artifactId: item.id, versionId: item.latestVersionId, ordinal: item.versionCount, kind: 'text' } : undefined); }}><option value="">不携带产物</option>{artifacts?.artifacts.map(item => <option key={item.id} value={item.id}>{item.title}（{item.versionCount} 个版本）</option>)}</select></label>
        {pickedArtifact && detail && <label>版本<select aria-label="携带产物版本选择" value={pickedArtifact.versionId} onChange={event => { const version = detail.versions.find(candidate => candidate.id === event.target.value); if (version) setPickedArtifact(current => current ? { ...current, versionId: version.id, ordinal: version.ordinal } : current); }}>{detail.versions.map(version => <option key={version.id} value={version.id}>版本 {version.ordinal}</option>)}</select></label>}
        {pickedArtifact && <label>产物内容类型<select aria-label="携带产物内容类型" value={pickedArtifact.kind} onChange={event => setPickedArtifact(current => current ? { ...current, kind: event.target.value as CarryKind } : current)}>{(Object.keys(kindLabels) as CarryKind[]).map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>}
        {!artifacts && !artifactError && <p className={styles.hint}>正在读取工作区产物…</p>}
      </fieldset>
      <p className={styles.hint}>已选择 {carryCount}/4 个附件；超过内联限制的大内容会被拒绝，可先在产物面板放入工作区后引用。</p>
    </fieldset>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className={styles.primary} disabled={busy || !workspace || !profile || carryCount > 4}>{busy ? '正在创建…' : '创建关联新会话'}</button></footer>
  </form>;
}

/** Two-way visible linkage and the pending/sent handoff context of a Session. */
export function Linkage({ runtime, session, ready, workspaceOpen, linkedTo }: { runtime: UiRuntime; session: Session; ready: boolean; workspaceOpen: boolean; linkedTo: ReadonlyArray<{ sessionId: string }> }) {
  const [names, setNames] = useState<SessionReferences>({ sessions: [] });
  const [handoff, setHandoff] = useState<SessionHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commandId = useRef(crypto.randomUUID());
  const linked = [...[session.linkedFrom?.sessionId].filter(Boolean) as string[], ...linkedTo.map(item => item.sessionId)];
  useEffect(() => { const stop = runtime.observeSnapshot('sessions.handoff', { sessionId: session.id }, { next(value) { setHandoff(handoffPageSchema.parse(value).handoff); setError(''); }, error(failure) { setError(failure.message); } }, { owners: ['sessions'], eventTypes: ['sessions.handoffChanged'] }); return () => { void stop(); }; }, [runtime, session.id]);
  const referenceKey = linked.join(',');
  useEffect(() => { if (!referenceKey) return; const stop = runtime.observeSnapshot('sessions.references', { ids: referenceKey }, { next(value) { setNames(sessionReferencesSchema.parse(value)); }, error(failure) { setError(failure.message); } }, { owners: ['sessions'] }); return () => { void stop(); }; }, [runtime, referenceKey]);
  async function send() {
    if (busy) return; setBusy(true); setError('');
    try { await runtime.command('sessions.sendHandoff', { sessionId: session.id }, commandId.current, { version: 1 }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '发送交接上下文结果未确认，可重试'); }
    finally { setBusy(false); }
  }
  const source = names.sessions.find(item => item.id === session.linkedFrom?.sessionId);
  return <section className={styles.reconciliation} aria-label="会话关联">
    {linkedTo.length > 0 && <p>此会话已交接至 {linkedTo.map(item => <button key={item.sessionId} onClick={() => { const target = names.sessions.find(candidate => candidate.id === item.sessionId); if (target) location.hash = withWorkbenchSelection(location.hash, { workspaceId: target.workspaceId, sessionId: target.id }); }}>{names.sessions.find(candidate=>candidate.id===item.sessionId)?.name??item.sessionId.slice(0,8)}</button>)}</p>}
    {session.linkedFrom && <p>关联自会话 <button onClick={() => { const target = names.sessions.find(item => item.id === session.linkedFrom!.sessionId); if (target) location.hash = withWorkbenchSelection(location.hash, { workspaceId: target.workspaceId, sessionId: target.id }); }}>{source?.name ?? session.linkedFrom.sessionId.slice(0, 8)}</button>。上下文交接不是原生恢复，不迁移原生历史。</p>}
    {handoff && handoff.state === 'pending' && <div className={styles.queue}>
      <strong>待发送的交接上下文</strong>
      {handoff.carry.summary && <p>{handoff.carry.summary}</p>}
      {handoff.carry.files.map(file => <p key={file.path}>文件 {file.path} · {kindLabels[file.kind]}</p>)}
      {handoff.carry.artifactVersions.map(version => <p key={version.versionId}>产物版本 {version.ordinal} · {version.filename} · {version.size} B · {kindLabels[version.kind]}</p>)}
      {!handoff.carry.files.length && !handoff.carry.artifactVersions.length && !handoff.carry.summary && <p>仅携带摘要文本。</p>}
      <p className={styles.hint}>{ready ? '发送后作为该会话第一条输入，受当前运行协商能力约束。' : '启动运行并就绪后可发送。'}</p>
      <button type="button" disabled={busy || !ready || !workspaceOpen} onClick={() => void send()}>发送交接上下文</button>
    </div>}
    {handoff && handoff.state === 'sent' && <p className={styles.hint}>交接上下文已作为输入发送（轮次 {handoff.turnId?.slice(0, 8)}）。</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
export function HandoffModalHost({ runtime, sourceSessionId, close, busy }: { runtime: UiRuntime; sourceSessionId: string; close(): void; busy: boolean }) {
  return createPortal(<HandoffModal title="交接新会话" busy={busy} close={close}>{runtime.renderView('aork.sessions.handoff@1', { sourceSessionId, close })}</HandoffModal>, document.body);
}
