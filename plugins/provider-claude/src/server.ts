import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import semver from 'semver';
import type { ServerPluginContext } from '@aork/sdk/server';
import { AGENT_PROVIDER_REGISTRY } from '@aork/contracts/agent';
import type { AgentProviderRegistry } from '@aork/contracts/agent';

const detectionTimeoutMilliseconds = 1500;
const loginObservationTimeoutMilliseconds = 2000;
const baseEnvironment = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' });

interface ProbeResult { ok: boolean; stdout: string; missing: boolean }

/** Bounded subprocess probe. Only the mapped outcome leaves this Plugin; raw
 * stderr, spawn errors and account data never reach diagnostics or events. */
function probe(executable: string, arguments_: readonly string[], environment: Readonly<Record<string, string>>, timeout: number, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: ProbeResult) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = execFile(executable, [...arguments_], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024, env: { ...environment }, signal }, (error, stdout) => {
        const missing = Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
        settle({ ok: !error, stdout: typeof stdout === 'string' ? stdout.slice(0, 4096) : '', missing });
      });
      child.on('error', () => settle({ ok: false, stdout: '', missing: false }));
    } catch { settle({ ok: false, stdout: '', missing: false }); }
  });
}

export function activate(context: ServerPluginContext) {
  const nodeExecutable = context.config.nodeExecutable;
  const adapterEntry = context.config.adapterEntry;
  // Without trusted server toolchain configuration the Provider stays dormant;
  // it never falls back to a PATH-discovered CLI or a global login.
  if (typeof nodeExecutable !== 'string' || typeof adapterEntry !== 'string' || !isAbsolute(nodeExecutable) || !isAbsolute(adapterEntry) || nodeExecutable.includes('\0') || adapterEntry.includes('\0')) return;
  const toolchainPresent = async () => { try { return (await stat(nodeExecutable)).isFile() && (await stat(adapterEntry)).isFile(); } catch { return false; } };
  const registry = context.service<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY);
  const dispose = registry.register({
    id: 'claude',
    label: 'Claude',
    version: '0.1.0',
    authentication: ['api-key', 'native-oauth'],
    parameters: [],
    parseParameters(value) { if (Object.keys(value).length !== 0) throw new Error('Claude Profiles take no launch parameters'); return {}; },
    launch: { executable: nodeExecutable, arguments: [adapterEntry], protocol: 'acp-stdio' },
    // Names and nonsecret fixed values only; the credential itself is resolved by
    // the Profiles owner at grant consumption and never appears here.
    launchEnvironment: {
      'api-key': { fixed: { CLAUDE_AGENT_ACP_PROTOCOL: 'v1', NO_BROWSER: '1' }, stateDirectoryNames: ['CLAUDE_CONFIG_DIR'], homeChildDirectory: 'home', credentialName: 'ANTHROPIC_API_KEY' },
      'native-oauth': { fixed: { CLAUDE_AGENT_ACP_PROTOCOL: 'v1', NO_BROWSER: '1' }, stateDirectoryNames: ['CLAUDE_CONFIG_DIR'], homeChildDirectory: 'home' },
    },
    observeNativeLogin(input) {
      return probe(nodeExecutable, [adapterEntry, '--cli', 'auth', 'status'], { ...baseEnvironment, CLAUDE_CONFIG_DIR: input.stateDirectory, HOME: input.stateDirectory, NO_BROWSER: '1' }, loginObservationTimeoutMilliseconds).then(result => {
        if (!result.ok && result.missing) return 'unknown' as const;
        try { const status = JSON.parse(result.stdout) as { loggedIn?: unknown }; return status.loggedIn === true ? 'observed' as const : status.loggedIn === false ? 'absent' as const : 'unknown' as const; }
        catch { return 'unknown' as const; }
      }).catch(() => 'unknown' as const);
    },
    async detect(options) {
      if (!(await toolchainPresent())) return { status: 'unavailable', reason: 'binary-missing' } as const;
      const result = await probe(nodeExecutable, [adapterEntry, '--version'], baseEnvironment, detectionTimeoutMilliseconds, options?.signal);
      if (result.missing) return { status: 'unavailable', reason: 'binary-missing' } as const;
      const version = semver.valid(result.stdout.trim());
      if (!result.ok || !version) return { status: 'unavailable', reason: 'provider-failed' } as const;
      return { status: 'available', version } as const;
    },
  });
  context.effect(() => dispose);
}
