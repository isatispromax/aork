import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './session-host.js';
export const formRequest = { sessionId: 'input-native', mode: 'form', message: 'Plan the research', toolCallId: 'research-1', requestedSchema: { type: 'object', properties: { topic: { type: 'string', title: 'Topic', minLength: 3, maxLength: 20 }, style: { type: 'string', title: 'Style', enum: ['brief', 'detailed'], default: 'brief' }, count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5, default: 2 }, publish: { type: 'boolean', title: 'Publish', default: false } }, required: ['topic', 'style', 'count'] } };
export function structuredAgent(request: unknown = formRequest) {
    return `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let prompt;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('input-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'input-native'}});
if(r.method==='session/prompt'){prompt=r;send({id:0,method:'elicitation/create',params:${JSON.stringify(request)}});}
if(r.method==='session/cancel')send({id:prompt.id,result:{stopReason:'cancelled'}});
});`;
}
export async function startStructured(f: Awaited<ReturnType<typeof sessionHost>>, source = structuredAgent()) {
    await writeFile(join(f.directory, 'controlled-agent.mjs'), source);
    const env = await sessionEnvironment(f);
    const created = await f.command('sessions.create', env.input);
    if (created.status !== 200)
        throw Error(await created.text());
    const session = (await created.json()).result;
    const started = await f.command('sessions.startRun', { sessionId: session.id });
    if (started.status !== 200)
        throw Error(await started.text());
    await waitInput(async () => await (await f.query()).json(), value => value.sessions.find((entry: {
        session: {
            id: string;
        };
    }) => entry.session.id === session.id)?.execution.state === 'ready');
    await f.command('sessions.sendText', { sessionId: session.id, text: 'Plan research' });
    return { env, session };
}
export async function waitInput<T>(read: () => Promise<T>, accept: (value: T) => boolean) { const deadline = Date.now() + 10000; let value: T; do {
    value = await read();
    if (accept(value))
        return value;
    await new Promise(resolve => setTimeout(resolve, 20));
} while (Date.now() < deadline); throw Error('Expected input state not reached: ' + JSON.stringify(value!)); }
export async function inputWire(directory: string) { return (await readFile(join(directory, 'input-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
export const answer = { topic: 'Solar energy', style: 'brief', count: 2, publish: false };
export async function structuredHost() {
    return sessionHost(false, async ({ directory, distributionDir, profile }) => {
        profile.plugins.push({ id: 'independent-structured-view', version: '0.1.0', enabled: true });
        profile.ui.providers['aork.interactions.form@1'] = 'independent-structured-view:form';
        const archive = join(directory, 'independent-structured-view.aork-plugin');
        const profileFile = join(directory, 'structured-profile.json');
        await writeFile(profileFile, JSON.stringify(profile));
        await promisify(execFile)(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'tests/fixtures/structured-view', '--out', archive]);
        await promisify(execFile)(process.execPath, ['dist/server/main.mjs', 'plugin', 'install', archive, '--data-dir', join(directory, 'data'), '--distribution-dir', distributionDir, '--profile', profileFile]);
    });
}
