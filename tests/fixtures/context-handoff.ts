import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from './session-host.js';

/** Two real providers: A (session.test) keeps native load; B (session.alternate) never loads native sessions. */
export async function handoffHost() {
  const f = await sessionHost(false, async ({ directory, distributionDir, profile }) => {
    const alternate = join(distributionDir, 'plugins/session-alt-agent/0.1.0'); await (await import('node:fs/promises')).mkdir(alternate, { recursive: true });
    const executable = join(directory, 'alt-agent.mjs');
    await writeFile(join(alternate, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'session-alt-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1'], ui: { providers: [] } }));
    await writeFile(join(alternate, 'server.js'), `import { execFileSync } from 'node:child_process'; export function activate(context) {
      const dispose = context.service('aork.agent.providers@1').register({ id: 'session.alternate', label: 'Alternate Agent', version: '1.2.0', authentication: ['none'], parameters: [{name:'model',label:'Model',type:'string'}], launch: { executable: process.execPath, arguments: [${JSON.stringify(executable)}], protocol: 'acp-stdio' }, parseParameters(value) { return value; }, detect() { return { status: 'available', version: execFileSync(process.execPath, [${JSON.stringify(executable)}, '--version'], {encoding:'utf8',timeout:1000}).trim() }; } }, context.owner);
      context.effect(() => dispose);
    }`);
    profile.plugins.push({ id: 'session-alt-agent', version: '0.1.0', enabled: true });
  });
  await writeFile(join(f.directory, 'controlled-agent.mjs'), agentScript('native-a', join(f.directory, 'agent-a-wire'), true));
  await writeFile(join(f.directory, 'alt-agent.mjs'), agentScript('native-b', join(f.directory, 'agent-b-wire'), false));
  const env = await sessionEnvironment(f);
  const altProfile = (await (await f.command('agents.createProfile', { name: 'Alternate Agent Profile', providerId: 'session.alternate', parameters: { model: 'alt-model' }, versionRequirement: '^1.0.0', authentication: 'none' })).json()).result;
  return { f, env, altProfile };
}

/** A real ACP agent used by both providers: fresh native session per Run, prompt blocks logged to a wire file. */
function agentScript(nativePrefix: string, wirePath: string, loadSession: boolean) {
  return `import {appendFileSync} from 'node:fs';import{createInterface} from 'node:readline';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);appendFileSync(${JSON.stringify(wirePath)},JSON.stringify(request)+'\\n');if(!request.method)continue;let result={};
if(request.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:${JSON.stringify(loadSession)},promptCapabilities:{image:true,audio:${JSON.stringify(loadSession)},embeddedContext:true}},agentInfo:{name:'${nativePrefix}-agent',version:'1.2.3'}};
else if(request.method==='session/new')result={sessionId:'${nativePrefix}-'+process.pid};
else if(request.method==='session/prompt'){send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'${nativePrefix} acknowledged'}}}});result={stopReason:'end_turn'};}
else if(request.method==='session/load'){{const error={code:-32000,message:'alternate agents never load native sessions'};send({id:request.id,error});continue;}}
else continue;
send({id:request.id,result});}
`;
}

export async function createSessionWithTurn(f: Awaited<ReturnType<typeof sessionHost>>, env: Awaited<ReturnType<typeof sessionEnvironment>>, text: string) {
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  assert.equal((await f.command('sessions.startRun', { sessionId: session.id })).status, 200);
  await waitFor(f, () => entry(f, session.id).then(value => value.execution.state === 'ready'));
  assert.equal((await f.command('sessions.sendText', { sessionId: session.id, text })).status, 200);
  await waitFor(f, async () => (await (await resource(f, 'sessions.timeline', `sessionId=${session.id}`)).json()).turns[0]?.state === 'completed');
  const ready = await entry(f, session.id);
  assert.equal((await f.command('sessions.endRun', { runId: ready.execution.runId })).status, 200);
  await waitFor(f, () => entry(f, session.id).then(value => value.execution.state === 'stopped'));
  return session;
}
export async function entry(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string) {
  const overview = await (await f.query()).json();
  const value = overview.sessions.find((item: any) => item.session.id === sessionId);
  assert.ok(value, `session ${sessionId} missing`);
  return value as any;
}
export async function waitFor(f: Awaited<ReturnType<typeof sessionHost>>, check: () => Promise<boolean>, attempts = 400) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('condition not reached');
}
export function resource(f: Awaited<ReturnType<typeof sessionHost>>, name: string, parameters: string) {
  return fetch(`${f.host.url}/api/resources/${name}?${parameters}`, { headers: { Cookie: f.cookie } });
}
export function snapshot(f: Awaited<ReturnType<typeof sessionHost>>, name: string, parameters: Record<string, string>) {
  return fetch(`${f.host.url}/api/snapshots/${name}?${new URLSearchParams(parameters)}`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } });
}
export async function wire(f: Awaited<ReturnType<typeof sessionHost>>, which: 'a' | 'b') {
  const { readFile } = await import('node:fs/promises');
  try { return (await readFile(join(f.directory, `agent-${which}-wire`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}
