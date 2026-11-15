import { compileConfig } from './config.js';
import { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, access } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { AorkError, SDK_VERSION, distributionProfileSchema } from '@aork/sdk';
import type { Diagnostic, DistributionProfile, PluginManifest } from '@aork/sdk';
import { PLUGIN_DIAGNOSTICS_SERVICE, PLUGIN_MANAGEMENT_SERVICE, HOST_CAPABILITIES } from '@aork/sdk/server';
import { UI_CONTRACTS, UI_EXTENSION_TARGETS } from '@aork/sdk/client';
import type { CommandRegistration, QueryRegistration, ScopedState, ServerPlugin, ServerPluginContext, LocalMaintenancePlugin, DurableCommandRegistration, RepositoryDeclaration, OwnerRepository, LifecycleAuthority, Disposer, ResourceRegistration } from '@aork/sdk/server';
import { readPackageFiles, validatePackageFiles } from './package.js';
export { readPluginArchive, validatePackageFiles, inspectCatalog, inspectPackageManifest } from './package.js';

export interface PluginPackage { manifest: PluginManifest; directory: string; assets: Map<string, Uint8Array>; hash: string }
export interface PluginGraph { profile: DistributionProfile; packages: PluginPackage[]; hash: string; diagnostics: Diagnostic[] }
export interface RegisteredQuery { pluginId: string; registration: QueryRegistration }
export type RegisteredCommand = { pluginId: string; registration: CommandRegistration; durable?: false } | { pluginId: string; registration: DurableCommandRegistration; durable: true };

async function packageFile(directory: string, entry: string) {
  const path = await realpath(resolve(directory, entry));
  const inside = relative(directory, path);
  if (inside.startsWith('..') || isAbsolute(inside) || !(await stat(path)).isFile()) throw new AorkError('PLUGIN_PATH_INVALID', `Entry ${entry} escapes plugin package or is not a file`);
  return path;
}

/** Shared synchronous validation for enabled graphs and protected edits of disabled packages. */
export function validateConfiguration(manifest: PluginManifest, config: Record<string, unknown>) {
  if (manifest.configSchema === undefined) {
    if (Object.keys(config).length) throw new AorkError('CONFIG_UNDECLARED', `${manifest.id}@${manifest.version} declares no configuration fields`);
    return;
  }
  const validate = compileConfig(manifest)!;
  if (!validate(config)) throw new AorkError('CONFIG_INVALID', `${manifest.id}@${manifest.version}: configuration fails schema at ${validate.errors?.map(error=>error.schemaPath).join(', ')}. Correct plugin config according to configSchema before enabling.`);
}

