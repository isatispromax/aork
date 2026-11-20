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
/** The pinned adapter prints `<package name> <version>` for --version; detection
 * accepts exactly this identity, never a bare version from any other tool. */
const adapterVersionPattern = /^@agentclientprotocol\/codex-acp (\S+)$/;

interface ProbeResult { exitCode: number | null; stdout: string; stderr: string; missing: boolean }

/** Bounded subprocess probe. Only the mapped outcome leaves this Plugin; raw
 * stderr, spawn errors and account data never reach diagnostics or events. */
function probe(executable: string, arguments_: readonly string[], environment: Readonly<Record<string, string>>, timeout: number, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: ProbeResult) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = execFile(executable, [...arguments_], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024, env: { ...environment }, signal }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        const missing = code === 'ENOENT';
        const exitCode = !error ? 0 : typeof code === 'number' ? code : null;
        settle({ exitCode, stdout: typeof stdout === 'string' ? stdout.slice(0, 4096) : '', stderr: typeof stderr === 'string' ? stderr.slice(0, 4096) : '', missing });
      });
      child.on('error', () => settle({ exitCode: null, stdout: '', stderr: '', missing: false }));
    } catch { settle({ exitCode: null, stdout: '', stderr: '', missing: false }); }
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
    id: 'codex',
    label: 'Codex',
    version: '0.1.0',
    authentication: ['api-key', 'native-oauth'],
    parameters: [],
    parseParameters(value) { if (Object.keys(value).length !== 0) throw new Error('Codex Profiles take no launch parameters'); return {}; },
    launch: { executable: nodeExecutable, arguments: [adapterEntry], protocol: 'acp-stdio' },
    // The pinned adapter is environment-driven (bundled @openai/codex app-server;
    // no fixed protocol override is needed) and reads CODEX_HOME for all native
    // state. The API-key plan injects OPENAI_API_KEY; the adapter also honors
    // CODEX_API_KEY, but Profiles keep exactly one credential injection name.
    // ChatGPT login state lives inside CODEX_HOME only. Names and nonsecret
    // fixed values only; the credential is resolved by the Profiles owner at
    // grant consumption and never appears here.
    launchEnvironment: {
      'api-key': { fixed: {}, stateDirectoryNames: ['CODEX_HOME'], homeChildDirectory: 'home', credentialName: 'OPENAI_API_KEY' },
      'native-oauth': { fixed: {}, stateDirectoryNames: ['CODEX_HOME'], homeChildDirectory: 'home' },
    },
    observeNativeLogin(input) {
      return probe(nodeExecutable, [adapterEntry, 'cli', 'login', 'status'], { ...baseEnvironment, CODEX_HOME: input.stateDirectory, HOME: input.stateDirectory }, loginObservationTimeoutMilliseconds).then(result => {
        if (result.missing) return 'unknown' as const;
        if (result.exitCode === 0) return 'observed' as const;
        if (result.exitCode === 1 && result.stderr.includes('Not logged in')) return 'absent' as const;
        return 'unknown' as const;
      }).catch(() => 'unknown' as const);
    },
    async detect(options) {
      if (!(await toolchainPresent())) return { status: 'unavailable', reason: 'binary-missing' } as const;
      const result = await probe(nodeExecutable, [adapterEntry, '--version'], baseEnvironment, detectionTimeoutMilliseconds, options?.signal);
      if (result.missing) return { status: 'unavailable', reason: 'binary-missing' } as const;
      const match = adapterVersionPattern.exec(result.stdout.trim());
      const version = match ? semver.valid(match[1]) : null;
      if (result.exitCode !== 0 || !version) return { status: 'unavailable', reason: 'provider-failed' } as const;
      return { status: 'available', version } as const;
    },
  });
  context.effect(() => dispose);
}
