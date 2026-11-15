import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { z } from 'zod';
import { API_VERSION, SDK_VERSION, distributionProfileSchema } from '@aork/sdk';
import type { Bootstrap, Diagnostic, DistributionProfile } from '@aork/sdk';
import { activateGraph, inspectGraph } from '@aork/kernel';
import type { ActiveGraph, PluginGraph } from '@aork/kernel';
import { openStorage } from '@aork/storage';
import { createHttpTransport } from '@aork/transport-http';
import type { PublicAsset } from '@aork/transport-http';

export interface HostOptions { dataDir: string; host?: string; port?: number; distributionDir?: string }
const startupSchema = z.object({ version: z.literal(1), host: z.string().min(1), port: z.number().int().min(0).max(65535) }).strict();
const contentType = (path: string) => ({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream';

export async function startHost(options: HostOptions) {
  const storage = await openStorage(options.dataDir);
  let active: ActiveGraph | undefined;
  let transport: ReturnType<typeof createHttpTransport> | undefined;
  try {
    const distributionDir = resolve(options.distributionDir ?? 'dist');
    const savedStartup = startupSchema.parse(storage.loadStartup() ?? { version: 1, host: '127.0.0.1', port: 6688 });
    const startup = startupSchema.parse({ ...savedStartup, ...(options.host !== undefined ? { host: options.host } : {}), ...(options.port !== undefined ? { port: options.port } : {}) });
    const persistedProfile = storage.loadProfile();
    const profile = distributionProfileSchema.parse(persistedProfile ?? JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    const graph = await inspectGraph(profile, join(distributionDir, 'plugins'));
    const diagnostics: Diagnostic[] = [...graph.diagnostics];
    try { active = await activateGraph(graph, pluginId => storage.scope(pluginId)); }
    catch (error) {
      const pluginId = error && typeof error === 'object' && 'pluginId' in error ? String(error.pluginId) : undefined;
      diagnostics.push({ code: 'PLUGIN_ACTIVATION_FAILED', message: pluginId ? `${pluginId} failed during server activation; inspect the selected plugin using local maintenance` : 'Server plugin graph activation failed; use local maintenance', ...(pluginId ? { pluginId } : {}), location: 'server.activation' });
    }
    if (!persistedProfile) storage.saveProfile(graph.profile);
    const hostEpoch = randomUUID();
    const assets = await distributionAssets(distributionDir, graph);
    const importMap = await readFile(join(distributionDir, 'runtime/import-map.json'), 'utf8');
    const html = (await readFile(join(distributionDir, 'web/index.html'), 'utf8')).replace('<!--AORK_IMPORT_MAP-->', `<script type="importmap">${importMap.replaceAll('<', '\\u003c')}</script>`);
    const bootstrap = (access: Bootstrap['access']): Bootstrap => ({
      apiVersion: API_VERSION, sdkVersion: SDK_VERSION, hostEpoch, pluginGraphHash: graph.hash,
      profile: graph.profile, access, diagnostics, ui: graph.profile.ui,
      plugins: graph.packages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version,
        ...(pkg.manifest.client ? { client: `/plugins/${pkg.hash}/${pkg.manifest.client}` } : {}),
        styles: pkg.manifest.assets.filter(path => path.endsWith('.css')).map(path => `/plugins/${pkg.hash}/${path}`), manifest: pkg.manifest })),
      maintenance: { command: 'pnpm aork doctor --data-dir <data-directory>' },
    });
    transport = createHttpTransport({ active, bootstrap, assets, html });
    const url = await transport.listen({ host: startup.host, port: startup.port });
    storage.saveStartup(startup);
    let closed = false;
    return { url, dataDir: storage.dataDir, async close() {
      if (closed) return; closed = true;
      try { await transport!.close(); } finally { try { await active?.close(); } finally { await storage.close(); } }
    } };
  } catch (error) { await transport?.close(); await active?.close(); await storage.close(); throw error; }
}

async function distributionAssets(distributionDir: string, graph: PluginGraph) {
  const assets = new Map<string, PublicAsset>();
  async function collect(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(path, url);
      else if (entry.name !== 'index.html' && entry.name !== 'import-map.json') assets.set(url, { bytes: await readFile(path), type: contentType(path) });
    }
  }
  await collect(join(distributionDir, 'web/assets'), '/assets');
  await collect(join(distributionDir, 'runtime'), '/runtime');
  for (const pkg of graph.packages) {
    for (const entry of [pkg.manifest.client, ...pkg.manifest.assets]) if (entry) assets.set(`/plugins/${pkg.hash}/${entry}`, { bytes: pkg.assets.get(entry)!, type: contentType(entry) });
  }
  return assets;
}

/** Local maintenance only; it takes the same exclusive data lock as serve. */
export async function maintainProfile(options: { dataDir: string; distributionDir?: string; profile?: unknown }) {
  const storage = await openStorage(options.dataDir);
  try {
    const distributionDir = resolve(options.distributionDir ?? 'dist');
    const profile: DistributionProfile = distributionProfileSchema.parse(options.profile ?? storage.loadProfile() ?? JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    const graph = await inspectGraph(profile, join(distributionDir, 'plugins'));
    if (options.profile && graph.diagnostics.length) throw new Error(graph.diagnostics.map(diagnostic => `${diagnostic.location}: ${diagnostic.message}`).join('\n'));
    if (options.profile) storage.saveProfile(profile);
    return { profile, startup: storage.loadStartup(), pluginGraphHash: graph.hash, diagnostics: graph.diagnostics, plugins: graph.packages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version })) };
  } finally { await storage.close(); }
}
