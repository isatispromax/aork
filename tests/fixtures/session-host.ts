import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHost, maintainProfile } from '../../apps/server/src/host.js';
import type { Bootstrap } from '@aork/sdk';

/** A real independently loaded Provider package; its executable implements version detection only. */
export async function sessionHost() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-sessions-'));
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const provider = join(distributionDir, 'plugins/session-test-agent/0.1.0'); await mkdir(provider, { recursive: true });
  const executable = join(directory, 'controlled-agent.mjs');
  await writeFile(executable, "if (process.argv[2] === '--version') console.log('1.2.3'); else process.exitCode = 2;");
  await writeFile(join(provider, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'session-test-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1'], ui: { providers: [] } }));
  await writeFile(join(provider, 'server.js'), `import { execFileSync } from 'node:child_process'; export function activate(context) {
    const dispose = context.service('aork.agent.providers@1').register({ id: 'session.test', label: 'Controlled Agent', version: '1.2.0', authentication: ['none'], parameters: [{name:'model',label:'Model',type:'string'}], launch: { executable: process.execPath, arguments: [${JSON.stringify(executable)}], protocol: 'acp-stdio' }, parseParameters(value) { if (Object.keys(value).some(key => key !== 'model')) throw new Error('invalid parameters'); return value; }, detect() { return { status: 'available', version: execFileSync(process.execPath, [${JSON.stringify(executable)}, '--version'], {encoding:'utf8',timeout:1000}).trim() }; } });
    context.effect(() => dispose);
  }`);
  const archivePolicy = join(distributionDir, 'plugins/session-archive-policy/0.1.0'); await mkdir(archivePolicy, { recursive: true });
  await writeFile(join(archivePolicy, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'session-archive-policy', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.sessions@1'], ui: { providers: [] } }));
  await writeFile(join(archivePolicy, 'server.js'), `export function activate(context) {
    let blocked = false;
    context.command('test.archivePolicy', { access: 'authenticated', execute(payload) { blocked = payload.blocked === true; return { blocked }; } });
    context.effect(() => context.service('aork.sessions@1').registerArchiveParticipant({ assertCanArchive() { if (blocked) { const error = new Error('Archive policy requires execution to stop first'); Object.assign(error, { name: 'AorkError', code: 'ARCHIVE_EXECUTION_BLOCKED', status: 409 }); throw error; } } }));
  }`);
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'session-test-agent', version: '0.1.0', enabled: true });
  profile.plugins.push({ id: 'session-archive-policy', version: '0.1.0', enabled: true });
  const options = { dataDir: join(directory, 'data'), distributionDir, port: 0, insecureLoopback: true };
  await maintainProfile({ ...options, profile });
  let host = await startHost(options);
  const exchange = await fetch(host.accessUrl!, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
  return {
    directory, options, get host() { return host; }, cookie, get bootstrap() { return bootstrap; },
    query(name = 'sessions.overview') { return fetch(`${host.url}/api/queries/${name}`, { headers: { Cookie: cookie } }); },
    command(name: string, payload: unknown, commandId: string = crypto.randomUUID()) { return fetch(`${host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url, Cookie: cookie, 'X-Aork-CSRF': bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) }); },
    async restart() { const port = Number(new URL(host.url).port); await host.close(); host = await startHost({ ...options, port }); bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap; },
    async close() { await host.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
export async function sessionEnvironment(f: Awaited<ReturnType<typeof sessionHost>>) {
  const projectResponse = await f.command('workspace.createProject', { name: 'Research', workspace: { name: 'Notes', management: 'managed' } });
  if (projectResponse.status !== 200) throw new Error(await projectResponse.text());
  const { project, workspace } = (await projectResponse.json()).result;
  const profileResponse = await f.command('agents.createProfile', { name: 'Research Agent', providerId: 'session.test', parameters: { model: 'controlled-model' }, versionRequirement: '^1.0.0', authentication: 'none' });
  if (profileResponse.status !== 200) throw new Error(await profileResponse.text());
  const profile = (await profileResponse.json()).result;
  return { project, workspace, profile, input: { name: 'Research conversation', projectId: project.id, workspaceId: workspace.id, profileId: profile.id } };
}