/** Preflight the complete static graph before importing any plugin entry. */
export async function inspectGraph(profileInput: unknown, pluginsDir: string, installedDir?: string): Promise<PluginGraph> {
  const profile = distributionProfileSchema.parse(profileInput);
  const packages: PluginPackage[] = [];
  const seen = new Set<string>();
  for (const selection of profile.plugins) {
    if (seen.has(selection.id)) throw new AorkError('DUPLICATE_PLUGIN', `Duplicate profile plugin ${selection.id}`);
    seen.add(selection.id);
    if (!semver.valid(selection.version)) throw new AorkError('PLUGIN_VERSION_INVALID', `Invalid version for ${selection.id}`);
    if (!selection.enabled) continue;
    let catalog = pluginsDir;
    try { await access(join(pluginsDir, selection.id, selection.version)); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || !installedDir) throw error; catalog = installedDir; }
    let directory: string;
    try { directory = await realpath(join(catalog, selection.id, selection.version)); }
    catch { throw new AorkError('PLUGIN_MISSING', `${selection.id}@${selection.version} is not installed. Install the exact package version or correct the profile selection.`); }
    const rawManifest = await readFile(join(directory, 'aork.plugin.json'), 'utf8');
    const manifest = await validatePackageFiles(await readPackageFiles(join(catalog, selection.id, selection.version), catalog));
    if (manifest.id !== selection.id || manifest.version !== selection.version) throw new AorkError('PLUGIN_IDENTITY_MISMATCH', `Manifest identity differs from profile selection ${selection.id}@${selection.version}`);
    if (!semver.validRange(manifest.sdkRange) || !semver.satisfies(SDK_VERSION, manifest.sdkRange)) throw new AorkError('SDK_INCOMPATIBLE', `${manifest.id} requires SDK ${manifest.sdkRange}; Host has ${SDK_VERSION}`);
    validateConfiguration(manifest, selection.config ?? {});
    for (const capability of manifest.capabilities) {
      if (!HOST_CAPABILITIES.includes(capability)) throw new AorkError('CAPABILITY_UNAVAILABLE', `${manifest.id}@${manifest.version} requests unsupported capability ${capability}. Remove it or use a Host that supports it.`);
      if (!selection.grants?.includes(capability)) throw new AorkError('CAPABILITY_NOT_GRANTED', `${manifest.id}@${manifest.version} requires explicit grant ${capability}. Review and add it to this plugin selection grants.`);
    }
    if (selection.grants?.some(grant => !manifest.capabilities.includes(grant))) throw new AorkError('CAPABILITY_UNDECLARED', `${manifest.id}@${manifest.version} has undeclared grants. Remove them from the profile.`);
    const assets = new Map<string, Uint8Array>();
    for (const entry of new Set([manifest.server, manifest.client, manifest.maintenance, ...manifest.assets].filter((entry): entry is string => Boolean(entry)))) assets.set(entry, await readFile(await packageFile(directory, entry)));
    const hash = createHash('sha256').update(rawManifest);
    for (const [name, bytes] of [...assets].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(bytes);
    packages.push({ manifest, directory, assets, hash: hash.digest('hex') });
  }
  for (const pkg of packages) for (const dependency of pkg.manifest.dependencies) {
    const selected = packages.find(candidate => candidate.manifest.id === dependency.id);
    if (!selected && !dependency.optional) throw new AorkError('PLUGIN_DEPENDENCY_MISSING', `${pkg.manifest.id}@${pkg.manifest.version} requires plugin ${dependency.id}. Install and explicitly enable a compatible version.`);
    if (selected && !semver.satisfies(selected.manifest.version, dependency.range)) throw new AorkError('PLUGIN_DEPENDENCY_INCOMPATIBLE', `${pkg.manifest.id}@${pkg.manifest.version} requires ${dependency.id} ${dependency.range}; selected ${selected.manifest.version}. Select a compatible dependency version.`);
  }
  const serviceOwners = new Map<string, PluginPackage[]>();
  for (const pkg of packages) for (const service of pkg.manifest.provides) {
    if ([PLUGIN_DIAGNOSTICS_SERVICE, PLUGIN_MANAGEMENT_SERVICE].includes(service)) throw new AorkError('SERVICE_RESERVED', `${pkg.manifest.id}@${pkg.manifest.version}: ${service} is Host-owned. Require it with the declared capability instead of providing it.`);
    const owners = serviceOwners.get(service) ?? [];
    if (owners.some(owner => (owner.manifest.serviceModes[service] ?? 'singleton') !== 'multi-provider') || (owners.length && pkg.manifest.serviceModes[service] !== 'multi-provider')) throw new AorkError('SERVICE_CONFLICT', `${pkg.manifest.id}@${pkg.manifest.version}: ${service} has conflicting singleton providers. Enable one provider, or declare multi-provider in every owner.`);
    owners.push(pkg); serviceOwners.set(service, owners);
  }
  for (const [service, owners] of serviceOwners) if (owners.length > 1 && !profile.services?.[service]) throw new AorkError('SERVICE_SELECTION_REQUIRED', `${owners.map(owner => `${owner.manifest.id}@${owner.manifest.version}`).join(', ')} provide ${service}. Explicitly select profile.services[${service}] before activation.`);
  for (const [service, selection] of Object.entries(profile.services ?? {})) if (!serviceOwners.get(service)?.some(owner => owner.manifest.id === selection)) throw new AorkError('SERVICE_SELECTION_INVALID', `Selected provider ${selection} does not provide ${service}. Select an enabled compatible provider.`);
  const dependencies = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const needed = new Set(pkg.manifest.dependencies.filter(dependency => packages.some(candidate => candidate.manifest.id === dependency.id)).map(dependency => dependency.id));
    const mandatory = new Set([...pkg.manifest.requires, ...pkg.manifest.ui.providers.flatMap(provider => provider.requires), ...pkg.manifest.ui.extensions.flatMap(extension => extension.requires)]);
    for (const service of new Set([...mandatory, ...pkg.manifest.optionalRequires])) {
      const owners = serviceOwners.get(service) ?? [];
      if (!owners.length && [PLUGIN_DIAGNOSTICS_SERVICE, PLUGIN_MANAGEMENT_SERVICE].includes(service)) {
        const capability = service === PLUGIN_DIAGNOSTICS_SERVICE ? 'diagnostics.read' : 'plugins.manage';
        if (!pkg.manifest.capabilities.includes(capability)) throw new AorkError('CAPABILITY_NOT_GRANTED', `${pkg.manifest.id}@${pkg.manifest.version}: Host service ${service} requires declared and granted ${capability}.`);
        continue;
      }
      if (!owners.length) {
        if (!mandatory.has(service)) continue;
        const otherMajor = [...serviceOwners.keys()].find(id => id.split('@')[0] === service.split('@')[0]);
        throw new AorkError(otherMajor ? 'SERVICE_CONTRACT_INCOMPATIBLE' : 'SERVICE_MISSING', `${pkg.manifest.id}@${pkg.manifest.version} requires ${service}${otherMajor ? `; only ${otherMajor} is available` : ''}. Enable a provider for the exact contract major.`);
      }
      const chosen = profile.services?.[service];
      if (owners.length > 1 && !chosen) throw new AorkError('SERVICE_SELECTION_REQUIRED', `${pkg.manifest.id}@${pkg.manifest.version} requires ${service} with multiple providers. Explicitly select profile.services[${service}].`);
      const owner = owners.find(owner => owner.manifest.id === chosen) ?? owners[0]!;
      if (owner.manifest.id !== pkg.manifest.id) needed.add(owner.manifest.id);
    }
    dependencies.set(pkg.manifest.id, needed);
  }
  const ordered: PluginPackage[] = [];
  const remaining = [...packages];
  while (remaining.length) {
    const index = remaining.findIndex(pkg => [...dependencies.get(pkg.manifest.id)!].every(id => ordered.some(candidate => candidate.manifest.id === id)));
    if (index < 0) throw new AorkError('DEPENDENCY_CYCLE', `Dependency cycle involving ${remaining.map(pkg => `${pkg.manifest.id}@${pkg.manifest.version}`).join(', ')}. Remove a cyclic required or present optional dependency.`);
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  const diagnostics: Diagnostic[] = [];
  const candidates = new Map<string, string>();
  const extensions = new Set<string>();
  for (const pkg of ordered) {
    for (const provider of pkg.manifest.ui.providers) {
      const id = `${pkg.manifest.id}:${provider.id}`;
      if (candidates.has(id)) throw new AorkError('UI_PROVIDER_DUPLICATE', `Duplicate UI provider ${id}`);
      if (!UI_CONTRACTS.includes(provider.contract as typeof UI_CONTRACTS[number])) throw new AorkError('UI_CONTRACT_INCOMPATIBLE', `${id} targets unsupported contract ${provider.contract}`);
      if (!pkg.manifest.client) throw new AorkError('UI_ENTRY_MISSING', `${id} has no client entry`);
      candidates.set(id, provider.contract);
    }
    for (const extension of pkg.manifest.ui.extensions) {
      const id = `${pkg.manifest.id}:${extension.id}`;
      if (extensions.has(id)) throw new AorkError('UI_EXTENSION_DUPLICATE', `Duplicate extension ${id}`);
      if (!pkg.manifest.client || !UI_EXTENSION_TARGETS.includes(extension.target as typeof UI_EXTENSION_TARGETS[number])) throw new AorkError('UI_EXTENSION_TARGET_UNAVAILABLE', `Unsupported extension target ${extension.target}`);
      extensions.add(id);
    }
  }
  for (const contract of UI_CONTRACTS) {
    const selection = profile.ui.providers[contract];
    const selectedPackage = ordered.find(pkg => pkg.manifest.id === selection?.split(':')[0]);
    if (!selection || candidates.get(selection) !== contract) diagnostics.push({ code: 'UI_PROVIDER_UNAVAILABLE', message: `${selection ? `Selected ${selection} is unavailable or incompatible with` : 'Profile must explicitly select a compatible provider for'} ${contract}`, contract, ...(selection ? { pluginId: selection.split(':')[0]!, ...(selectedPackage ? { version: selectedPackage.manifest.version } : {}) } : {}), location: `ui.providers.${contract}`, remedy: 'Select an enabled provider declared for this exact UI contract; do not switch to an arbitrary installed candidate.' });
  }
  for (const contract of Object.keys(profile.ui.providers)) if (!UI_CONTRACTS.includes(contract as typeof UI_CONTRACTS[number])) diagnostics.push({ code: 'UI_CONTRACT_INCOMPATIBLE', message: `Unsupported UI contract ${contract}`, contract, location: `ui.providers.${contract}`, remedy: 'Use a UI contract major supported by this Host.' });
  for (const [contract, selection] of Object.entries(profile.ui.fallbacks ?? {})) {
    if (!UI_CONTRACTS.includes(contract as typeof UI_CONTRACTS[number]) || candidates.get(selection) !== contract) throw new AorkError('UI_FALLBACK_UNAVAILABLE', `${selection} is not a compatible fallback for ${contract}. Explicitly select an enabled provider for this exact contract.`);
  }
  const preferences = new Set<string>();
  for (const preference of profile.ui.extensions) {
    if (!extensions.has(preference.id) || preferences.has(preference.id)) throw new AorkError('UI_EXTENSION_UNAVAILABLE', `Missing or repeated extension preference ${preference.id}`);
    preferences.add(preference.id);
  }
  const hash = createHash('sha256').update(JSON.stringify(profile));
  for (const pkg of ordered) hash.update(pkg.hash);
  return { profile, packages: ordered, hash: hash.digest('hex'), diagnostics };
}

