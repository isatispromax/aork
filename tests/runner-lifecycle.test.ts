import { afterEach, expect, test } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Host = Awaited<ReturnType<typeof sessionHost>>;

async function eventually<T>(inspect: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  let value: T;
  do {
    value = await inspect();
    if (accepted(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Expected public state was not reached: ${JSON.stringify(value)}`);
}

async function execution(f: Host, state: string) {
  return eventually(async () => (await (await f.query()).json()).sessions[0]?.execution, value => value?.state === state);
}

async function marker(path: string) {
  return eventually(async () => { try { return await readFile(path, 'utf8'); } catch { return null; } }, value => value !== null);
}

function groupExists(group: number) {
  try { process.kill(-group, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function writeWorkspace(f: Host, workspaceId: string) {
  return fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${workspaceId}&path=after-stop.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash },
    body: 'writer entered',
  });
}

const survivingChild = `
import { writeFileSync } from 'node:fs';
writeFileSync('surviving-child-ready', String(process.pid));
process.on('SIGTERM', () => writeFileSync('surviving-child-term', 'received'));
setInterval(() => {}, 100);
setTimeout(() => process.exit(0), 12000);
`;
const leaderAgent = `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0); }
setInterval(() => { if (existsSync('exit-agent-leader')) process.exit(0); }, 20);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); let result;
  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'leader-with-child', version: '1.2.3' }, authMethods: [] };
  else if (request.method === 'session/new') {
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(survivingChild)}], { stdio: 'ignore' });
    result = { sessionId: 'native-with-child' };
  } else continue;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;

test('a Run keeps its Workspace Claim until a child surviving its Agent leader has left the managed group', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close());
  await writeFile(join(f.directory, 'controlled-agent.mjs'), leaderAgent);
  const env = await sessionEnvironment(f);
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  expect((await f.command('sessions.startRun', { sessionId: session.id })).status).toBe(200);
  const ready = await execution(f, 'ready');
  const group = ready.processIdentity.group as number;
  const childPid = Number(await marker(join(env.workspace.directory, 'surviving-child-ready')));
  expect(childPid).toBeGreaterThan(0);
  expect(childPid).not.toBe(ready.processIdentity.pid);
  expect(groupExists(group)).toBe(true);

  // Only the external Agent fixture is controlled here. The real Runtime must
  // observe its leader exit and ask the real Runner to stop the remaining group.
  await writeFile(join(env.workspace.directory, 'exit-agent-leader'), 'exit');
  expect(await marker(join(env.workspace.directory, 'surviving-child-term'))).toBe('received');
  expect(() => process.kill(childPid, 0)).not.toThrow();
  expect((await writeWorkspace(f, env.workspace.id)).status).toBe(409);

  // The child ignores TERM. Group disappearance therefore exercises the real
  // escalation path; a stopped fact alone would not make this assertion pass.
  await execution(f, 'stopped');
  expect(groupExists(group)).toBe(false);
  expect((await writeWorkspace(f, env.workspace.id)).status).toBe(200);
});

interface ProbeState {
  childReady: boolean;
  leaderExited: boolean;
  cancellations: number;
  stopping: boolean;
  stopCallers: number;
  result: { confirmed: boolean } | null;
  identity: { pid: number; group: number } | null;
}

