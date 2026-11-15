import { publicManifest, publicProfile, recordRejection, loadRejection, GraphPreflightError } from './diagnostics.js';
import { loadInitialProfile } from './install.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { z } from 'zod';
import { API_VERSION, SDK_VERSION, AorkError, distributionProfileSchema } from '@aork/sdk';
import type { Bootstrap, Diagnostic, DistributionProfile } from '@aork/sdk';
import { activateGraph, affectedPluginClosure, validateConfiguration, inspectCatalog, inspectGraph, inspectPackageManifest, maintainPlugin } from '@aork/kernel';
import type { ActiveGraph, PluginGraph } from '@aork/kernel';
import { openStorage } from '@aork/storage';
import { createHttpTransport } from '@aork/transport-http';
import type { PublicAsset } from '@aork/transport-http';
import { AUTHORIZATION_SERVICE, PLUGIN_DIAGNOSTICS_SERVICE, PLUGIN_MANAGEMENT_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, PluginManagementService } from '@aork/sdk/server';

export interface HostOptions { dataDir: string; host?: string; port?: number; distributionDir?: string; insecureLoopback?: boolean; publicOrigin?: string }
const startupSchema = z.object({ version: z.literal(1), host: z.string().min(1), port: z.number().int().min(0).max(65535), insecureLoopback: z.boolean().default(false), publicOrigin: z.string().nullable().default(null) }).strict();
const contentType = (path: string) => ({ '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream';

export async function startHost(options: HostOptions) {
  const storage = await openStorage(options.dataDir);
  let active: ActiveGraph | undefined;
  let transport: ReturnType<typeof createHttpTransport> | undefined;
  try {
    const distributionDir = resolve(options.distributionDir ?? 'dist');
    const savedStartup = startupSchema.parse(storage.loadStartup() ?? { version: 1, host: '127.0.0.1', port: 6688 });
    const startup = startupSchema.parse({ ...savedStartup, ...(options.host !== undefined ? { host: options.host } : {}), ...(options.port !== undefined ? { port: options.port } : {}), ...(options.insecureLoopback !== undefined ? { insecureLoopback: options.insecureLoopback } : {}), ...(options.publicOrigin !== undefined ? { publicOrigin: options.publicOrigin } : {}) });
    if (startup.insecureLoopback && !['127.0.0.1', '::1'].includes(startup.host)) throw new Error('Insecure cookies are permitted only with an explicit loopback bind');
    if (startup.publicOrigin) {
      const origin = new URL(startup.publicOrigin);
      if (origin.origin !== startup.publicOrigin || origin.username || origin.password || (origin.protocol !== 'https:' && !(startup.insecureLoopback && origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)))) throw new Error('public-origin must be a canonical HTTPS origin, or HTTP loopback in explicit development mode');
    }
    const persistedProfile = storage.loadProfile();
    const profile = distributionProfileSchema.parse(persistedProfile ?? await loadInitialProfile(storage.dataDir) ?? JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    let graph = await inspectGraph(profile, join(distributionDir, 'plugins'), join(storage.dataDir, 'plugins'));
    const diagnostics: Diagnostic[] = [...graph.diagnostics];
    const inspect = async () => ({ profile: publicProfile(graph.profile), pluginGraphHash: graph.hash, diagnostics:[...diagnostics,...(active?.lifecycleDiagnostics??[])], rejected: await loadRejection(storage.dataDir), plugins: graph.packages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version, requires: pkg.manifest.requires, provides: pkg.manifest.provides, capabilities: pkg.manifest.capabilities, configured: !!graph.profile.plugins.find(plugin => plugin.id === pkg.manifest.id)?.config })) });
    let assets = await distributionAssets(distributionDir, graph);
    let applying = false;
    const apply = async (candidate: DistributionProfile, expectedGraph = graph.hash) => {
      if(expectedGraph!==graph.hash)throw new AorkError('RELOAD_REQUIRED','The plugin graph changed; reload the page',409);
      if (applying) throw new AorkError('PLUGIN_CHANGING', 'A plugin change is already in progress', 409);
      applying = true;
      const previous = graph;
      try {
        const next = await inspectGraph(candidate, join(distributionDir, 'plugins'), join(storage.dataDir, 'plugins'));
        if (next.diagnostics.length) throw new GraphPreflightError(next.diagnostics[0]!);
        const nextAssets = await distributionAssets(distributionDir, next);
        if (!active) throw new AorkError('PLUGIN_GRAPH_UNAVAILABLE', 'Use local profile repair before changing plugins', 503);
        await active.reconfigure(next);
        try { storage.saveProfile(next.profile); }
        catch (error) { await active.reconfigure(previous); throw error; }
        graph = next;
        assets.clear(); for (const [name, asset] of nextAssets) assets.set(name, asset);
        diagnostics.splice(0, diagnostics.length, ...next.diagnostics);
        return { pluginGraphHash: next.hash, reloadRequired: true as const };
      } catch (error) { await recordRejection(storage.dataDir, error); throw error; }
      finally { applying = false; }
    };
    const management: PluginManagementService = {
      async inspect() {
        const current=graph;
        const plugins = [];
        for (const selection of current.profile.plugins) {
          const manifest = await inspectPackageManifest(selection, join(distributionDir, 'plugins'), join(storage.dataDir, 'plugins'));
          plugins.push({id:selection.id,version:selection.version,enabled:selection.enabled,status:selection.enabled?'active' as const:'disabled' as const,requires:manifest.requires,provides:manifest.provides,dependencies:manifest.dependencies,config:selection.config??{},...(manifest.configSchema!==undefined?{configSchema:manifest.configSchema}:{}),ui:manifest.ui});
        }
        return {pluginGraphHash:current.hash, profile:structuredClone(current.profile),plugins};
      },
      async configure(pluginId, config) {
        const expectedGraph=graph.hash;
        const candidate = structuredClone(graph.profile); const selection = candidate.plugins.find(item=>item.id===pluginId);
        if (!selection) throw new AorkError('PLUGIN_NOT_SELECTED', 'Select an installed plugin before configuring it');
        const manifest=await inspectPackageManifest(selection,join(distributionDir,'plugins'),join(storage.dataDir,'plugins'));
        try{validateConfiguration(manifest,config);}catch(error){await recordRejection(storage.dataDir,error);throw error;}selection.config=config; return apply(candidate,expectedGraph);
      },
      async setEnabled(pluginId, enabled) {
        const candidate=structuredClone(graph.profile);const selection=candidate.plugins.find(item=>item.id===pluginId);
        if(!selection)throw new AorkError('PLUGIN_NOT_SELECTED','Plugin is not in the current distribution profile');
        const affected=enabled?[pluginId]:affectedPluginClosure(graph,[pluginId]);
        for(const item of candidate.plugins)if(affected.includes(item.id))item.enabled=enabled;
        if(!enabled) {
          for(const [contract,provider]of Object.entries(candidate.ui.providers))if(affected.includes(provider.split(':')[0]!)) {
            const fallback=candidate.ui.fallbacks?.[contract];if(fallback&&!affected.includes(fallback.split(':')[0]!))candidate.ui.providers[contract]=fallback;
            else throw new AorkError('UI_REPLACEMENT_REQUIRED','Select an explicit compatible replacement for every affected UI provider before disabling this plugin');
          }
          if(candidate.ui.fallbacks)for(const[contract,provider]of Object.entries(candidate.ui.fallbacks))if(affected.includes(provider.split(':')[0]!))delete candidate.ui.fallbacks[contract];
          candidate.ui.extensions=candidate.ui.extensions.filter(item=>!affected.includes(item.id.split(':')[0]!));
          if(candidate.services)for(const[contract,provider]of Object.entries(candidate.services))if(affected.includes(provider))delete candidate.services[contract];
        }
        return apply(candidate);
      },
      async compose(ui) {return apply({...structuredClone(graph.profile),ui});},
    };
    try { active = await activateGraph(graph, pluginId => storage.scope(pluginId), { bind: storage.durable.bind, managedWorkspaces: join(storage.dataDir, 'workspaces') }, new Map<string,unknown>([[PLUGIN_DIAGNOSTICS_SERVICE, { inspect }],[PLUGIN_MANAGEMENT_SERVICE, management]])); }
    catch (error) {
      const pluginId = error && typeof error === 'object' && 'pluginId' in error ? String(error.pluginId) : undefined;
      diagnostics.push({ code: 'PLUGIN_ACTIVATION_FAILED', message: pluginId ? `${pluginId} failed during server activation; inspect the selected plugin using local maintenance` : 'Server plugin graph activation failed; use local maintenance', ...(pluginId ? { pluginId } : {}), location: 'server.activation' });
    }
    if (!persistedProfile) storage.saveProfile(graph.profile);
    const hostEpoch = randomUUID();
    const importMap = await readFile(join(distributionDir, 'runtime/import-map.json'), 'utf8');
    const html = (await readFile(join(distributionDir, 'web/index.html'), 'utf8')).replace('<!--AORK_IMPORT_MAP-->', `<script type="importmap">${importMap.replaceAll('<', '\\u003c')}</script>`);
    const bootstrap = (access: Bootstrap['access']): Bootstrap => ({
      apiVersion: API_VERSION, sdkVersion: SDK_VERSION, hostEpoch, pluginGraphHash: graph.hash,
      profile: publicProfile(graph.profile), access, diagnostics:[...diagnostics,...(active?.lifecycleDiagnostics??[])], ui: graph.profile.ui,
      plugins: graph.packages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version,
        ...(pkg.manifest.client ? { client: `/plugins/${pkg.hash}/${pkg.manifest.client}` } : {}),
        styles: pkg.manifest.assets.filter(path => path.endsWith('.css')).map(path => `/plugins/${pkg.hash}/${path}`), manifest: publicManifest(pkg.manifest) })),
      maintenance: { command: 'pnpm aork doctor --data-dir <data-directory>' },
    });
    let servedOrigin = startup.publicOrigin ?? '';
    transport = createHttpTransport({ active, bootstrap, assets, html, origin: () => servedOrigin, insecureLoopback: startup.insecureLoopback, durable: storage.durable });
    const url = await transport.listen({ host: startup.host, port: startup.port });
    servedOrigin ||= url;
    storage.saveStartup(startup);
    let closed = false;
    const accessUrl = active?.service<AuthorizationService>(AUTHORIZATION_SERVICE)?.accessUrl(servedOrigin);
    return { url, accessUrl, dataDir: storage.dataDir, async close() {
      if (closed) return; closed = true;
      try { await transport!.close(); } finally { try { await active?.close(); } finally { await storage.close(); } }
    } };
  } catch (error) { await transport?.close(); await active?.close(); await storage.close(); throw error; }
}

