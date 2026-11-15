import { expect, test } from 'vitest';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
test('a Session explicitly selects exact Host tools and defaults to an empty set', async () => {
    const f = await sessionHost();
    try {
        const catalogResponse = await f.query('tools.catalog');
        expect(catalogResponse.status).toBe(200);
        const { tools } = await catalogResponse.json();
        expect(tools.map((tool: {
            id: string;
        }) => tool.id).sort()).toEqual(['workspace-tools.read_text', 'workspace-tools.write_text']);
        const env = await sessionEnvironment(f);
        const created = await f.command('sessions.create', env.input);
        expect(created.status).toBe(200);
        const session = (await created.json()).result;
        const selection = await (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).json();
        expect(selection.selection.tools).toEqual([]);
        const selected = await f.command('tools.replaceSessionSelection', { sessionId: session.id, expectedRevision: 1, tools: tools.map(({ id, definitionVersion }: {
                id: string;
                definitionVersion: string;
            }) => ({ id, definitionVersion })) });
        expect(selected.status).toBe(200);
        expect((await selected.json()).result.tools).toHaveLength(2);
        expect((await f.command('tools.replaceSessionSelection', { sessionId: session.id, expectedRevision: 1, tools: [] })).status).toBe(409);
        await f.restart();
        const saved = await (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).json();
        expect(saved.selection.tools).toHaveLength(2);
    }
    finally {
        await f.close();
    }
});
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callMcp, calls, mcpHost, startMcp, waitMcp } from './fixtures/mcp-host.js';
test('the actual per-Run MCP bridge writes and reads real claimed Workspace files with bounded public call history', async () => {
    const f = await mcpHost();
    try {
        const { env, session, run } = await startMcp(f);
        expect(run.tools.tools.map((tool: {
            id: string;
        }) => tool.id)).toEqual(['workspace-tools.read_text', 'workspace-tools.write_text']);
        expect(run.usedPluginIds).toContain('workspace-tools');
        expect(run.usedPluginIds).toContain('tools');
        const written = await callMcp(f, session.id, 'Write workspace text', { path: 'mcp.txt', text: 'A real MCP file\nfrom the claimed Run' });
        expect(written.calls[0].state).toBe('succeeded');
        expect(await readFile(join(env.workspace.directory, 'mcp.txt'), 'utf8')).toBe('A real MCP file\nfrom the claimed Run');
        const read = await callMcp(f, session.id, 'Read workspace text', { path: 'mcp.txt' });
        expect(JSON.parse(read.calls[0].result.content[0].text)).toMatchObject({ text: 'A real MCP file\nfrom the claimed Run', truncated: false });
        const preview = await (await fetch(`${f.host.url}/api/resources/workspace.preview?workspaceId=${env.workspace.id}&path=mcp.txt`, { headers: { Cookie: f.cookie } })).json();
        expect(preview.text).toBe('A real MCP file\nfrom the claimed Run');
        const denied = await callMcp(f, session.id, 'Write workspace text', { path: '../escape.txt', text: 'escape' });
        expect(denied.calls[0]).toMatchObject({ state: 'failed', result: { isError: true } });
        const ordinary = await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=browser.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash }, body: 'blocked' });
        expect(ordinary.status).toBe(409);
        expect(JSON.stringify(await calls(f, session.id))).not.toContain('AORK_RUN_TOKEN');
        expect((await f.command('sessions.endRun', { runId: run.runId })).status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        const eventLog=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();expect(eventLog.events.filter((event:{type:string;payload:{runId:string}})=>event.type==='tools.grantChanged'&&event.payload.runId===run.runId).map((event:{payload:{state:string}})=>event.payload.state)).toEqual(['planned','live','revoked']);

    }
    finally {
        await f.close();
    }
});
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
async function pendingWriter(holdPastStop: boolean, unawaited = false) {
    let control = '';
    const f = await mcpHost(async (options) => { if (unawaited)
        await installConformance(options); control = join(options.directory, 'io-control'); await mkdir(control); const preload = pathToFileURL(join(process.cwd(), 'tests/fixtures/mcp-io-preload.mjs')); preload.searchParams.set('control', control); options.hostArguments.push('--import', preload.href); });
    try {
        const { env, session, run } = await startMcp(f, unawaited ? ['tool-conformance.check'] : undefined);
        await writeFile(join(control, 'workspace.json'), JSON.stringify({ root: env.workspace.directory }));
        expect((await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ tool: unawaited ? 'Independent conformance tool' : 'Write workspace text', arguments: { ...(unawaited ? { mode: 'unawaited' } : {}), path: 'pending.txt', text: 'must wait for actual IO' } }) })).status).toBe(200);
        await waitMcp(async () => readFile(join(control, 'entered'), 'utf8').catch(() => ''), value => value === 'actual FileHandle.write invoked');
        expect(await readFile(join(control, 'native-settled'), 'utf8')).toBe('actual operation settled');
        expect((await calls(f, session.id)).calls[0].state).toBe('running');
        expect((await f.command(unawaited ? 'tools.revokeRun' : 'sessions.endRun', { runId: run.runId })).status).toBe(200);
        const ordinary = () => fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=competing.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash }, body: 'must stay blocked' });
        expect((await ordinary()).status).toBe(409);
        if (holdPastStop) {
            await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'unknown');
            expect((await calls(f, session.id)).calls[0]).toMatchObject({ state: 'running', cancellationRequested: true });
        }
        else {
            await new Promise(resolve => setTimeout(resolve, 150));
            expect((await (await f.query()).json()).sessions[0].execution.state).toBe('stopping');
        }
        await writeFile(join(control, 'release'), 'release delivery');
        await waitMcp(() => calls(f, session.id), value => value.calls[0].state === 'cancelled');
        await expect(readFile(join(env.workspace.directory, 'pending.txt'))).rejects.toHaveProperty('code', 'ENOENT');
        if (holdPastStop) {
            await new Promise(resolve => setTimeout(resolve, 150));
            expect((await (await f.query()).json()).sessions[0].execution.state).toBe('unknown');
            expect((await ordinary()).status).toBe(409);
        }
        else {
            await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
            expect((await ordinary()).status).toBe(200);
        }
    }
    finally {
        await writeFile(join(control, 'release'), 'cleanup');
        await f.close();
    }
}
test('endRun joins an actual admitted Workspace write before releasing Claim', () => pendingWriter(false));
test('an actual writer held beyond the stop deadline keeps Claim blocked after Agent exit and late settlement', () => pendingWriter(true));
import { installConformance } from './fixtures/mcp-host.js';
import { createHash } from 'node:crypto';
test('an independently installed tool is captured exactly, reports invalid output and rejects retained file facades', async () => {
    const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await mcpHost(options => installConformance(options));
    try {
        const { env, session, run } = await startMcp(f, ['tool-conformance.check']);
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
        expect(run.usedPluginIds).toContain('tool-conformance');
        for (const [mode, code] of [['normal', undefined], ['throw', 'TOOL_HANDLER_FAILED'], ['invalid', 'TOOL_RESULT_INVALID'], ['oversize', 'TOOL_RESULT_INVALID'], ['late', undefined]] as const) {
            const result = await callMcp(f, session.id, 'Independent conformance tool', { mode });
            expect(result.calls[0].state).toBe(code ? 'failed' : 'succeeded');
            if (code)
                expect(result.calls[0].errorCode).toBe(code);
            expect(JSON.stringify(result)).not.toContain('PRIVATE_');
        }
        await waitMcp(async () => await (await f.query('conformance.status')).json(), value => value.late === 'rejected');
        await expect(readFile(join(env.workspace.directory, 'late-should-not-exist.txt'))).rejects.toHaveProperty('code', 'ENOENT');
        expect((await f.command('plugins.configure', { pluginId: 'tool-conformance', config: {} })).status).toBe(409);
        const changed = await f.command('tools.replaceSessionSelection', { sessionId: session.id, expectedRevision: 1, tools: [] });
        expect(changed.status).toBe(200);
        expect((await callMcp(f, session.id, 'Independent conformance tool', { mode: 'normal' })).calls[0].state).toBe('succeeded');
        expect((await f.command('tools.revokeRun', { runId: run.runId })).status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        expect((await f.command('plugins.setEnabled', { pluginId: 'tool-conformance', enabled: false })).status).toBe(200);
        await f.refreshBootstrap();
        expect((await calls(f, session.id)).calls).toHaveLength(6);
    }
    finally {
        await f.close();
    }
});
test('a provider returning without awaiting its actual file Promise cannot release the job or Claim early', () => pendingWriter(true, true));
test('protected socket rejects unauthenticated frames and MCP cancellation drains only its intended Run', async () => {
    const f = await mcpHost(options => installConformance(options));
    try {
        const first = await startMcp(f, ['tool-conformance.check']);
        const second = await startMcp(f);
        const shape = JSON.parse(await readFile(join(first.env.workspace.directory, 'mcp-descriptor-shape.json'), 'utf8'));
        expect(shape.protections).toEqual({ wrongToken: true, missingToken: true, selfSession: true, oversizeFrame: true, parentMode: 448, socketMode: 384 });
        expect((await f.command('sessions.sendText', { sessionId: first.session.id, text: JSON.stringify({ tool: 'Independent conformance tool', arguments: { mode: 'cancel' }, cancelAfterMs: 100 }) })).status).toBe(200);
        await waitMcp(() => calls(f, first.session.id), value => value.calls?.some((call: {
            state: string;
        }) => call.state === 'cancelled'));
        expect((await callMcp(f, second.session.id, 'Write workspace text', { path: 'isolated.txt', text: 'other Run remains authorized' })).calls[0].state).toBe('succeeded');
        expect(await readFile(join(second.env.workspace.directory, 'isolated.txt'), 'utf8')).toBe('other Run remains authorized');
        const overview = await (await f.query()).json();
        expect(overview.sessions.every((entry: {
            execution: {
                state: string;
            };
        }) => entry.execution.state === 'ready')).toBe(true);
    }
    finally {
        await f.close();
    }
});
test('failed provider activations leave no effective tools and stale scoped registrations cannot return', async () => {
    const f = await sessionHost(false, async ({ distributionDir, profile }) => { const directory = join(distributionDir, 'plugins/failed-tools/0.1.0'); await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'failed-tools', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.tools@1'], configSchema: { type: 'object', properties: { fail: { type: 'boolean' } }, additionalProperties: false }, ui: { providers: [] } })); await writeFile(join(directory, 'server.js'), `let old;let invoked=0;export function activate(c){const tools=c.service('aork.tools@1');const previous=old;old=tools;for(let i=0;i<64;i++)tools.registerTool({id:'failed-tools.check_'+i,definitionVersion:'1',title:'Failure cleanup '+i,description:'Conformance',access:'read',inputSchema:{type:'object',additionalProperties:false},arguments:{parse:v=>v}},()=>{invoked++;return{content:[{type:'text',text:'must not run'}]};});if(c.config.fail!==false)throw Error('after registration before disposer');let stale='no-old-facade';try{previous?.registerTool({id:'failed-tools.stale',definitionVersion:'1',title:'stale',description:'stale',access:'read',inputSchema:{type:'object'},arguments:{parse:v=>v}},()=>({content:[]}));stale='accepted';}catch{stale='rejected';}c.query('failedTools.status',{access:'authenticated',execute:()=>({stale,invoked})});}`); profile.plugins.push({ id: 'failed-tools', version: '0.1.0', enabled: false }); });
    try {
        for (let i = 0; i < 5; i++) {
            expect((await f.command('plugins.setEnabled', { pluginId: 'failed-tools', enabled: true })).status).toBe(503);
            await f.refreshBootstrap();
            const catalog = await (await f.query('tools.catalog')).json();
            expect(catalog.tools.map((tool: {
                id: string;
            }) => tool.id).sort()).toEqual(['workspace-tools.read_text', 'workspace-tools.write_text']);
        }
        expect((await f.command('plugins.configure', { pluginId: 'failed-tools', config: { fail: false } })).status).toBe(200);
        await f.refreshBootstrap();
        expect((await f.command('plugins.setEnabled', { pluginId: 'failed-tools', enabled: true })).status).toBe(200);
        await f.refreshBootstrap();
        expect((await (await f.query('tools.catalog')).json()).tools).toHaveLength(66);
        expect(await (await f.query('failedTools.status')).json()).toEqual({ stale: 'rejected', invoked: 0 });
    }
    finally {
        await f.close();
    }
}, 45000);
test('a valid borrowed lifecycle descriptor cannot replace the actual scoped Tools, Runtime or Workspace caller', async () => {
    const f = await sessionHost(false, async ({ distributionDir, profile }) => {
        for (const plugin of profile.plugins)
            if (plugin.id === 'sessions')
                plugin.enabled = false;
        for (const contract of Object.keys(profile.ui.providers))
            if (contract.startsWith('aork.sessions.'))
                profile.ui.providers[contract] = 'selected-session-probe:' + contract.split('.')[2]!.split('@')[0];
        for (const [id, provides, requires, source] of [
            ['selected-session-probe', ['aork.sessions@1', 'aork.test.owner-vault@1'], [], `export function activate(c){c.provide('aork.sessions@1',{registerArchiveParticipant(){return()=>{};}});c.provide('aork.test.owner-vault@1',{owner:c.owner});}`],
            ['foreign-tool-consumer', [], ['aork.test.owner-vault@1', 'aork.runtime.acp@1', 'aork.tools@1', 'aork.workspace.run-files@1'], `export function activate(c){const owner=c.service('aork.test.owner-vault@1').owner;const runtime=c.service('aork.runtime.acp@1');const tools=c.service('aork.tools@1');const files=c.service('aork.workspace.run-files@1');c.query('foreignTools.check',{access:'authenticated',execute(){const result={borrowedValid:!!c.verifyOwner(owner)};for(const [key,operation] of [['runtime',tx=>runtime.acceptStart(tx,{owner})],['tools',tx=>tools.createSelection(tx,{sessionId:crypto.randomUUID(),principal:'probe',workspaceId:crypto.randomUUID()},[])],['workspace',tx=>files.bindRunAuthority(tx,{},owner,{runId:crypto.randomUUID(),generation:1,hostEpoch:c.owner.hostEpoch},crypto.randomUUID())]])try{c.transactions.run(operation);result[key]='accepted';}catch(error){result[key]=error.code;}return result;}});}`]
        ] as const) {
            const directory = join(distributionDir, `plugins/${id}/0.1.0`);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', provides, requires, ...(id === 'selected-session-probe' ? { client: 'client.js' } : {}), ui: { providers: id === 'selected-session-probe' ? ['navigation', 'create', 'detail', 'composer', 'messages', 'tools'].map(name => ({ id: name, contract: 'aork.sessions.' + name + '@1' })) : [] } }));
            if (id === 'selected-session-probe')
                await writeFile(join(directory, 'client.js'), "export function activate(c){for(const id of ['navigation','create','detail','composer','messages','tools'])c.registerView(id,()=>null);}");
            await writeFile(join(directory, 'server.js'), source);
            profile.plugins.push({ id, version: '0.1.0', enabled: true });
        }
    });
    try {
        expect(await (await f.query('foreignTools.check')).json()).toEqual({ borrowedValid: true, runtime: 'RUN_OWNER_INVALID', tools: 'TOOL_CALLER_INVALID', workspace: 'WORKSPACE_CALLER_INVALID' });
    }
    finally {
        await f.close();
    }
});
import { symlink, rename } from 'node:fs/promises';
test('actual MCP calls reject argument authority, symlink escape, changed access and replaced physical roots', async () => {
    const f = await mcpHost();
    try {
        const { env, session } = await startMcp(f);
        const forbidden = await callMcp(f, session.id, 'Write workspace text', { path: 'foreign.txt', text: 'unsafe', workspaceId: env.workspace.id });
        expect(forbidden.calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        await writeFile(join(f.directory, 'outside.txt'), 'outside untouched');
        await symlink(join(f.directory, 'outside.txt'), join(env.workspace.directory, 'alias.txt'));
        const link = await callMcp(f, session.id, 'Write workspace text', { path: 'alias.txt', text: 'overwrite' });
        expect(link.calls[0]).toMatchObject({ state: 'failed', errorCode: 'WORKSPACE_SYMLINK_REJECTED' });
        expect(await readFile(join(f.directory, 'outside.txt'), 'utf8')).toBe('outside untouched');
        expect((await f.command('workspace.edit', { id: env.workspace.id, name: 'Read only now', access: 'read-only' })).status).toBe(200);
        const denied = await callMcp(f, session.id, 'Write workspace text', { path: 'denied.txt', text: 'no' });
        expect(denied.calls[0]).toMatchObject({ state: 'failed', errorCode: 'WORKSPACE_READ_ONLY' });
        expect((await f.command('workspace.edit', { id: env.workspace.id, name: 'Writable', access: 'read-write' })).status).toBe(200);
        await rename(env.workspace.directory, env.workspace.directory + '-original');
        await mkdir(env.workspace.directory);
        const replaced = await callMcp(f, session.id, 'Write workspace text', { path: 'replaced.txt', text: 'no' });
        expect(replaced.calls[0]).toMatchObject({ state: 'failed', errorCode: 'WORKSPACE_DIRECTORY_CHANGED' });
        await expect(readFile(join(env.workspace.directory, 'replaced.txt'))).rejects.toHaveProperty('code', 'ENOENT');
    }
    finally {
        await f.close();
    }
});
test('oversized actual MCP arguments fail explicitly and closing the authenticated bridge stops its Run', async () => {
    const f = await mcpHost();
    try {
        const { env, session } = await startMcp(f);
        const response = await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ tool: 'Write workspace text', largeArgumentsBytes: 400000 }) });
        const turn = (await response.json()).result;
        const failed = await waitMcp(() => calls(f, session.id), value => value.calls?.some((call: {
            turnId: string;
            state: string;
        }) => call.turnId === turn.id && call.state === 'failed'));
        expect(failed.calls[0].errorCode).toBe('TOOL_ARGUMENTS_TOO_LARGE');
        await expect(readFile(join(env.workspace.directory, 'large.txt'))).rejects.toHaveProperty('code', 'ENOENT');
        expect((await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ disconnectBridge: true }) })).status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        const grant = await (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).json();
        expect(grant.runs[0].state).toBe('revoked');
    }
    finally {
        await f.close();
    }
});