/** Read public persistence declarations without activating plugins or applying DDL. */
export async function preflightRepositories(graph:PluginGraph, bind:(owner:string,declaration?:RepositoryDeclaration,options?:{allowMigrations?:boolean})=>OwnerRepository) {
  for(const pkg of graph.packages) {
    if(!pkg.manifest.server)continue;
    try {
      const url=pathToFileURL(await packageFile(pkg.directory,pkg.manifest.server));url.searchParams.set('aork',pkg.hash);
      const module=await import(url.href) as Partial<ServerPlugin>;
      if(typeof module.activate!=='function')throw new Error('Invalid server entry');
      bind(pkg.manifest.id,module.persistence,{allowMigrations:false});
    }catch{throw new AorkError('PLUGIN_MAINTENANCE_REQUIRED',`${pkg.manifest.id}@${pkg.manifest.version} cannot bind its existing schema without migration; use local maintenance`,409);}
  }
}

/** Includes all consumers which must release references before their dependency is revoked. */
export function affectedPluginClosure(graph: PluginGraph, seeds: readonly string[]) {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of graph.packages) {
      const dependencies = [...pkg.manifest.dependencies.map(item => item.id), ...[...pkg.manifest.requires, ...pkg.manifest.optionalRequires, ...pkg.manifest.ui.providers.flatMap(item => item.requires), ...pkg.manifest.ui.extensions.flatMap(item => item.requires)].flatMap(id => {
        const selected = graph.profile.services?.[id];
        return graph.packages.filter(owner => owner.manifest.provides.includes(id) && (!selected || owner.manifest.id === selected)).map(owner => owner.manifest.id);
      })];
      if (!affected.has(pkg.manifest.id) && dependencies.some(id => affected.has(id))) { affected.add(pkg.manifest.id); changed = true; }
    }
  }
  return [...affected];
}

