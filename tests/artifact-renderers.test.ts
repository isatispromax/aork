import { afterEach, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A real client-only renderer Plugin dropped into the distribution as raw ESM, like any installed package. */
async function rendererPlugin(distribution: string, id: string, providers: Array<{ id: string; mimeTypes: string[] }>) {
  const directory = join(distribution, 'plugins', id, '0.1.0'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', client: 'client.js', ui: { providers: providers.map(provider => ({ id: provider.id, contract: 'aork.artifacts.renderer@1', mimeTypes: provider.mimeTypes })) } }));
  await writeFile(join(directory, 'client.js'), `import { createElement } from 'react'; export function activate(context) { for (const provider of ${JSON.stringify(providers.map(provider => provider.id))}) context.registerView(provider, () => createElement('p', null, 'renderer ${id}')); }`);
}
async function registerFile(f: Awaited<ReturnType<typeof sessionHost>>, env: Awaited<ReturnType<typeof sessionEnvironment>>, path: string, bytes: string | Uint8Array) {
  await writeFile(join(env.workspace.directory, path), bytes);
  return (await (await f.command('artifacts.register', { projectId: env.project.id, title: path, source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: path } })).json()).result as { artifactId: string; versionId: string; ordinal: number };
}
function preview(f: Awaited<ReturnType<typeof sessionHost>>, versionId: string) { return fetch(`${f.host.url}/api/resources/artifacts.preview?versionId=${versionId}`, { headers: { Cookie: f.cookie } }); }

test('renderers are resolved by media type, ambiguity demands an explicit profile selection, and deactivation removes contributions', async () => {
  const f = await sessionHost(false, async ({ distributionDir, profile }) => {
    await rendererPlugin(distributionDir, 'artifact-renderer-fixture', [{ id: 'markdown', mimeTypes: ['text/markdown'] }]);
    await rendererPlugin(distributionDir, 'artifact-renderer-rival', [{ id: 'markdown', mimeTypes: ['text/markdown'] }]);
    profile.plugins.push({ id: 'artifact-renderer-fixture', version: '0.1.0', enabled: true });
  });
  cleanup.push(() => f.close());
  expect(f.bootstrap.ui.renderers['text/html']).toBe('artifacts:html');
  expect(f.bootstrap.ui.renderers['text/markdown']).toBe('artifact-renderer-fixture:markdown');
  const env = await sessionEnvironment(f);
  const note = await registerFile(f, env, 'note.md', '# a heading');

  const rival = await f.command('plugins.setEnabled', { pluginId: 'artifact-renderer-rival', enabled: true, version: '0.1.0' });
  expect(rival.status).toBe(400); expect(await rival.json()).toMatchObject({ error: { code: 'UI_RENDERER_SELECTION_REQUIRED' } });
  expect(await (await preview(f, note.versionId)).json()).toMatchObject({ status: 'text', mediaType: 'text/markdown', text: '# a heading' });

  const absent = await f.command('plugins.compose', { ui: { ...f.bootstrap.profile.ui, renderers: { 'text/markdown': 'artifact-renderer-rival:markdown' } } });
  expect(absent.status).toBe(400); expect(await absent.json()).toMatchObject({ error: { code: 'UI_RENDERER_UNAVAILABLE' } });

  const explicit = await f.command('plugins.compose', { ui: { ...f.bootstrap.profile.ui, renderers: { 'text/markdown': 'artifact-renderer-fixture:markdown' } } });
  expect(explicit.status).toBe(200); await f.refreshBootstrap();
  expect(f.bootstrap.ui.renderers['text/markdown']).toBe('artifact-renderer-fixture:markdown');

  const competing = await f.command('plugins.setEnabled', { pluginId: 'artifact-renderer-rival', enabled: true, version: '0.1.0' });
  expect(competing.status).toBe(200); await f.refreshBootstrap();
  expect(f.bootstrap.ui.renderers['text/markdown']).toBe('artifact-renderer-fixture:markdown');

  const disabled = await f.command('plugins.setEnabled', { pluginId: 'artifact-renderer-fixture', enabled: false });
  expect(disabled.status).toBe(200); await f.refreshBootstrap();
  expect(f.bootstrap.ui.renderers['text/markdown']).toBe('artifact-renderer-rival:markdown');
  const removed = await f.command('plugins.setEnabled', { pluginId: 'artifact-renderer-rival', enabled: false });
  expect(removed.status).toBe(200); await f.refreshBootstrap();
  expect(f.bootstrap.ui.renderers['text/markdown']).toBeUndefined();
  expect(f.bootstrap.ui.renderers['text/html']).toBe('artifacts:html');
});

test('captured versions report a deterministic media type for renderer selection while the original version stays unchanged', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close());
  const env = await sessionEnvironment(f);
  const html = await registerFile(f, env, 'page.html', '<!doctype html><p>active bytes</p>');
  expect(await (await preview(f, html.versionId)).json()).toEqual({ status: 'text', versionId: html.versionId, mediaType: 'text/html', text: '<!doctype html><p>active bytes</p>' });
  const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
  const figure = await registerFile(f, env, 'figure.png', image);
  expect(await (await preview(f, figure.versionId)).json()).toEqual({ status: 'unsupported', versionId: figure.versionId, mediaType: 'image/png' });
  const unknown = await registerFile(f, env, 'result.xyz', 'opaque payload');
  expect(await (await preview(f, unknown.versionId)).json()).toEqual({ status: 'text', versionId: unknown.versionId, mediaType: 'application/octet-stream', text: 'opaque payload' });
  const external = (await (await f.command('artifacts.register', { projectId: env.project.id, title: 'Remote', source: { kind: 'external-reference', url: 'https://example.org/study' } })).json()).result;
  expect(await (await preview(f, external.versionId)).json()).toEqual({ status: 'external-reference', versionId: external.versionId });
  const detail = await (await fetch(`${f.host.url}/api/snapshots/artifacts.detail?artifactId=${html.artifactId}&versionId=${html.versionId}`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } })).json();
  expect(detail.snapshot.selected.content).not.toHaveProperty('mediaType');
});
