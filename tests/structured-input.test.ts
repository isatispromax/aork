import { afterEach, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from './fixtures/session-host.js';
import { answer, formRequest, inputWire, structuredAgent, startStructured, waitInput } from './fixtures/structured-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
    await close(); });
test('native form constraints remain repairable until one accepted response reaches the real ACP writer', async () => {
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { env } = await startStructured(f);
    const response = await f.query('interactions.inputPending');
    expect(response.status).toBe(200);
    const pending = await waitInput(async () => await (await f.query('interactions.inputPending')).json(), value => value.pending.length === 1);
    const input = pending.pending[0];
    expect(input).toMatchObject({ kind: 'structured', title: 'Plan the research', source: { method: 'elicitation/create', providerId: 'session.test', toolCallId: 'research-1' }, requestedSchema: formRequest.requestedSchema, state: 'pending' });
    expect((await inputWire(env.workspace.directory)).find(value => value.method === 'initialize').params.clientCapabilities).toEqual({ elicitation: { form: {} } });
    for (const content of [{ ...answer, topic: 'x' }, { ...answer, style: 'invented' }, { ...answer, count: 2.5 }, { ...answer, count: 8 }, { ...answer, extra: 'authority' }])
        expect((await f.command('interactions.submit', { interactionId: input.id, action: 'accept', content })).status).toBe(400);
    expect((await (await f.query('interactions.inputPending')).json()).pending).toHaveLength(1);
    const payload = { interactionId: input.id, action: 'accept', content: answer };
    const id = crypto.randomUUID();
    const accepted = await f.command('interactions.submit', payload, id);
    expect(accepted.status).toBe(200);
    const receipt = await accepted.json();
    expect(receipt.result.state).toBe('responding');
    await waitInput(async () => await (await f.query('interactions.inputHistory')).json(), value => value.interactions[0]?.state === 'responded');
    expect(await (await f.command('interactions.submit', payload, id)).json()).toEqual(receipt);
    expect((await f.command('interactions.submit', payload)).status).toBe(409);
    expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toEqual([{ jsonrpc: '2.0', id: 0, result: { action: 'accept', content: answer } }]);
    expect(await (await f.query('interactions.pending')).json()).toEqual({ pending: [] });
});
test('unsupported schema and URL requests report a safe capability diagnostic without persisting their raw secrets', async () => {
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const secret = 'secret-auth-token-never-record';
    const { env } = await startStructured(f, structuredAgent({ ...formRequest, mode: 'url', url: `https://auth.example/?token=${secret}`, elicitationId: secret }));
    await waitInput(() => inputWire(env.workspace.directory), value => value.some(item => item.id === 0 && item.error));
    const snapshot = await (await f.query('interactions.inputHistory')).json();
    expect(snapshot.interactions).toEqual([]);
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ code: 'INPUT_UNSUPPORTED', message: '此 Agent 请求超出当前工作表单能力；认证、URL 或未知字段约束未启用。' })]);
    const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } })).text();
    expect(events).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
});
async function openInput(source = structuredAgent()) {
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const opened = await startStructured(f, source);
    const snapshot = await waitInput(async () => await (await f.query('interactions.inputPending')).json(), value => value.pending.length === 1);
    return { f, ...opened, input: snapshot.pending[0] };
}
async function inputDetail(f: Awaited<ReturnType<typeof sessionHost>>, id: string) { return await (await fetch(`${f.host.url}/api/resources/interactions.inputDetail?id=${id}`, { headers: { Cookie: f.cookie } })).json(); }
test('unsupported flat-schema extensions never turn into fake controls, and ordinary questions from a non-eliciting peer stay chat', async () => {
    const bad = [{ ...formRequest, requestedSchema: { ...formRequest.requestedSchema, properties: { value: { type: 'string', pattern: '(a+)+$' } } } }, { ...formRequest, requestedSchema: { ...formRequest.requestedSchema, $ref: 'https://example.invalid/schema' } }, { ...formRequest, requestedSchema: { type: 'object', properties: { value: { type: '_future' } } } }, { ...formRequest, requestedSchema: { type: 'object', properties: { value: { type: 'array', items: { type: 'string' } } } } }, { ...formRequest, requestedSchema: { type: 'object', properties: { value: { type: 'string', format: 'email' } } } }, { ...formRequest, requestedSchema: { type: 'object', properties: { value: { type: 'integer', default: 1.5 } } } }, { ...formRequest, requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['missing'] } }, { ...formRequest, requestId: 99 }];
    const source = structuredAgent().replace(`send({id:0,method:'elicitation/create',params:${JSON.stringify(formRequest)}});`, `for(const [i,params] of ${JSON.stringify(bad)}.entries())send({id:i,method:'elicitation/create',params});`);
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { env } = await startStructured(f, source);
    const wire = await waitInput(() => inputWire(env.workspace.directory), value => value.filter(item => item.error).length === bad.length);
    expect(wire.filter(item => item.error).map(item => item.error.code)).toEqual(Array(8).fill(-32602));
    expect((await (await f.query('interactions.inputPending')).json()).pending).toEqual([]);
    expect((await (await f.query('interactions.inputHistory')).json()).diagnostics).toHaveLength(1);
    const ordinary = structuredAgent().replace(`send({id:0,method:'elicitation/create',params:${JSON.stringify(formRequest)}});`, "send({method:'session/update',params:{sessionId:'input-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Which topic should we research?'}}}});send({id:r.id,result:{stopReason:'end_turn'}});");
    const other = await sessionHost();
    cleanup.push(() => other.close());
    const { session } = await startStructured(other, ordinary);
    const timeline = await waitInput(async () => await (await fetch(`${other.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`, { headers: { Cookie: other.cookie } })).json(), value => value.turns[0]?.state === 'completed');
    expect(timeline.messages.map((value: {
        text: string;
    }) => value.text)).toContain('Which topic should we research?');
    expect((await (await other.query('interactions.inputHistory')).json())).toEqual({ interactions: [], diagnostics: [] });
});
test('decline and cancel are explicit native actions with no content, and browser-supplied authority or cross-kind responses are rejected', async () => {
    for (const action of ['decline', 'cancel'] as const) {
        const { f, env, input } = await openInput();
        expect((await f.command('interactions.submit', { interactionId: input.id, action, content: answer })).status).toBe(400);
        for (const authority of [{ generation: 2 }, { source: { method: 'spoof' } }, { owner: {} }, { requestId: 0 }, { nativeSessionId: 'input-native' }])
            expect((await f.command('interactions.submit', { interactionId: input.id, action, ...authority })).status).toBe(400);
        expect((await f.command('interactions.respond', { interactionId: input.id, optionId: 'allow-once' })).status).toBe(404);
        const unauth = await fetch(`${f.host.url}/api/queries/interactions.inputPending`);
        expect(unauth.status).toBe(401);
        expect((await f.command('interactions.submit', { interactionId: input.id, action })).status).toBe(200);
        await waitInput(() => inputDetail(f, input.id), value => value.state === 'responded');
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result).map(value => value.result)).toEqual([{ action }]);
    }
});
test('cancel, protocol abort and old Host cards close forms without sending a late accepted response', async () => {
    for (const outcome of ['turn', 'protocol', 'restart'] as const) {
        const source = outcome === 'protocol' ? structuredAgent().replace("if(r.method==='session/cancel')", "if(r.method==='session/prompt')setTimeout(()=>send({method:'$/cancel_request',params:{requestId:0}}),300);if(r.method==='session/cancel')") : structuredAgent();
        const { f, env, input } = await openInput(source);
        if (outcome === 'turn')
            expect((await f.command('sessions.cancelTurn', { turnId: input.turnId })).status).toBe(200);
        if (outcome === 'restart')
            await f.crashAndRestart();
        await waitInput(() => inputDetail(f, input.id), value => ['cancelled', 'expired'].includes(value.state));
        expect((await f.command('interactions.submit', { interactionId: input.id, action: 'accept', content: answer })).status).toBe(409);
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result?.action === 'accept')).toHaveLength(0);
    }
});
function blockedAgent(resume: boolean) { return structuredAgent().replace("import{appendFileSync}from'node:fs';", "import{appendFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';").replace('prompt=r;send({id:0', `prompt=r;process.stdin.pause();const timer=setInterval(()=>{if(existsSync(join(dirname(fileURLToPath(import.meta.url)),${JSON.stringify(resume ? 'resume' : 'disconnect')}))){${resume ? 'clearInterval(timer);process.stdin.resume();' : 'process.exit(0);'}}},10);send({id:'fill',method:'unknown'+('X'.repeat(400000)),params:{}});send({id:0`); }
test('a queued form response remains responding until physical write, and disconnect is unknown with no resend', async () => {
    const { f, env, input } = await openInput(blockedAgent(false));
    const payload = { interactionId: input.id, action: 'accept', content: answer };
    const id = crypto.randomUUID();
    const receipt = await (await f.command('interactions.submit', payload, id)).json();
    expect(receipt.result.state).toBe('responding');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await inputDetail(f, input.id)).state).toBe('responding');
    await writeFile(join(f.directory, 'disconnect'), 'disconnect');
    await waitInput(() => inputDetail(f, input.id), value => value.state === 'delivery_unknown');
    expect(await (await f.command('interactions.submit', payload, id)).json()).toEqual(receipt);
    expect((await f.command('interactions.submit', payload)).status).toBe(409);
    await f.restart();
    expect((await inputDetail(f, input.id)).state).toBe('delivery_unknown');
    expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result?.action === 'accept')).toHaveLength(0);
});
test('cancellation wins over a form selection queued behind an actual blocked native write', async () => {
    const { f, env, input } = await openInput(blockedAgent(true));
    expect((await f.command('interactions.submit', { interactionId: input.id, action: 'accept', content: answer })).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await inputDetail(f, input.id)).state).toBe('responding');
    expect((await f.command('sessions.cancelTurn', { turnId: input.turnId })).status).toBe(200);
    await waitInput(() => inputDetail(f, input.id), value => value.state === 'cancelled');
    await writeFile(join(f.directory, 'resume'), 'resume');
    await waitInput(() => inputWire(env.workspace.directory), value => value.some(item => item.method === 'session/cancel'));
    expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result).map(value => value.result)).toEqual([{ action: 'cancel' }]);
});
test('native form IDs remain typed, and the outer raw ingress budget still stops a flood of unsupported elicitation requests', async () => {
    const source = structuredAgent().replace("send({id:0,method:'elicitation/create'", "for(const id of [0,'0',null])send({id,method:'elicitation/create'");
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { env } = await startStructured(f, source);
    const pending = await waitInput(async () => await (await f.query('interactions.inputPending')).json(), value => value.pending.length === 3);
    expect(pending.pending.map((value: {
        requestId: unknown;
    }) => [typeof value.requestId, value.requestId])).toEqual([['number', 0], ['string', '0'], ['object', null]]);
    for (const input of pending.pending)
        expect((await f.command('interactions.submit', { interactionId: input.id, action: 'decline' })).status).toBe(200);
    await waitInput(() => inputWire(env.workspace.directory), value => value.filter(item => item.result?.action === 'decline').length === 3);
    const flood = structuredAgent().replace(`send({id:0,method:'elicitation/create',params:${JSON.stringify(formRequest)}});`, "process.stdin.pause();setInterval(()=>{},1000);send({id:'fill',method:'unknown'+('x'.repeat(400000)),params:{}});for(let i=0;i<200;i++)send({id:'flood-'+i,method:'elicitation/create',params:{mode:'url',message:'x'.repeat(50000),url:'https://example.invalid/'}});");
    const other = await sessionHost();
    cleanup.push(() => other.close());
    const opened = await startStructured(other, flood);
    const stopped = await waitInput(async () => await (await other.query()).json(), value => value.sessions[0]?.execution.state === 'stopped');
    expect(stopped.sessions[0].execution.reason).toContain('control ingress budget');
    expect((await (await other.query('interactions.inputPending')).json()).pending).toEqual([]);
});

test('the supported form response budget rejects a still-HTTP-bounded payload without consuming pending input',async()=>{
 const requestedSchema={type:'object',properties:Object.fromEntries(['a','b','c','d'].map(name=>[name,{type:'string',maxLength:2000}])),required:['a','b','c','d']};const {f,env,input}=await openInput(structuredAgent({...formRequest,requestedSchema}));const tooLarge=Object.fromEntries(['a','b','c','d'].map(name=>[name,'\u0000'.repeat(2000)]));const response=await f.command('interactions.submit',{interactionId:input.id,action:'accept',content:tooLarge});expect(response.status).toBe(400);expect((await(await f.query('interactions.inputPending')).json()).pending).toHaveLength(1);const content={a:'one',b:'two',c:'three',d:'four'};expect((await f.command('interactions.submit',{interactionId:input.id,action:'accept',content})).status).toBe(200);await waitInput(()=>inputWire(env.workspace.directory),value=>value.some(item=>item.result?.action==='accept'));
});