function readonlyConfiguration(value: Record<string, import('@aork/sdk').JsonValue>) {
  const freeze = (item: import('@aork/sdk').JsonValue): void => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  const copy=structuredClone(value);freeze(copy);return copy;
}

/** Each Cordis scope owns every registration; the same release path handles stop and failed activation. */
export async function activateGraph(initialGraph: PluginGraph, state: (pluginId: string) => ScopedState, persistence: { bind(owner: string, declaration?: RepositoryDeclaration, options?:{allowMigrations?:boolean}): OwnerRepository; allowInitialMigrations?:boolean; managedWorkspaces: string; pluginStateRoot: string }, builtins: ReadonlyMap<string, unknown> = new Map()) {
  let graph = initialGraph;
  const queries = new Map<string, RegisteredQuery>();
  const commands = new Map<string, RegisteredCommand>();
  const resources = new Map<string, { pluginId: string; registration: ResourceRegistration }>();
  const services = new Map<string, Map<string, unknown>>();
  const scopes = new Map<string, Context>();
  const revokeScopes=new Map<string,()=>void>();
  const cleanupFailures=new Set<string>();
  const authorities = new Map<string, LifecycleAuthority>();
  const usage = new Map<string, number>();
  const drained=new Set<()=>void>();
  const suspended = new Set<string>();
  const lifecycleState = state('@host/lifecycle');
  let changing = false;
  let closed = false;
  let barrierFailed=false;
  const lifecycleDiagnostics:Diagnostic[]=[];
  async function stop(ids: readonly string[]) {
    const errors: unknown[] = [];
    for (const pkg of [...graph.packages].reverse()) if (ids.includes(pkg.manifest.id)) {
      const scope=scopes.get(pkg.manifest.id);scopes.delete(pkg.manifest.id);
      revokeScopes.get(pkg.manifest.id)?.();revokeScopes.delete(pkg.manifest.id);
      try{await scope?.fiber.dispose();}catch(error){errors.push(error);}
      if(scope&&cleanupFailures.has(pkg.manifest.id))errors.push(new Error('Owned cleanup failed'));
    }
    if(errors.length){barrierFailed=true;lifecycleDiagnostics.push({code:'PLUGIN_CLEANUP_FAILED',message:'Owned plugin cleanup failed; affected services remain closed. Use local maintenance.',location:'server.lifecycle'});throw new AorkError('PLUGIN_CLEANUP_FAILED','Plugin cleanup failed; affected services remain closed; use local maintenance',503);}
  }
  async function activate(pkg: PluginPackage, allowMigrations=false) {
    if (!pkg.manifest.server) return;
    const root = new Context(); scopes.set(pkg.manifest.id, root);
    try {
      const entryUrl = pathToFileURL(await packageFile(pkg.directory, pkg.manifest.server)); entryUrl.searchParams.set('aork', pkg.hash);
      const module = await import(entryUrl.href) as Partial<ServerPlugin>;
      if (typeof module.activate !== 'function') throw new Error('Invalid server activation');
      const repository = persistence.bind(pkg.manifest.id, module.persistence, {allowMigrations});
      const manifest = pkg.manifest;
      let live=true;revokeScopes.set(manifest.id,()=>{live=false;});
      const ownedCleanup=(dispose:Disposer):Disposer=>async()=>{try{await dispose();}catch{cleanupFailures.add(manifest.id);}};
      await root.plugin({ name: manifest.id, inject: [], async apply(ctx) {
        ctx.effect(() => () => { live = false; });
        const ensureLive = () => { if (!live) throw new AorkError('PLUGIN_STOPPED', 'Plugin scope is no longer active', 503); };
        const owned = new Set<string>();
        const context: ServerPluginContext = {
          pluginId: manifest.id, state: state(manifest.id), repository, directories: Object.freeze({ managedWorkspaces: persistence.managedWorkspaces, pluginState: join(persistence.pluginStateRoot, manifest.id) }), config: readonlyConfiguration(graph.profile.plugins.find(plugin => plugin.id === manifest.id)?.config ?? {}),
          provide(id, value) {
            ensureLive();
            if (!manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare ${id}`);
            if (owned.has(id)) throw new AorkError('SERVICE_CONFLICT', `${manifest.id} registered ${id} twice`);
            owned.add(id); const providers = services.get(id) ?? new Map<string, unknown>(); providers.set(manifest.id, value); services.set(id, providers); ctx.effect(() => () => { providers.delete(manifest.id); });
          },
          service<T>(id: string): T {
            ensureLive();
            if (!manifest.requires.includes(id) && !manifest.optionalRequires.includes(id) && !manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare dependency ${id}`);
            if (builtins.has(id)) {
              const capability = id === PLUGIN_DIAGNOSTICS_SERVICE ? 'diagnostics.read' : id === PLUGIN_MANAGEMENT_SERVICE ? 'plugins.manage' : undefined;
              if (!capability || !manifest.capabilities.includes(capability) || !graph.profile.plugins.find(plugin => plugin.id === manifest.id)?.grants?.includes(capability)) throw new AorkError('CAPABILITY_NOT_GRANTED', `${manifest.id} has no explicit grant for the Host service`);
              return builtins.get(id) as T;
            }
            const providers = services.get(id); const selected = graph.profile.services?.[id] ?? (manifest.provides.includes(id) ? manifest.id : providers?.keys().next().value); const value = selected ? providers?.get(selected) : undefined;
            if (value === undefined) throw new AorkError('SERVICE_UNAVAILABLE', `${id} is unavailable`); return value as T;
          },
          resource(name,registration) {
            ensureLive();
            if(resources.has(name))throw new AorkError('RESOURCE_CONFLICT',`Duplicate resource ${name}`);
            if(!Number.isSafeInteger(registration.maxBytes)||registration.maxBytes<1||registration.maxBytes>8*1024*1024)throw new AorkError('RESOURCE_LIMIT_INVALID','Resources require a bound up to 8 MiB');
            ctx.effect(()=>{resources.set(name,{pluginId:manifest.id,registration});return()=>{resources.delete(name);};});
          },
          query(name, registration) { ensureLive(); if (queries.has(name)) throw new AorkError('QUERY_CONFLICT', `Duplicate query ${name}`); ctx.effect(() => { queries.set(name, { pluginId: manifest.id, registration }); return () => { queries.delete(name); }; }); },
          command(name, registration) { ensureLive(); if (commands.has(name)) throw new AorkError('COMMAND_CONFLICT', `Duplicate command ${name}`); ctx.effect(() => { commands.set(name, { pluginId: manifest.id, registration }); return () => { commands.delete(name); }; }); },
          durableCommand(name, registration) { ensureLive(); if (commands.has(name)) throw new AorkError('COMMAND_CONFLICT', `Duplicate command ${name}`); ctx.effect(() => { commands.set(name, { pluginId: manifest.id, registration: registration as DurableCommandRegistration, durable: true }); return () => { commands.delete(name); }; }); },
          effect(setup) {ensureLive();const dispose=setup();if(typeof dispose!=='function')throw new AorkError('EFFECT_INVALID','Effects must return a cleanup function');ctx.effect(()=>ownedCleanup(dispose));},
          lifecycleGuard(authority) { ensureLive(); if (authorities.has(manifest.id)) throw new AorkError('LIFECYCLE_AUTHORITY_CONFLICT', 'Plugin already registered a lifecycle authority'); lifecycleState.set('authoritiesSeen', [...new Set([...(lifecycleState.get<string[]>('authoritiesSeen') ?? []), manifest.id])]); authorities.set(manifest.id, authority); ctx.effect(() => () => { authorities.delete(manifest.id); }); },
        };
        const dispose = await module.activate!(Object.freeze(context)); if(dispose){if(typeof dispose!=='function')throw new AorkError('EFFECT_INVALID','Activation must return a cleanup function');ctx.effect(()=>ownedCleanup(dispose));}
        for (const id of manifest.provides) if (!owned.has(id)) throw new AorkError('SERVICE_NOT_REGISTERED', `${manifest.id} did not register declared service ${id}`);
      } });
    } catch (cause) {
      revokeScopes.get(pkg.manifest.id)?.();revokeScopes.delete(pkg.manifest.id);
      await root.fiber.dispose();scopes.delete(pkg.manifest.id);
      if(cleanupFailures.has(pkg.manifest.id)){barrierFailed=true;lifecycleDiagnostics.push({code:'PLUGIN_CLEANUP_FAILED',message:'Failed activation could not release all owned resources; affected services remain closed.',pluginId:pkg.manifest.id,location:'server.lifecycle'});}
      if(cause instanceof AorkError&&cause.code==='PLUGIN_MAINTENANCE_REQUIRED')throw cause;
      const failure = new AorkError('PLUGIN_ACTIVATION_FAILED', `${pkg.manifest.id}@${pkg.manifest.version} failed during server activation; inspect this plugin through local maintenance`, 503); Object.assign(failure, {pluginId:pkg.manifest.id,cause}); throw failure;
    }
  }
  try { for (const pkg of graph.packages) await activate(pkg,persistence.allowInitialMigrations!==false); }
  catch(error) { await stop(graph.packages.map(pkg=>pkg.manifest.id)); throw error; }
  return {
    queries, commands, resources, lifecycleDiagnostics,
    service<T>(id:string):T|undefined {const providers=services.get(id);const selected=graph.profile.services?.[id]??providers?.keys().next().value;return(selected?providers?.get(selected):undefined)as T|undefined;},
    lease(pluginId:string):Disposer { if(closed||suspended.has(pluginId))throw new AorkError('PLUGIN_CHANGING','Plugin is changing; reload before retrying',409);usage.set(pluginId,(usage.get(pluginId)??0)+1);let released=false;return()=>{if(!released){released=true;usage.set(pluginId,(usage.get(pluginId)??1)-1);if([...usage.values()].every(count=>count===0))for(const notify of drained)notify();}}; },
    async reconfigure(next:PluginGraph, commit:()=>void = ()=>{}) {
      if(changing||closed)throw new AorkError('PLUGIN_CHANGING','A plugin change is already in progress',409);
      changing=true;
      const previous=graph;
      const seeds=new Set<string>();
      for(const pkg of [...previous.packages,...next.packages]) {
        const before=previous.packages.find(item=>item.manifest.id===pkg.manifest.id);const after=next.packages.find(item=>item.manifest.id===pkg.manifest.id);
        if((before?.manifest.server||after?.manifest.server)&&(before?.hash!==after?.hash||JSON.stringify(previous.profile.plugins.find(item=>item.id===pkg.manifest.id))!==JSON.stringify(next.profile.plugins.find(item=>item.id===pkg.manifest.id))))seeds.add(pkg.manifest.id);
      }
      if(JSON.stringify(previous.profile.services)!==JSON.stringify(next.profile.services))for(const pkg of previous.packages)if(pkg.manifest.server)seeds.add(pkg.manifest.id);
      const releases: Disposer[]=[];
      const affected=[...new Set([...affectedPluginClosure(previous,[...seeds]),...affectedPluginClosure(next,[...seeds])])];
      try {
        if(affected.length&&barrierFailed)throw new AorkError('LIFECYCLE_UNKNOWN','Runtime admission barrier is unresolved; use local maintenance',409);
        for(const id of affected)suspended.add(id);
        if(affected.some(id=>(usage.get(id)??0)>0))throw new AorkError('PLUGIN_BUSY','Affected plugin has an operation in progress; wait for completion',409);
        if(affected.length) {
          if((lifecycleState.get<string[]>('authoritiesSeen')??[]).some(id=>!authorities.has(id)))throw new AorkError('LIFECYCLE_UNKNOWN','Managed runtime activity is unknown; restore its authority before changing services',409);
          for(const authority of authorities.values()) {let result:'idle'|'busy'|'unknown'='unknown';try{const gate=await authority.acquireChange(affected);if(typeof gate.release==='function'){releases.push(gate.release);result=gate.state;}}catch{}if(result!=='idle')throw new AorkError(result==='busy'?'LIFECYCLE_BUSY':'LIFECYCLE_UNKNOWN','Affected managed runtime activity must be explicitly idle before changing services',409);}
          // A request which passed an earlier await cannot start a lease after suspension.
          if(affected.some(id=>(usage.get(id)??0)>0))throw new AorkError('PLUGIN_BUSY','Affected plugin has an operation in progress',409);
          await stop(affected);
        }
        graph=next;
        try {for(const pkg of next.packages)if(affected.includes(pkg.manifest.id))await activate(pkg);commit();}
        catch(error) {
          try { await stop(affected); } catch { /* stop records and quarantines incomplete cleanup. */ }
          graph=previous;
          if(!barrierFailed) {
            let restoringId:string|undefined;
            try {
              for(const pkg of previous.packages)if(affected.includes(pkg.manifest.id)){restoringId=pkg.manifest.id;await activate(pkg);}
            } catch {
              barrierFailed=true;
              lifecycleDiagnostics.push({code:'PLUGIN_ROLLBACK_FAILED',message:'The previous plugin graph could not be fully restored; affected services remain closed. Use local maintenance.',...(restoringId?{pluginId:restoringId}:{}),location:'server.lifecycle'});
              try {await stop(affected);}catch{/* Every remaining owned scope is still attempted. */}
              throw new AorkError('PLUGIN_ROLLBACK_FAILED','The previous plugin graph could not be fully restored; affected services remain closed; use local maintenance',503);
            }
          }
          throw error;
        }
      } finally {
        let failed=false;for(const release of releases.reverse())try{await release();}catch{failed=true;}
        if(!failed&&!barrierFailed)for(const id of affected)suspended.delete(id);
        else if(failed){barrierFailed=true;lifecycleDiagnostics.push({code:'LIFECYCLE_RELEASE_FAILED',message:'Runtime admission barrier could not be released; affected services remain closed. Use local maintenance.',location:'server.lifecycle'});}
        changing=false;
      }
    },
    async close(){if(closed)return;closed=true;if([...usage.values()].some(count=>count>0))await new Promise<void>(resolve=>{drained.add(resolve);});drained.clear();await stop(graph.packages.map(pkg=>pkg.manifest.id));},
  };
}
export type ActiveGraph = Awaited<ReturnType<typeof activateGraph>>;

/** Local maintenance imports a separate declared entry, never the failing server activation module. */
export async function maintainPlugin(pkg: PluginPackage, state: ScopedState, action: string) {
  if (!pkg.manifest.maintenance) throw new AorkError('MAINTENANCE_UNAVAILABLE', 'Selected plugin has no local maintenance entry');
  const entryUrl = pathToFileURL(await packageFile(pkg.directory, pkg.manifest.maintenance));
  entryUrl.searchParams.set('aork', pkg.hash);
  const module = await import(entryUrl.href) as Partial<LocalMaintenancePlugin>;
  if (typeof module.maintain !== 'function') throw new AorkError('MAINTENANCE_ENTRY_INVALID', 'Selected plugin maintenance entry is invalid');
  return module.maintain(Object.freeze({ pluginId: pkg.manifest.id, state }), action);
}
