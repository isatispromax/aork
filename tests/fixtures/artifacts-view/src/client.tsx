import { useEffect, useState } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { artifactDetailSchema, artifactListSchema, artifactPreviewSchema, type ArtifactDetail, type ArtifactList, type ArtifactViewContext } from '@aork/contracts/artifact';

/** An independently authored replacement UI: only public commands, snapshots and resources. */
function contextOf(value: unknown) { return value as ArtifactViewContext; }

function Registration({ runtime, context: value }: ViewProps) {
  const context = contextOf(value); const [error, setError] = useState(''); const [receipt, setReceipt] = useState('');
  return <section aria-label="独立登记"><h3>独立登记</h3><button onClick={() => void (async () => {
    try {
      const confirmation = await runtime.command<{ result: { artifactId: string; versionId: string; ordinal: number } }>('artifacts.register', { projectId: context.projectId, ...(context.artifactId ? { artifactId: context.artifactId } : {}), title: '独立登记结果', ...(context.workspaceId && context.relativePath ? { source: { kind: 'captured-file', workspaceId: context.workspaceId, relativePath: context.relativePath } } : { source: { kind: 'external-reference', url: 'https://example.org/independent' } }) }, crypto.randomUUID(), { version: 1 });
      setReceipt(`${confirmation.result.artifactId}:${confirmation.result.versionId}:${confirmation.result.ordinal}`); context.registered?.(confirmation.result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  })()}>独立登记版本</button>{receipt && <p>独立回执 {receipt}</p>}{error && <p role="alert">{error}</p>}</section>;
}

function List({ runtime, context: value }: ViewProps) {
  const context = contextOf(value); const [list, setList] = useState<ArtifactList>(); const [error, setError] = useState('');
  useEffect(() => { setList(undefined); return runtime.observeSnapshot<ArtifactList>('artifacts.list', { projectId: context.projectId }, { next(next) { setList(artifactListSchema.parse(next)); }, error(failure) { setError(failure.message); } }, { owners: ['artifacts'] }); }, [runtime, context.projectId]);
  return <section aria-label="独立列表"><h3>独立列表</h3>{error && <p role="alert">{error}</p>}{list?.artifacts.map(artifact => <button key={artifact.id} aria-current={artifact.id === context.artifactId ? 'true' : undefined} onClick={() => context.selectArtifact?.(artifact.id)}>独立 {artifact.title}（{artifact.versionCount} 个版本）</button>)}{list && !list.artifacts.length && <p>独立列表为空</p>}</section>;
}

function Versions({ runtime, context: value }: ViewProps) {
  const context = contextOf(value); const [detail, setDetail] = useState<ArtifactDetail>(); const [error, setError] = useState('');
  useEffect(() => { setDetail(undefined); if (!context.artifactId) return; return runtime.observeSnapshot<ArtifactDetail>('artifacts.detail', { artifactId: context.artifactId, ...(context.versionId ? { versionId: context.versionId } : {}) }, { next(next) { setDetail(artifactDetailSchema.parse(next)); }, error(failure) { setError(failure.message); } }, { owners: ['artifacts'] }); }, [runtime, context.artifactId, context.versionId]);
  return <section aria-label="独立版本"><h3>独立版本</h3>{error && <p role="alert">{error}</p>}{detail?.versions.map(version => <button key={version.id} aria-current={version.id === detail.selected.id ? 'true' : undefined} onClick={() => context.selectVersion?.(version.id)}>独立版本 {version.ordinal}</button>)}</section>;
}

function Preview({ runtime, context: value }: ViewProps) {
  const context = contextOf(value); const [detail, setDetail] = useState<ArtifactDetail>(); const [text, setText] = useState(''); const [error, setError] = useState('');
  useEffect(() => { setDetail(undefined); if (!context.artifactId) return; return runtime.observeSnapshot<ArtifactDetail>('artifacts.detail', { artifactId: context.artifactId, ...(context.versionId ? { versionId: context.versionId } : {}) }, { next(next) { setDetail(artifactDetailSchema.parse(next)); }, error(failure) { setError(failure.message); } }, { owners: ['artifacts'] }); }, [runtime, context.artifactId, context.versionId]);
  useEffect(() => { setText(''); if (!context.versionId) return; void runtime.resource('artifacts.preview', { versionId: context.versionId }).then(result => { const preview = artifactPreviewSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes))); setText(preview.status === 'text' ? preview.text : `独立预览状态 ${preview.status}`); }, () => setText('独立预览失败')); }, [runtime, context.versionId]);
  if (!detail?.selected) return <section aria-label="独立预览"><h3>独立预览</h3>{error && <p role="alert">{error}</p>}</section>;
  const version = detail.selected; const content = version.content;
  async function download(runtime: UiRuntime, versionId: string, filename: string) { const result = await runtime.resource('artifacts.file', { versionId }); const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: 'application/octet-stream' })); const link = document.createElement('a'); link.href = url; link.download = filename.replace(/[\x00-\x1f\x7f/\\]/g, '_'); link.rel = 'noopener noreferrer'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section aria-label="独立预览"><h3>独立预览 · 版本 {version.ordinal}</h3>{error && <p role="alert">{error}</p>}<dl><dt>独立版本 ID</dt><dd>{version.id}</dd><dt>登记方式</dt><dd>{version.provenance.kind}{version.provenance.association ? ` · ${version.provenance.association.sessionId}/${version.provenance.association.turnId}` : ''}</dd>{content.kind === 'captured-file' ? <><dt>文件</dt><dd>{content.filename} · {content.size} B · {content.sha256}</dd></> : <><dt>外部引用</dt><dd>{content.url}</dd></>}</dl><pre>{text}</pre>{content.kind === 'captured-file' && <button onClick={() => void download(runtime, version.id, content.filename)}>独立下载此版本</button>}</section>;
}

export function activate(context: ClientPluginContext) { context.registerView('registration', Registration); context.registerView('list', List); context.registerView('versions', Versions); context.registerView('preview', Preview); }
