import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AorkError } from '@aork/sdk';
import type { Diagnostic, DistributionProfile, PluginManifest } from '@aork/sdk';
export const PREFLIGHT_REPORT = 'plugin-preflight.json';
export function publicProfile(profile: DistributionProfile): DistributionProfile {
  return { ...profile, plugins: profile.plugins.map(({ config: _private, ...selection }) => selection) };
}
export function publicManifest(manifest: PluginManifest): PluginManifest { return { ...manifest, configSchema: undefined }; }
/** Only our bounded static validation errors cross the diagnostic boundary; no error cause or input data. */
export function diagnostic(error: unknown, identity?: { id: string; version: string }): Diagnostic {
  const code = error instanceof AorkError ? error.code : 'PLUGIN_METADATA_INVALID';
  const message = error instanceof AorkError ? error.message : 'Invalid manifest/profile metadata or canonical relative package path';
  const pluginId = identity?.id ?? message.match(/\b([a-z][a-z0-9.-]*)@\d+\.\d+\.\d+/)?.[1];
  const version = identity?.version ?? message.match(/\b[a-z][a-z0-9.-]*@(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/)?.[1];
  return { code, message, ...(pluginId ? { pluginId } : {}), ...(version ? { version } : {}), remedy: 'Correct the named package contract, profile selection, configuration or explicit grants; repeat preflight before starting the Host.' };
}
export async function recordRejection(dataDir: string, error: unknown, identity?: { id: string; version: string }) {
  const report = diagnostic(error, identity); const temporary = join(dataDir, `${PREFLIGHT_REPORT}.${randomUUID()}.new`);
  await writeFile(temporary, JSON.stringify(report), { mode: 0o600, flag: 'wx' }); await rename(temporary, join(dataDir, PREFLIGHT_REPORT)); return report;
}
export async function loadRejection(dataDir: string): Promise<Diagnostic | undefined> {
  try { return JSON.parse(await readFile(join(dataDir, PREFLIGHT_REPORT), 'utf8')) as Diagnostic; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw new AorkError('DIAGNOSTIC_REPORT_INVALID', 'Local preflight report cannot be read; remove or repair plugin-preflight.json through local maintenance'); }
}
