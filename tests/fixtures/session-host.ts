import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Bootstrap, DistributionProfile } from '@aork/sdk';

/** A real independently loaded Provider package; its executable implements version detection only. */
export async function sessionHost(replacement: boolean | 'turns' | 'recovery' | 'artifacts' = false, augment?: (options:{directory:string;distributionDir:string;profile:DistributionProfile;hostArguments:string[]})=>Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-sessions-'));
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const provider = join(distributionDir, 'plugins/session-test-agent/0.1.0'); await mkdir(provider, { recursive: true });
  const executable = join(directory, 'controlled-agent.mjs');
  await writeFile(executable, "if (process.argv[2] === '--version') console.log('1.2.3'); else process.exitCode = 2;");
  await writeFile(join(provider, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'session-test-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1'], ui: { providers: [] } }));
  await writeFile(join(provider, 'server.js'), `import { execFileSync } from 'node:child_process'; export function activate(context) {
    const dispose = context.service('aork.agent.providers@1').register({ id: 'session.test', label: 'Controlled Agent', version: '1.2.0', authentication: ['none'], parameters: [{name:'model',label:'Model',type:'string'}], launch: { executable: process.execPath, arguments: [${JSON.stringify(executable)}], protocol: 'acp-stdio' }, parseParameters(value) { if (Object.keys(value).some(key => key !== 'model')) throw new Error('invalid parameters'); return value; }, detect() { return { status: 'available', version: execFileSync(process.execPath, [${JSON.stringify(executable)}, '--version'], {encoding:'utf8',timeout:1000}).trim() }; } }, context.owner);
    context.effect(() => dispose);
  }`);
  const archivePolicy = join(distributionDir, 'plugins/session-archive-policy/0.1.0'); await mkdir(archivePolicy, { recursive: true });
  await writeFile(join(archivePolicy, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'session-archive-policy', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.sessions@1'], ui: { providers: [] } }));
  await writeFile(join(archivePolicy, 'server.js'), `export function activate(context) {
    let blocked = false; let dispose;
    const register = () => context.service('aork.sessions@1').registerArchiveParticipant({ id: 'session-archive-policy', assertCanArchive() { if (blocked) { const error = new Error('Archive policy requires execution to stop first'); Object.assign(error, { name: 'AorkError', code: 'ARCHIVE_EXECUTION_BLOCKED', status: 409 }); throw error; } } });
    context.command('test.archivePolicy', { access: 'authenticated', execute(payload) { blocked = payload.blocked === true; if (payload.enabled === false) dispose(); else if (payload.enabled === true) dispose = register(); return { blocked }; } });
    context.effect(() => { dispose = register(); return () => dispose(); });
  }`);
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'session-test-agent', version: '0.1.0', enabled: true });
  profile.plugins.push({ id: 'session-archive-policy', version: '0.1.0', enabled: true });
  if (replacement) {
    const pluginId = replacement === 'recovery' ? 'independent-recovery-view' : replacement === 'turns' ? 'independent-turn-view' : replacement === 'artifacts' ? 'independent-artifacts-view' : 'independent-session-view';
    profile.plugins.push({ id: pluginId, version: '0.1.0', enabled: true });
    if (replacement === 'artifacts') for (const name of ['registration', 'list', 'versions', 'preview']) profile.ui.providers[`aork.artifacts.${name}@1`] = `${pluginId}:${name}`;
    else for (const name of replacement === 'recovery' ? ['recovery','native-history'] : replacement === 'turns' ? ['composer', 'messages', 'tools'] : ['navigation', 'create', 'detail']) profile.ui.providers[`aork.sessions.${name}@1`] = `${pluginId}:${name}`;
  }
  const hostArguments:string[]=[];await augment?.({directory,distributionDir,profile,hostArguments});
  const options = { dataDir: join(directory, 'data'), distributionDir, port: 0, insecureLoopback: true };
  const profileFile = join(directory, 'profile.json'); await writeFile(profileFile, JSON.stringify(profile));
  if (replacement) {
    const archive = join(directory, `${replacement === 'recovery' ? 'independent-recovery-view' : replacement === 'turns' ? 'independent-turn-view' : replacement === 'artifacts' ? 'independent-artifacts-view' : 'independent-session-view'}.aork-plugin`);
    await promisify(execFile)(process.execPath, ['scripts/plugin-build.mjs', '--dir', replacement === 'recovery' ? 'tests/fixtures/recovery-view' : replacement === 'turns' ? 'tests/fixtures/turn-view' : replacement === 'artifacts' ? 'tests/fixtures/artifacts-view' : 'tests/fixtures/session-view', '--out', archive]);
    await promisify(execFile)(process.execPath, ['dist/server/main.mjs', 'plugin', 'install', archive, '--data-dir', options.dataDir, '--distribution-dir', distributionDir, '--profile', profileFile]);
  } else await promisify(execFile)(process.execPath, ['dist/server/main.mjs', 'profile', 'apply', profileFile, '--data-dir', options.dataDir, '--distribution-dir', distributionDir]);
  async function launch(port = 0) {
    const child = spawn(process.execPath, [...hostArguments,'dist/server/main.mjs', '--data-dir', options.dataDir, '--distribution-dir', distributionDir, '--port', String(port), '--insecure-loopback']);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const info = await new Promise<{ url: string; accessUrl: string }>((resolve, reject) => { let output = ''; let errors = ''; child.stdout.on('data', chunk => { output += String(chunk); const line = output.split('\n').find(line => line.includes('host.listening')); if (line) resolve(JSON.parse(line)); }); child.stderr.on('data', chunk => { errors += String(chunk); }); child.once('error', reject); child.once('exit', () => reject(new Error(`Host exited before startup: ${errors}`))); });
    return { ...info, async crash(){child.kill('SIGKILL');await exited;}, async close() { child.kill('SIGTERM'); await exited; } };
  }
  let host = await launch();
  const exchange = await fetch(host.accessUrl!, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
  return {
    directory, options, get host() { return host; }, cookie, get bootstrap() { return bootstrap; },
    query(name = 'sessions.overview') { return fetch(`${host.url}/api/queries/${name}`, { headers: { Cookie: cookie } }); },
    command(name: string, payload: unknown, commandId: string = crypto.randomUUID()) { return fetch(`${host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url, Cookie: cookie, 'X-Aork-CSRF': bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) }); },
    async offlineRestore(restore:(dataDir:string)=>Promise<void>){const port=Number(new URL(host.url).port);await host.close();try{await restore(options.dataDir);}finally{host=await launch(port);bootstrap=await(await fetch(`${host.url}/api/bootstrap`,{headers:{Cookie:cookie}})).json() as Bootstrap;}},
    async refreshBootstrap(){bootstrap=await(await fetch(`${host.url}/api/bootstrap`,{headers:{Cookie:cookie}})).json() as Bootstrap;},
    async crashAndRestart(withoutRuntime=false,beforeLaunch?:()=>Promise<void>){
      const port=Number(new URL(host.url).port);await host.crash();
      if(withoutRuntime){for(const plugin of profile.plugins)if(plugin.id==='runtime-acp')plugin.enabled=false;await writeFile(profileFile,JSON.stringify(profile));await promisify(execFile)(process.execPath,['dist/server/main.mjs','profile','apply',profileFile,'--data-dir',options.dataDir,'--distribution-dir',distributionDir]);}
      await beforeLaunch?.();host=await launch(port);bootstrap=await(await fetch(`${host.url}/api/bootstrap`,{headers:{Cookie:cookie}})).json() as Bootstrap;
    },
    async restart() { const port = Number(new URL(host.url).port); await host.close(); host = await launch(port); bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap; },
    async close() { await host.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
export async function sessionEnvironment(f: Awaited<ReturnType<typeof sessionHost>>) {
  // Every environment gets its own directory: concurrent Runs claim their Workspace directory, so two environments never share one.
  const workspaceDirectory = join(f.directory, `workspace-${crypto.randomUUID()}`);
  await mkdir(workspaceDirectory, { recursive: true });
  const workspaceResponse = await f.command('workspace.create', { workspace: { name: 'Notes', management: 'external', directory: workspaceDirectory, access: 'read-write' } });
  if (workspaceResponse.status !== 200) throw new Error(await workspaceResponse.text());
  const workspace = (await workspaceResponse.json()).result;
  const profileResponse = await f.command('agents.createProfile', { name: 'Research Agent', providerId: 'session.test', parameters: { model: 'controlled-model' }, versionRequirement: '^1.0.0', authentication: 'none' });
  if (profileResponse.status !== 200) throw new Error(await profileResponse.text());
  const profile = (await profileResponse.json()).result;
  return { workspace, profile, input: { name: 'Research conversation', workspaceId: workspace.id, profileId: profile.id } };
}
