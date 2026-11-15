import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AorkError, distributionProfileSchema } from '@aork/sdk';
import { acquireDataLock } from '@aork/storage';
import { inspectCatalog, inspectGraph, readPluginArchive, validatePackageFiles } from '@aork/kernel';

export const INITIAL_PROFILE = 'initial-profile.json';
export async function loadInitialProfile(dataDir: string) {
  try { return JSON.parse(await readFile(join(dataDir, INITIAL_PROFILE), 'utf8')); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

/** Initial installation never opens/migrates SQLite or imports a package entry. */
export async function installPlugin(options: { dataDir: string; distributionDir?: string; archive: string; profile?: unknown }) {
  const lock = await acquireDataLock(options.dataDir);
  let stage: string | undefined;
  let installed: string | undefined;
  try {
    // Any database, auth/session/history, pending journal or unknown file makes this an existing instance.
    // A stopped Host is deliberately insufficient: only never-started instances are accepted.
    for (const entry of await readdir(lock.dataDir, { withFileTypes: true })) {
      if (!['host.lock', 'plugins', INITIAL_PROFILE].includes(entry.name) || entry.isSymbolicLink() || (entry.name === 'plugins' ? !entry.isDirectory() : !entry.isFile())) throw new AorkError('FRESH_INSTANCE_REQUIRED', 'Initial installation requires a blank instance before its first Host start; existing-instance maintenance is not implemented');
    }
    const archive = await open(options.archive, 'r');
    const files = await (async () => {
      try {
        const info = await archive.stat();
        if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new AorkError('PLUGIN_ARCHIVE_INVALID', 'Archive must be a regular file no larger than 32 MiB');
        return readPluginArchive(await archive.readFile());
      } finally { await archive.close(); }
    })();
    const manifest = await validatePackageFiles(files);
    const distributionDir = resolve(options.distributionDir ?? 'dist');
    const builtin = join(distributionDir, 'plugins', manifest.id, manifest.version);
    try { await access(builtin); throw new AorkError('PLUGIN_ALREADY_INSTALLED', 'A distribution package with this identity already exists'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    const catalog = join(lock.dataDir, 'plugins');
    const target = join(catalog, manifest.id, manifest.version);
    try { await access(target); throw new AorkError('PLUGIN_ALREADY_INSTALLED', 'This package identity is already installed'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    const profile = distributionProfileSchema.parse(options.profile ?? await loadInitialProfile(lock.dataDir) ?? JSON.parse(await readFile(join(distributionDir, 'profiles/personal-server.json'), 'utf8')));
    await mkdir(catalog, { recursive: true, mode: 0o700 });
    await inspectCatalog(catalog);
    stage = join(lock.dataDir, `.install-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    for (const [path, bytes] of files) { await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), bytes, { mode: 0o600, flag: 'wx' }); }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(stage, target); stage = undefined; installed = target;
    const graph = await inspectGraph(profile, join(distributionDir, 'plugins'), catalog);
    if (graph.diagnostics.length) throw new AorkError('PLUGIN_PROFILE_INVALID', graph.diagnostics.map(diagnostic => `${diagnostic.location}: ${diagnostic.message}`).join('\n'));
    const initial = join(lock.dataDir, `${INITIAL_PROFILE}.new`);
    await writeFile(initial, JSON.stringify(graph.profile, null, 2), { mode: 0o600 });
    await rename(initial, join(lock.dataDir, INITIAL_PROFILE));
    installed = undefined;
    return { installed: { id: manifest.id, version: manifest.version }, selected: graph.profile.plugins.some(plugin => plugin.id === manifest.id && plugin.version === manifest.version && plugin.enabled), pluginGraphHash: graph.hash, profile: graph.profile };
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
      if (installed) await rm(installed, { recursive: true, force: true });
    } finally { lock.release(); }
  }
}
