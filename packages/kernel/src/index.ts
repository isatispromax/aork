import { compileConfig } from './config.js';
import { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, access } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { AorkError, SDK_VERSION, distributionProfileSchema } from '@aork/sdk';
import type { Diagnostic, DistributionProfile, PluginManifest } from '@aork/sdk';
import { PLUGIN_DIAGNOSTICS_SERVICE, HOST_CAPABILITIES } from '@aork/sdk/server';
import { UI_CONTRACTS, UI_EXTENSION_TARGETS } from '@aork/sdk/client';
import type { CommandRegistration, QueryRegistration, ScopedState, ServerPlugin, ServerPluginContext, LocalMaintenancePlugin, DurableCommandRegistration, RepositoryDeclaration, OwnerRepository } from '@aork/sdk/server';
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
    if (manifest.configSchema !== undefined) {
      const validate = compileConfig(manifest)!;
      if (!validate(selection.config ?? {})) throw new AorkError('CONFIG_INVALID', `${manifest.id}@${manifest.version}: configuration fails schema at ${validate.errors?.map(error => error.schemaPath).join(', ')}. Correct profile plugin config according to configSchema before enabling.`);
    }
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
    if (service === PLUGIN_DIAGNOSTICS_SERVICE) throw new AorkError('SERVICE_RESERVED', `${pkg.manifest.id}@${pkg.manifest.version}: ${service} is Host-owned. Require it with the declared capability instead of providing it.`);
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
      if (!owners.length && service === PLUGIN_DIAGNOSTICS_SERVICE) {
        if (!pkg.manifest.capabilities.includes('diagnostics.read')) throw new AorkError('CAPABILITY_NOT_GRANTED', `${pkg.manifest.id}@${pkg.manifest.version}: diagnostics service requires declared and granted diagnostics.read.`);
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

/** Cordis is private: only scoped SDK closures are handed to a Plugin. */
export async function activateGraph(graph: PluginGraph, state: (pluginId: string) => ScopedState, persistence: { bind(owner: string, declaration?: RepositoryDeclaration): OwnerRepository; managedWorkspaces: string; pluginStateRoot: string }, builtins: ReadonlyMap<string, unknown> = new Map()) {
  const root = new Context();
  const queries = new Map<string, RegisteredQuery>();
  const commands = new Map<string, RegisteredCommand>();
  const services = new Map<string, Map<string, unknown>>();
  try {
    for (const pkg of graph.packages) {
      if (!pkg.manifest.server) continue;
      try {
      const entryUrl = pathToFileURL(await packageFile(pkg.directory, pkg.manifest.server));
      entryUrl.searchParams.set('aork', pkg.hash);
      const module = await import(entryUrl.href) as Partial<ServerPlugin>;
      if (typeof module.activate !== 'function') throw new AorkError('SERVER_ENTRY_INVALID', `${pkg.manifest.id} does not export activate(context)`);
      const repository = persistence.bind(pkg.manifest.id, module.persistence);
      const manifest = pkg.manifest;
      const scopedState = state(manifest.id);
      await root.plugin({
        name: manifest.id,
        inject: [],
        async apply(ctx) {
          const owned = new Set<string>();
          const context: ServerPluginContext = {
            pluginId: manifest.id, state: scopedState, repository, directories: Object.freeze({ managedWorkspaces: persistence.managedWorkspaces, pluginState: join(persistence.pluginStateRoot, manifest.id) }), config: Object.freeze(graph.profile.plugins.find(plugin => plugin.id === manifest.id)?.config ?? {}),
            provide(id, value) {
              if (!manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare ${id}`);
              if (owned.has(id)) throw new AorkError('SERVICE_CONFLICT', `${manifest.id} registered ${id} twice`);
              owned.add(id); const providers = services.get(id) ?? new Map<string, unknown>(); providers.set(manifest.id, value); services.set(id, providers); ctx.effect(() => () => { providers.delete(manifest.id); });
            },
            service<T>(id: string): T {
              if (!manifest.requires.includes(id) && !manifest.optionalRequires.includes(id) && !manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare dependency ${id}`);
              if (builtins.has(id)) {
                if (id !== PLUGIN_DIAGNOSTICS_SERVICE || !manifest.capabilities.includes('diagnostics.read') || !graph.profile.plugins.find(plugin => plugin.id === manifest.id)?.grants?.includes('diagnostics.read')) throw new AorkError('CAPABILITY_NOT_GRANTED', `${manifest.id} has no explicit grant for the Host service`);
                return builtins.get(id) as T;
              }
              const providers = services.get(id);
              const selected = graph.profile.services?.[id] ?? (manifest.provides.includes(id) ? manifest.id : providers?.keys().next().value);
              const value = selected ? providers?.get(selected) : undefined;
              if (value === undefined) throw new AorkError('SERVICE_UNAVAILABLE', `${id} is unavailable`);
              return value as T;
            },
            query(name, registration) {
              if (queries.has(name)) throw new AorkError('QUERY_CONFLICT', `Duplicate query ${name}`);
              ctx.effect(() => { queries.set(name, { pluginId: manifest.id, registration }); return () => { queries.delete(name); }; });
            },
            command(name, registration) {
              if (commands.has(name)) throw new AorkError('COMMAND_CONFLICT', `Duplicate command ${name}`);
              ctx.effect(() => { commands.set(name, { pluginId: manifest.id, registration }); return () => { commands.delete(name); }; });
            },
            durableCommand(name, registration) {
              if (commands.has(name)) throw new AorkError('COMMAND_CONFLICT', `Duplicate command ${name}`);
              ctx.effect(() => { commands.set(name, { pluginId: manifest.id, registration: registration as DurableCommandRegistration, durable: true }); return () => { commands.delete(name); }; });
            },
            effect(setup) { ctx.effect(setup); },
          };
          const dispose = await module.activate!(Object.freeze(context));
          if (dispose) ctx.effect(() => dispose);
          for (const id of manifest.provides) if (!owned.has(id)) throw new AorkError('SERVICE_NOT_REGISTERED', `${manifest.id} did not register declared service ${id}`);
        },
      });
      } catch (cause) {
        const failure = new AorkError('PLUGIN_ACTIVATION_FAILED', `${pkg.manifest.id}@${pkg.manifest.version} failed during server activation; inspect this plugin through local maintenance`, 503);
        Object.assign(failure, { pluginId: pkg.manifest.id, cause });
        throw failure;
      }
    }
    return { queries, commands, service<T>(id: string): T | undefined { const providers = services.get(id); const selected = graph.profile.services?.[id] ?? providers?.keys().next().value; return (selected ? providers?.get(selected) : undefined) as T | undefined; }, async close() { await root.fiber.dispose(); } };
  } catch (error) { await root.fiber.dispose(); throw error; }
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