async function runnerProbeHost() {
  const f = await sessionHost(false, async ({ directory, distributionDir, profile }) => {
    const plugin = join(distributionDir, 'plugins/runner-boundary-probe/0.1.0');
    await mkdir(plugin, { recursive: true });
    const executable = join(directory, 'runner-boundary-agent.mjs');
    await writeFile(executable, "process.stdout.write('ready\\n'); process.stdin.resume(); setInterval(() => {}, 100); setTimeout(() => process.exit(0), 12000);");
    await writeFile(join(plugin, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'runner-boundary-probe', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.runner.local@1'], ui: { providers: [] } }));
    await writeFile(join(plugin, 'server.js'), `export function activate(c) {
      const runner = c.service('aork.runner.local@1');
      let handle; let acknowledge;
      const state = { childReady: false, leaderExited: false, cancellations: 0, stopping: false, stopCallers: 0, result: null };
      c.command('runnerProbe.start', { access: 'authenticated', execute(payload) {
        if (handle || !['acknowledge', 'reject', 'hang'].includes(payload.mode)) throw new Error('Invalid probe start');
        handle = runner.spawn(c.owner, { executable: ${JSON.stringify(process.execPath)}, arguments: [${JSON.stringify(executable)}], cwd: ${JSON.stringify(directory)}, environment: {} });
        handle.stdout.on('data', chunk => { if (String(chunk).includes('ready')) state.childReady = true; });
        void handle.exited.then(() => { state.leaderExited = true; });
        handle.registerJob(() => {
          state.cancellations++;
          if (payload.mode === 'reject') throw new Error('Controlled cancellation rejection');
          if (payload.mode === 'hang') return new Promise(() => {});
          return new Promise(resolve => { acknowledge = resolve; });
        });
        return { identity: handle.identity };
      } });
      c.command('runnerProbe.beginStop', { access: 'authenticated', execute() {
        state.stopping = true;
        void handle.stop().then(result => { state.result = result; });
        return { accepted: true };
      } });
      c.command('runnerProbe.addJob', { access: 'authenticated', execute() { handle.registerJob(() => {}); return { registered: true }; } });
      c.command('runnerProbe.acknowledge', { access: 'authenticated', execute() { acknowledge(); return { acknowledged: true }; } });
      c.command('runnerProbe.inspectStopped', { access: 'authenticated', execute() { return handle.inspectStopped(); } });
      c.command('runnerProbe.stop', { access: 'authenticated', execute() { state.stopCallers++; return handle.stop(); } });
      c.query('runnerProbe.state', { access: 'authenticated', execute() { return { ...state, identity: handle?.identity ?? null }; } });
      c.effect(() => async () => { await handle?.stop(); });
    }`);
    profile.plugins.push({ id: 'runner-boundary-probe', version: '0.1.0', enabled: true });
  });
  cleanup.push(() => f.close());
  return f;
}

async function probe(f: Host): Promise<ProbeState> { return (await f.query('runnerProbe.state')).json(); }
async function startProbe(f: Host, mode: string) {
  expect((await f.command('runnerProbe.start', { mode })).status).toBe(200);
  const state = await eventually(() => probe(f), value => value.childReady);
  expect(groupExists(state.identity!.group)).toBe(true);
  expect((await f.command('runnerProbe.beginStop', {})).status).toBe(200);
  return state.identity!;
}

test('Runner awaits registered work acknowledgment, rejects late work and returns one confirmed stop for concurrent callers', async () => {
  const f = await runnerProbeHost();
  const identity = await startProbe(f, 'acknowledge');
  await eventually(() => probe(f), value => value.cancellations === 1 && value.leaderExited);
  await eventually(async () => groupExists(identity.group), exists => !exists);
  expect((await probe(f)).result).toBeNull();
  const late = await f.command('runnerProbe.addJob', {});
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ error: { code: 'RUNNER_STOPPING' } });
  const pendingStops = [f.command('runnerProbe.stop', {}), f.command('runnerProbe.stop', {})];
  await eventually(() => probe(f), value => value.stopCallers === 2);
  expect((await probe(f)).result).toBeNull();
  expect((await f.command('runnerProbe.acknowledge', {})).status).toBe(200);
  const results = await Promise.all(pendingStops);
  expect(await Promise.all(results.map(response => response.json()))).toEqual([{ confirmed: true }, { confirmed: true }]);
  expect((await probe(f)).cancellations).toBe(1);
  expect(groupExists(identity.group)).toBe(false);
});

test.each(['reject', 'hang'])('Runner does not confirm stopped work when its registered cancellation will %s', async mode => {
  const f = await runnerProbeHost();
  const identity = await startProbe(f, mode);
  const stopped = await eventually(() => probe(f), value => value.result !== null);
  expect(stopped.result).toEqual({ confirmed: false });
  expect(stopped.cancellations).toBe(1);
  expect(stopped.leaderExited).toBe(true);
  expect(groupExists(identity.group)).toBe(false);
  expect(await (await f.command('runnerProbe.stop', {})).json()).toEqual({ confirmed: false });
  expect((await f.command('plugins.configure', { pluginId: 'runner-local', config: {} })).status).toBe(409);
});


test('a cached stop timeout stays uncertain until a fresh owned observation sees the actual registered job finish', async()=>{
  const f=await runnerProbeHost();const identity=await startProbe(f,'acknowledge');
  const timedOut=await eventually(()=>probe(f),value=>value.result!==null);expect(timedOut.result).toEqual({confirmed:false});expect(groupExists(identity.group)).toBe(false);
  expect(await(await f.command('runnerProbe.inspectStopped',{})).json()).toEqual({confirmed:false});
  expect((await f.command('runnerProbe.acknowledge',{})).status).toBe(200);
  await eventually(async()=>await(await f.command('runnerProbe.inspectStopped',{})).json(),value=>value.confirmed===true);
  expect(await(await f.command('runnerProbe.stop',{})).json()).toEqual({confirmed:false});
});
