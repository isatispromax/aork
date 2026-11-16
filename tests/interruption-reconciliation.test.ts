import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function entry(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string, state: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const item = (await (await f.query()).json()).sessions.find((item: any) => item.session.id === sessionId); if (item?.execution.state === state) return item; await wait(); }
  throw new Error(`Run did not reach ${state}`);
}
async function marker(path: string) { const end = Date.now() + 5000; while (Date.now() < end) { try { return await readFile(path, 'utf8'); } catch { await wait(); } } throw new Error('External fixture did not reach fault boundary'); }
/** Actual ACP process stays alive after losing its Host until its own file gate opens. */
const agent = `import {createInterface} from 'node:readline';import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
setInterval(()=>{if(existsSync('agent-self-exit'))process.exit(0);},20);
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');process.stdout.on('error',()=>{});
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('reconciliation-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-reconciliation'}});
if(r.method==='session/prompt')writeFileSync('prompt-attempted','yes');});`;

test('crash retains attempted input and paused queue; check-again never resends and only verified group absence releases its Workspace', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); await writeFile(join(f.directory, 'controlled-agent.mjs'), agent);
  const env = await sessionEnvironment(f); cleanup.push(async () => { await writeFile(join(env.workspace.directory, 'agent-self-exit'), 'exit'); await wait(); });
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  const run = (await (await f.command('sessions.startRun', { sessionId: session.id })).json()).result; await entry(f, session.id, 'ready');
  const first = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'Preserve original input and link https://example.org/source' })).json()).result;
  await marker(join(env.workspace.directory, 'prompt-attempted'));
  const queued = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'Do not continue automatically' })).json()).result;
  await f.crashAndRestart(); const unknown = await entry(f, session.id, 'unknown'); expect(unknown.dispatchPaused).toBe(true);
  const timeline = () => fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`, { headers: { Cookie: f.cookie } }).then(r => r.json());
  expect(await timeline()).toMatchObject({ dispatchPaused: true, turns: [{ id: first.id, state: 'delivery_unknown' }, { id: queued.id, state: 'queued' }] });
  const blockedResponse = await f.command('sessions.recheckRun', { runId: run.runId });
  expect(blockedResponse.status).toBe(200);
  expect((await blockedResponse.json()).result).toMatchObject({ status: 'blocked', reason: 'group-present', coverage: 'complete' });
  const write = () => fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=retained.txt`, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash }, body: 'write after verification' });
  expect((await write()).status).toBe(409);
  await writeFile(join(env.workspace.directory, 'agent-self-exit'), 'exit');
  const deadline = Date.now() + 5000; let receipt: any;
  while (Date.now() < deadline) { receipt = await (await f.command('sessions.recheckRun', { runId: run.runId })).json(); if (receipt.result?.status === 'verified-stopped') break; await wait(); }
  expect(receipt.result).toMatchObject({ status: 'verified-stopped', reason: 'covered-group-absent' });
  expect((await entry(f, session.id, 'stopped')).dispatchPaused).toBe(true); expect((await write()).status).toBe(200);
  const saved = await timeline(); expect(saved.messages[0].text).toBe('Preserve original input and link https://example.org/source');
  expect((await readFile(join(env.workspace.directory, 'reconciliation-wire'), 'utf8')).split('\n').filter(x => x.includes('session/prompt'))).toHaveLength(1);
  expect((await f.command('sessions.removeQueuedTurn', { turnId: queued.id })).status).toBe(200);
});
