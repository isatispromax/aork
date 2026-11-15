import { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { AorkError, SDK_VERSION, distributionProfileSchema, pluginManifestSchema } from '@aork/sdk';
import type { Diagnostic, DistributionProfile, PluginManifest } from '@aork/sdk';
import { UI_CONTRACTS } from '@aork/sdk/client';
import type { CommandRegistration, QueryRegistration, ScopedState, ServerPlugin, ServerPluginContext, LocalMaintenancePlugin, DurableCommandRegistration, RepositoryDeclaration, OwnerRepository } from '@aork/sdk/server';

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
export async function inspectGraph(profileInput: unknown, pluginsDir: string): Promise<PluginGraph> {
  const profile = distributionProfileSchema.parse(profileInput);
  const packages: PluginPackage[] = [];
  const seen = new Set<string>();
  for (const selection of profile.plugins) {
    if (seen.has(selection.id)) throw new AorkError('DUPLICATE_PLUGIN', `Duplicate profile plugin ${selection.id}`);
    seen.add(selection.id);
    if (!semver.valid(selection.version)) throw new AorkError('PLUGIN_VERSION_INVALID', `Invalid version for ${selection.id}`);
    if (!selection.enabled) continue;
    const directory = await realpath(join(pluginsDir, selection.id, selection.version));
    const rawManifest = await readFile(join(directory, 'aork.plugin.json'), 'utf8');
    const manifest = pluginManifestSchema.parse(JSON.parse(rawManifest));
    if (manifest.id !== selection.id || manifest.version !== selection.version) throw new AorkError('PLUGIN_IDENTITY_MISMATCH', `Manifest identity differs from profile selection ${selection.id}@${selection.version}`);
    if (!semver.validRange(manifest.sdkRange) || !semver.satisfies(SDK_VERSION, manifest.sdkRange)) throw new AorkError('SDK_INCOMPATIBLE', `${manifest.id} requires SDK ${manifest.sdkRange}; Host has ${SDK_VERSION}`);
    if (manifest.capabilities.length) throw new AorkError('CAPABILITY_UNAVAILABLE', `${manifest.id} requests unsupported bootstrap capabilities: ${manifest.capabilities.join(', ')}`);
    const assets = new Map<string, Uint8Array>();
    for (const entry of new Set([manifest.server, manifest.client, manifest.maintenance, ...manifest.assets].filter((entry): entry is string => Boolean(entry)))) assets.set(entry, await readFile(await packageFile(directory, entry)));
    const hash = createHash('sha256').update(rawManifest);
    for (const [name, bytes] of [...assets].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(bytes);
    packages.push({ manifest, directory, assets, hash: hash.digest('hex') });
  }
  const serviceOwners = new Map<string, string>();
  for (const pkg of packages) for (const service of pkg.manifest.provides) {
    if (serviceOwners.has(service)) throw new AorkError('SERVICE_CONFLICT', `${service} has duplicate providers`);
    serviceOwners.set(service, pkg.manifest.id);
  }
  const ordered: PluginPackage[] = [];
  const remaining = [...packages];
  while (remaining.length) {
    const index = remaining.findIndex(pkg => pkg.manifest.requires.every(service => ordered.some(candidate => candidate.manifest.provides.includes(service))));
    if (index < 0) throw new AorkError('DEPENDENCY_UNAVAILABLE', `Missing or cyclic services: ${remaining.map(pkg => `${pkg.manifest.id} requires ${pkg.manifest.requires.join(', ')}`).join('; ')}`);
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  const diagnostics: Diagnostic[] = [];
  const candidates = new Map<string, string>();
  for (const pkg of ordered) {
    for (const provider of pkg.manifest.ui.providers) {
      const id = `${pkg.manifest.id}:${provider.id}`;
      if (candidates.has(id)) throw new AorkError('UI_PROVIDER_DUPLICATE', `Duplicate UI provider ${id}`);
      if (!UI_CONTRACTS.includes(provider.contract as typeof UI_CONTRACTS[number])) throw new AorkError('UI_CONTRACT_INCOMPATIBLE', `${id} targets unsupported contract ${provider.contract}`);
      if (!pkg.manifest.client) throw new AorkError('UI_ENTRY_MISSING', `${id} has no client entry`);
      candidates.set(id, provider.contract);
    }
  }
  for (const contract of UI_CONTRACTS) {
    const selection = profile.ui.providers[contract];
    if (!selection || candidates.get(selection) !== contract) diagnostics.push({ code: 'UI_PROVIDER_UNAVAILABLE', message: `Profile must explicitly select a compatible provider for ${contract}`, location: `ui.providers.${contract}` });
  }
  for (const contract of Object.keys(profile.ui.providers)) if (!UI_CONTRACTS.includes(contract as typeof UI_CONTRACTS[number])) diagnostics.push({ code: 'UI_CONTRACT_INCOMPATIBLE', message: `Unsupported UI contract ${contract}`, location: `ui.providers.${contract}` });
  if (profile.ui.extensions.length) throw new AorkError('UI_EXTENSION_TARGET_UNAVAILABLE', 'No extension targets are published by this bootstrap profile');
  const hash = createHash('sha256').update(JSON.stringify(profile));
  for (const pkg of ordered) hash.update(pkg.hash);
  return { profile, packages: ordered, hash: hash.digest('hex'), diagnostics };
}

/** Cordis is private: only scoped SDK closures are handed to a Plugin. */
export async function activateGraph(graph: PluginGraph, state: (pluginId: string) => ScopedState, persistence: { bind(owner: string, declaration?: RepositoryDeclaration): OwnerRepository; managedWorkspaces: string }) {
  const root = new Context();
  const queries = new Map<string, RegisteredQuery>();
  const commands = new Map<string, RegisteredCommand>();
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
        inject: manifest.requires,
        async apply(ctx) {
          const owned = new Set<string>();
          const context: ServerPluginContext = {
            pluginId: manifest.id, state: scopedState, repository, directories: Object.freeze({ managedWorkspaces: persistence.managedWorkspaces }),
            provide(id, value) {
              if (!manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare ${id}`);
              if (owned.has(id)) throw new AorkError('SERVICE_CONFLICT', `${manifest.id} registered ${id} twice`);
              owned.add(id); ctx.provide(id, value);
            },
            service<T>(id: string): T {
              if (!manifest.requires.includes(id) && !manifest.provides.includes(id)) throw new AorkError('SERVICE_UNDECLARED', `${manifest.id} did not declare dependency ${id}`);
              const value = ctx.get(id);
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
    return { queries, commands, service<T>(id: string): T | undefined { return root.get(id) as T | undefined; }, async close() { await root.fiber.dispose(); } };
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