function authorizationOwner(graph: PluginGraph) {
  const candidates = graph.packages.filter(pkg => pkg.manifest.provides.includes(AUTHORIZATION_SERVICE));
  const selection = graph.profile.services?.[AUTHORIZATION_SERVICE];
  return selection ? candidates.find(pkg => pkg.manifest.id === selection) : candidates.length === 1 ? candidates[0] : undefined;
}

/** Access repair stays available without activating a broken authentication plugin. */
export async function maintainAccess(options: { dataDir: string; distributionDir?: string; action: 'rotate' | 'recover' }) {
  const storage = await openStorage(options.dataDir);
  try {
    const distributionDir = resolve(options.distributionDir ?? 'dist');
    const pluginsDir = join(distributionDir, 'plugins');
    const defaults = distributionProfileSchema.parse(JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    const profile = distributionProfileSchema.parse(storage.loadProfile() ?? await loadInitialProfile(storage.dataDir) ?? defaults);
    if (options.action === 'recover') {
      const defaultGraph = await inspectGraph(defaults, pluginsDir);
      const owner = authorizationOwner(defaultGraph);
      if (!owner) throw new Error('Distribution has no default authorization provider');
      const competitors = new Set<string>();
      for (const selection of profile.plugins.filter(plugin => plugin.enabled && plugin.id !== owner.manifest.id)) {
        const manifest = await inspectPackageManifest(selection, pluginsDir, join(storage.dataDir, 'plugins'));
        if (manifest.provides.includes(AUTHORIZATION_SERVICE)) competitors.add(selection.id);
      }
      profile.plugins = [...profile.plugins.filter(plugin => plugin.id !== owner.manifest.id).map(plugin => competitors.has(plugin.id) ? { ...plugin, enabled: false } : plugin), { ...defaults.plugins.find(plugin => plugin.id === owner.manifest.id)!, enabled: true }];
      profile.services = { ...profile.services, [AUTHORIZATION_SERVICE]: owner.manifest.id };
      for (const contract of ['aork.auth.login@1', 'aork.auth.controls@1']) {
        profile.ui.providers[contract] = defaults.ui.providers[contract]!;
        const fallback = defaults.ui.fallbacks?.[contract];
        if (fallback) (profile.ui.fallbacks ??= {})[contract] = fallback;
        else if (profile.ui.fallbacks) delete profile.ui.fallbacks[contract];
      }
    }
    const graph = await inspectGraph(profile, pluginsDir, join(storage.dataDir, 'plugins'));
    if (graph.diagnostics.length) throw new Error('Profile has additional faults; use doctor and profile apply before access recovery');
    const owner = authorizationOwner(graph);
    if (!owner) throw new Error('Profile has no authorization provider; use local access recover');
    const result = await maintainPlugin(owner, storage.scope(owner.manifest.id), options.action);
    if (options.action === 'recover') storage.saveProfile(profile);
    return result;
  } finally { await storage.close(); }
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
    const profile: DistributionProfile = distributionProfileSchema.parse(options.profile ?? storage.loadProfile() ?? await loadInitialProfile(storage.dataDir) ?? JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    const graph = await inspectGraph(profile, join(distributionDir, 'plugins'), join(storage.dataDir, 'plugins'));
    if (options.profile && graph.diagnostics.length) throw new GraphPreflightError(graph.diagnostics[0]!);
    if (options.profile) {
      const previous=distributionProfileSchema.parse(storage.loadProfile()??await loadInitialProfile(storage.dataDir)??JSON.parse(await readFile(join(distributionDir,'profiles/personal-server.json'),'utf8')));
      const installed=await inspectCatalog(join(storage.dataDir,'plugins'));
      if(installed.length&&profile.plugins.some(selection=>!previous.plugins.some(item=>item.id===selection.id&&item.version===selection.version)))throw new AorkError('FRESH_INSTANCE_REQUIRED','Selecting a new independently installed package or version requires the installation maintenance workflow');
    }
    if (options.profile) storage.saveProfile(profile);
    const catalog = [];
    for (const [source, directory] of [['distribution', join(distributionDir, 'plugins')], ['installed', join(storage.dataDir, 'plugins')]] as const) {
      for (const pkg of await inspectCatalog(directory)) catalog.push({ ...pkg, source, enabled: graph.profile.plugins.some(selection => selection.id === pkg.id && selection.version === pkg.version && selection.enabled) });
    }
    return { profile: publicProfile(profile), rejected: await loadRejection(storage.dataDir), startup: storage.loadStartup(), pluginGraphHash: graph.hash, diagnostics: graph.diagnostics, catalog, plugins: graph.packages.map(pkg => ({ id: pkg.manifest.id, version: pkg.manifest.version })) };
  } catch (error) { if (options.profile) await recordRejection(storage.dataDir, error); throw error; } finally { await storage.close(); }
}
