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
        const eventLog = await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } })).json();
        expect(eventLog.events.filter((event: {
            type: string;
            payload: {
                runId: string;
            };
        }) => event.type === 'tools.grantChanged' && event.payload.runId === run.runId).map((event: {
            payload: {
                state: string;
            };
        }) => event.payload.state)).toEqual(['planned', 'live', 'revoked']);
    }
    finally {
        await f.close();
    }
});
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
async function pendingWriter(holdPastStop: boolean, unawaited = false) {
    let control = '';
    const f = await mcpHost(async (options) => {
        if (unawaited)
            await installConformance(options);
        control = join(options.directory, 'io-control');
        await mkdir(control);
        const preload = pathToFileURL(join(process.cwd(), 'tests/fixtures/mcp-io-preload.mjs'));
        preload.searchParams.set('control', control);
        options.hostArguments.push('--import', preload.href);
    });
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
            ['foreign-tool-consumer', [], ['aork.test.owner-vault@1', 'aork.runtime.acp@1', 'aork.tools@1', 'aork.workspace.run-files@1'], `export function activate(c){const owner=c.service('aork.test.owner-vault@1').owner;const runtime=c.service('aork.runtime.acp@1');const tools=c.service('aork.tools@1');const files=c.service('aork.workspace.run-files@1');c.query('foreignTools.check',{access:'authenticated',execute(){const result={borrowedValid:!!c.verifyOwner(owner)};for(const [key,operation] of [['runtime',tx=>runtime.acceptStart(tx,{owner})],['inputResponse',tx=>runtime.acceptInputResponse(tx,owner,'probe',{}, {})],['configuration',tx=>runtime.acceptConfiguration(tx,owner,{})],['tools',tx=>tools.createSelection(tx,{sessionId:crypto.randomUUID(),principal:'probe',workspaceId:crypto.randomUUID()},[])],['workspace',tx=>files.bindRunAuthority(tx,{},owner,{runId:crypto.randomUUID(),generation:1,hostEpoch:c.owner.hostEpoch},crypto.randomUUID())]])try{c.transactions.run(operation);result[key]='accepted';}catch(error){result[key]=error.code;}return result;}});}`]
        ] as const) {
            const directory = join(distributionDir, `plugins/${id}/0.1.0`);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', provides, requires, ...(id === 'selected-session-probe' ? { client: 'client.js' } : {}), ui: { providers: id === 'selected-session-probe' ? ['navigation', 'create', 'detail', 'composer', 'messages', 'tools', 'input-options'].map(name => ({ id: name, contract: 'aork.sessions.' + name + '@1' })) : [] } }));
            if (id === 'selected-session-probe')
                await writeFile(join(directory, 'client.js'), "export function activate(c){for(const id of ['navigation','create','detail','composer','messages','tools','input-options'])c.registerView(id,()=>null);}");
            await writeFile(join(directory, 'server.js'), source);
            profile.plugins.push({ id, version: '0.1.0', enabled: true });
        }
    });
    try {
        expect(await (await f.query('foreignTools.check')).json()).toEqual({ borrowedValid: true, runtime: 'RUN_OWNER_INVALID', inputResponse: 'RUN_OWNER_INVALID', configuration: 'RUN_OWNER_INVALID', tools: 'TOOL_CALLER_INVALID', workspace: 'WORKSPACE_CALLER_INVALID' });
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function toolEvents(f: Awaited<ReturnType<typeof sessionHost>>) {
    return (await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } })).json()).events as {
        type: string;
        occurredAt: string;
        payload: {
            runId?: string;
            state?: string;
            run?: {
                runId: string;
            };
            id?: string;
        };
    }[];
}
async function toolSession(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string) { return (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${sessionId}`, { headers: { Cookie: f.cookie } })).json(); }
test('public pre-dispatch shutdown reconciles the planned grant before publishing a terminal Run', async () => {
    const f = await sessionHost(false, async (options) => {
        for (const plugin of options.profile.plugins)
            if (plugin.id === 'sessions')
                plugin.enabled = false;
        options.profile.plugins.push({ id: 'planned-run-owner', version: '0.1.0', enabled: true });
        for (const name of ['navigation', 'create', 'detail', 'composer', 'messages', 'tools', 'input-options'])
            options.profile.ui.providers[`aork.sessions.${name}@1`] = `planned-run-owner:${name}`;
        const archive = join(options.directory, 'planned-run-owner.aork-plugin');
        const profile = join(options.directory, 'planned-profile.json');
        await writeFile(profile, JSON.stringify(options.profile));
        await promisify(execFile)(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'tests/fixtures/planned-run-owner', '--out', archive]);
        await promisify(execFile)(process.execPath, ['dist/server/main.mjs', 'plugin', 'install', archive, '--data-dir', join(options.directory, 'data'), '--distribution-dir', options.distributionDir, '--profile', profile]);
    });
    try {
        const env = await sessionEnvironment(f);
        const catalog = await (await f.query('tools.catalog')).json();
        const tools = catalog.tools.map(({ id, definitionVersion }: {
            id: string;
            definitionVersion: string;
        }) => ({ id, definitionVersion }));
        const response = await f.command('plannedRuns.startAndShutdown', { workspaceId: env.workspace.id, profileId: env.profile.id, tools });
        expect(response.status).toBe(200);
        const { run } = await response.json();
        await waitMcp(async () => await (await f.query('plannedRuns.list')).json(), value => value.runs[0]?.state === 'stopped');
        expect((await toolSession(f, run.sessionId)).runs[0].state).toBe('revoked');
        expect((await toolEvents(f)).filter(event => event.type === 'tools.grantChanged' && event.payload.runId === run.runId).map(event => event.payload.state)).toEqual(['planned', 'revoked']);
        await expect(readFile(join(env.workspace.directory, 'mcp-descriptor-shape.json'))).rejects.toHaveProperty('code', 'ENOENT');
    }
    finally {
        await f.close();
    }
});
test('ordinary Host shutdown persists revoked grants and their events before the next Host starts', async () => {
    const f = await mcpHost();
    try {
        const { session, run } = await startMcp(f);
        let nextHostNotBefore = 0;
        await f.offlineRestore(async () => { await new Promise(resolve => setTimeout(resolve, 25)); nextHostNotBefore = Date.now(); });
        expect((await toolSession(f, session.id)).runs[0].state).toBe('revoked');
        const revoked = (await toolEvents(f)).filter(event => event.type === 'tools.grantChanged' && event.payload.runId === run.runId && event.payload.state === 'revoked');
        expect(revoked).toHaveLength(1);
        expect(Date.parse(revoked[0]!.occurredAt)).toBeLessThan(nextHostNotBefore);
    }
    finally {
        await f.close();
    }
});
test('restart atomically publishes grant revocation and unknown call recovery without replay or duplicate events', async () => {
    const f = await mcpHost(options => installConformance(options));
    let pid: number | undefined;
    try {
        const { session, run } = await startMcp(f, ['tool-conformance.check']);
        pid = (await (await f.query()).json()).sessions[0].execution.processIdentity.group;
        expect((await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ tool: 'Independent conformance tool', arguments: { mode: 'cancel' } }) })).status).toBe(200);
        const pending = await waitMcp(() => calls(f, session.id), value => value.calls[0]?.state === 'running');
        const callId = pending.calls[0].id;
        await f.host.crash();
        try {
            process.kill(-pid!, 'SIGKILL');
        }
        catch { }
        pid = undefined;
        await f.restart();
        expect((await toolSession(f, session.id)).runs[0].state).toBe('revoked');
        expect((await calls(f, session.id)).calls[0]).toMatchObject({ id: callId, state: 'unknown' });
        const events = (await toolEvents(f)).filter(event => (event.type === 'tools.grantChanged' && event.payload.runId === run.runId && event.payload.state === 'revoked') || (event.type === 'tools.callChanged' && event.payload.id === callId && event.payload.state === 'unknown'));
        expect(events.map(event => [event.type, event.payload.state])).toEqual([['tools.grantChanged', 'revoked'], ['tools.callChanged', 'unknown']]);
        await f.restart();
        const again = (await toolEvents(f)).filter(event => (event.type === 'tools.grantChanged' && event.payload.runId === run.runId && event.payload.state === 'revoked') || (event.type === 'tools.callChanged' && event.payload.id === callId && event.payload.state === 'unknown'));
        expect(again).toEqual(events);
    }
    finally {
        if (pid)
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { }
        await f.close();
    }
});
test('Tools cleanup records unknown delivery only after the actual shutdown writer has joined', async () => {
    let control = '';
    const f = await mcpHost(async (options) => { control = join(options.directory, 'shutdown-io'); await mkdir(control); const preload = pathToFileURL(join(process.cwd(), 'tests/fixtures/mcp-io-preload.mjs')); preload.searchParams.set('control', control); options.hostArguments.push('--import', preload.href); });
    let reboot: Promise<void> | undefined;
    try {
        const { env, session, run } = await startMcp(f);
        await writeFile(join(control, 'workspace.json'), JSON.stringify({ root: env.workspace.directory }));
        expect((await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ tool: 'Write workspace text', arguments: { path: 'shutdown.txt', text: 'await actual IO' } }) })).status).toBe(200);
        await waitMcp(async () => await readFile(join(control, 'entered'), 'utf8').catch(() => ''), value => value === 'actual FileHandle.write invoked');
        const pending = (await calls(f, session.id)).calls[0];
        expect(pending.state).toBe('running');
        let completed = false;
        reboot = f.restart().then(() => { completed = true; });
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(completed).toBe(false);
        const releasedAt = Date.now();
        await writeFile(join(control, 'release'), 'release actual completion');
        await reboot;
        const recovered = (await calls(f, session.id)).calls[0];
        expect(recovered).toMatchObject({ id: pending.id, state: 'unknown', cancellationRequested: true, errorCode: 'TOOL_SCOPE_STOPPED' });
        const terminal = (await toolEvents(f)).filter(event => event.type === 'tools.callChanged' && event.payload.id === pending.id && event.payload.state === 'unknown');
        expect(terminal).toHaveLength(1);
        expect(Date.parse(terminal[0]!.occurredAt)).toBeGreaterThanOrEqual(releasedAt);
        expect((await toolSession(f, session.id)).runs[0].state).toBe('revoked');
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        await expect(readFile(join(env.workspace.directory, 'shutdown.txt'))).rejects.toHaveProperty('code', 'ENOENT');
        expect(run.runId).toBe(recovered.run.runId);
    }
    finally {
        await writeFile(join(control, 'release'), 'cleanup');
        await reboot?.catch(() => { });
        await f.close();
    }
});
import { installSchemaTools } from './fixtures/mcp-host.js';
test('an independent provider cannot install an async schema and invalid MCP input leaves the Host available', async () => {
    const f = await mcpHost(installSchemaTools);
    try {
        expect(await (await f.command('schemaTools.asyncRegistration', {})).json()).toEqual({ accepted: false, code: 'TOOL_SCHEMA_INVALID' });
        expect((await (await f.query('tools.catalog')).json()).tools.some((tool: {
            id: string;
        }) => tool.id === 'schema-tools.async')).toBe(false);
        const { session } = await startMcp(f, ['schema-tools.first']);
        const invalid = await callMcp(f, session.id, 'Schema first', {});
        expect(invalid.calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        expect((await callMcp(f, session.id, 'Schema first', { old: 'valid' })).calls[0].state).toBe('succeeded');
        expect(await (await f.query('schemaTools.status')).json()).toEqual({ invoked: 1 });
    }
    finally {
        await f.close();
    }
});
test('distinct tool definitions and provider reactivation isolate validators even when schemas share an id', async () => {
    const f = await mcpHost(installSchemaTools);
    try {
        const { session, run } = await startMcp(f, ['schema-tools.first', 'schema-tools.second']);
        expect((await callMcp(f, session.id, 'Schema first', { old: 'first' })).calls[0].state).toBe('succeeded');
        const next = await callMcp(f, session.id, 'Schema second', { next: 'second' });
        expect(next.calls[0].state).toBe('succeeded');
        const wrong = await callMcp(f, session.id, 'Schema second', { old: 'must reject' });
        expect(wrong.calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        const captured = await toolSession(f, session.id);
        expect(captured.runs[0].snapshot.tools.map((tool: {
            inputSchema: {
                required: string[];
            };
        }) => tool.inputSchema.required)).toEqual([['old'], ['next']]);
        expect((await f.command('sessions.endRun', { runId: run.runId })).status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        expect((await f.command('plugins.configure', { pluginId: 'schema-tools', config: { shape: 'changed' } })).status).toBe(200);
        await f.refreshBootstrap();
        const replacement = await startMcp(f, ['schema-tools.first', 'schema-tools.second']);
        expect((await callMcp(f, replacement.session.id, 'Schema second', { changed: 'new definition' })).calls[0].state).toBe('succeeded');
        expect((await callMcp(f, replacement.session.id, 'Schema second', { next: 'old definition' })).calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        const historical = await toolSession(f, session.id);
        expect(historical.runs[0].snapshot.tools[1].inputSchema.required).toEqual(['next']);
    }
    finally {
        await f.close();
    }
});
import { legacySessions } from './fixtures/legacy-sessions.js';
test('upgrading the accepted legacy Session package backfills archived tool selections as read-only exactly once', async () => {
    let upgrade!: () => Promise<void>;
    const f = await sessionHost(false, async (options) => { upgrade = await legacySessions(options); });
    try {
        const env = await sessionEnvironment(f);
        const created = await f.command('sessions.create', env.input);
        expect(created.status).toBe(200);
        const session = (await created.json()).result;
        expect((await f.command('sessions.archive', { id: session.id })).status).toBe(200);
        expect((await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).status).toBe(404);
        await f.offlineRestore(async () => upgrade());
        const state = await toolSession(f, session.id);
        expect(state).toMatchObject({ archived: true, selection: { revision: 1, tools: [] } });
        expect((await f.command('tools.replaceSessionSelection', { sessionId: session.id, expectedRevision: 1, tools: [] })).status).toBe(409);
        const before = await toolEvents(f);
        await f.restart();
        expect(await toolEvents(f)).toEqual(before);
        expect((await toolSession(f, session.id)).archived).toBe(true);
    }
    finally {
        await f.close();
    }
});
test('re-revoking an older Run cannot replace the current Run or reorder immutable generation history', async () => {
    const f = await mcpHost();
    try {
        const { session, run: first } = await startMcp(f);
        expect((await f.command('sessions.endRun', { runId: first.runId })).status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'stopped');
        const started = await f.command('sessions.startRun', { sessionId: session.id });
        expect(started.status).toBe(200);
        const second = (await started.json()).result;
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions[0].execution.state === 'ready');
        const before = (await toolEvents(f)).filter(event => event.type === 'tools.grantChanged' && event.payload.runId === first.runId && event.payload.state === 'revoked');
        expect((await f.command('tools.revokeRun', { runId: first.runId })).status).toBe(200);
        const current = await toolSession(f, session.id);
        expect(current.runs[0].snapshot.run).toMatchObject({ runId: second.runId, generation: 2 });
        expect(current.history.map((entry: {
            run: {
                runId: string;
            };
        }) => entry.run.runId)).toEqual([first.runId, second.runId]);
        expect((await toolEvents(f)).filter(event => event.type === 'tools.grantChanged' && event.payload.runId === first.runId && event.payload.state === 'revoked')).toEqual(before);
        expect(current.runs[0].state).toBe('live');
    }
    finally {
        await f.close();
    }
});
test('unsupported parser Promises fail before the handler and their rejections cannot terminate the Host', async () => {
    const f = await mcpHost(installSchemaTools);
    try {
        const { session } = await startMcp(f, ['schema-tools.async_parser']);
        const resolved = await callMcp(f, session.id, 'Async parser forbidden', {});
        expect(resolved.calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        const rejected = await callMcp(f, session.id, 'Async parser forbidden', { reject: true });
        expect(rejected.calls[0]).toMatchObject({ state: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID' });
        expect(JSON.stringify(rejected)).not.toContain('PRIVATE_ASYNC_PARSER_ERROR');
        expect(await (await f.query('schemaTools.status')).json()).toEqual({ invoked: 0 });
    }
    finally {
        await f.close();
    }
});
import { largeOptions } from './fixtures/large-input-host.js';
test('near-limit negotiated configuration plus maximum tool refs and owners fit combined Run and Turn publication budgets', async () => {
    const ownerIds: string[] = [];
    const f = await mcpHost(async ({ distributionDir, profile }) => { for (let index = 0; index < 8; index++) {
        const id = `b${index}-` + 'p'.repeat(97);
        ownerIds.push(id);
        const directory = join(distributionDir, 'plugins', id, '0.1.0');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.tools@1'], ui: { providers: [] } }));
        await writeFile(join(directory, 'server.js'), `export function activate(c){const inputSchema={type:'object',additionalProperties:false,description:''};inputSchema.description='s'.repeat(16384-Buffer.byteLength(JSON.stringify(inputSchema)));c.effect(()=>c.service('aork.tools@1').registerTool({id:c.pluginId+'.'+'t'.repeat(59),definitionVersion:'\\u0000'.repeat(64),title:'Budget ${index}',description:'Maximum allowed bounded descriptor',access:'read',inputSchema,arguments:{parse:v=>v}},()=>({content:[{type:'text',text:'budget executed'}]})));}`);
        profile.plugins.push({ id, version: '0.1.0', enabled: true });
    } });
    try {
        const healthy = await startMcp(f, ['workspace-tools.read_text']);
        await writeFile(join(healthy.env.workspace.directory, 'healthy.txt'), 'healthy sibling');
        const env = await sessionEnvironment(f);
        const options = structuredClone(largeOptions);
        const candidate = { revision: 1, prompt: { image: false, audio: false, embeddedContext: true }, configOptions: options };
        const padding = 16000 - Buffer.byteLength(JSON.stringify(candidate));
        expect(padding).toBeGreaterThanOrEqual(0);
        options[0]!.options[0]!.name += 'x'.repeat(padding);
        expect(Buffer.byteLength(JSON.stringify(candidate))).toBe(16000);
        await writeFile(join(env.workspace.directory, 'mcp-native-config.json'), JSON.stringify({ configOptions: options, promptCapabilities: { embeddedContext: true } }));
        const paths = Array.from({ length: 4 }, (_, index) => `${'\u0001'.repeat(100)}${'d'.repeat(70)}/${'e'.repeat(170)}/${'\u0002'.repeat(166)}${'f'.repeat(45)}${index}`);
        for (const [index, path] of paths.entries()) {
            await mkdir(join(env.workspace.directory, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
            const response = await fetch(`${f.host.url}/api/resources/workspace.file?${new URLSearchParams({ workspaceId: env.workspace.id, path })}`, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash, 'Content-Type': 'application/octet-stream' }, body: `private budget attachment ${index}` });
            expect(response.status).toBe(200);
        }
        const catalog = await (await f.query('tools.catalog')).json();
        const refs = catalog.tools.filter((tool: {
            ownerPluginId: string;
        }) => ownerIds.includes(tool.ownerPluginId)).map(({ id, definitionVersion }: {
            id: string;
            definitionVersion: string;
        }) => ({ id, definitionVersion }));
        expect(refs).toHaveLength(8);
        expect(refs.every((ref: {
            id: string;
            definitionVersion: string;
        }) => ref.id.length === 160 && ref.definitionVersion.length === 64)).toBe(true);
        const session = (await (await f.command('sessions.create', { ...env.input, tools: refs })).json()).result;
        const started = await f.command('sessions.startRun', { sessionId: session.id });
        expect(started.status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions.find((entry: {
            session: {
                id: string;
            };
        }) => entry.session.id === session.id)?.execution.state === 'ready');
        const overview = await (await f.query()).json();
        const run = overview.sessions.find((entry: {
            session: {
                id: string;
            };
        }) => entry.session.id === session.id).execution;
        expect(run.negotiated).toEqual(candidate);
        expect(run.usedPluginIds.filter((id: string) => ownerIds.includes(id))).toHaveLength(8);
        expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThan(32768);
        expect(JSON.stringify(overview)).not.toContain('s'.repeat(1000));
        const detail = await toolSession(f, session.id);
        expect(detail.runs[0].snapshot.tools.reduce((sum: number, tool: {
            inputSchema: unknown;
        }) => sum + Buffer.byteLength(JSON.stringify(tool.inputSchema)), 0)).toBe(8 * 16384);
        const sent = await f.command('sessions.sendText', { sessionId: session.id, text: JSON.stringify({ tool: 'Budget 0', arguments: {} }), attachments: paths.map(path => ({ path, kind: 'text' })) });
        expect(sent.status).toBe(200);
        const turn = (await sent.json()).result;
        expect(Buffer.byteLength(JSON.stringify(turn.attachments))).toBeGreaterThan(7900);
        expect(Buffer.byteLength(JSON.stringify(turn))).toBeLessThan(32768);
        await waitMcp(async () => await (await fetch(`${f.host.url}/api/resources/sessions.turn?turnId=${turn.id}`, { headers: { Cookie: f.cookie } })).json(), value => value.turn.state === 'completed');
        const configured = await f.command('sessions.configureRun', { runId: run.runId, generation: run.generation, expectedRevision: 1, change: { kind: 'option', configId: options[0]!.id, value: options[0]!.options[1]!.value } });
        expect(configured.status).toBe(200);
        await waitMcp(async () => await (await f.query()).json(), value => value.sessions.find((entry: {
            session: {
                id: string;
            };
        }) => entry.session.id === session.id)?.execution.configuration?.state === 'applied');
        expect((await f.command('workspace.createProject', { name: 'Healthy after combined publication', workspace: { name: 'Unaffected', management: 'managed' } })).status).toBe(200);
        expect((await callMcp(f, healthy.session.id, 'Read workspace text', { path: 'healthy.txt' })).calls[0].state).toBe('succeeded');
        const eventResponse = await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } });
        expect(eventResponse.status).toBe(200);
        const events = (await eventResponse.json()).events;
        const runBytes = events.filter((event: {
            type: string;
            payload: {
                runId?: string;
            };
        }) => event.type === 'sessions.runChanged' && event.payload.runId === run.runId).map((event: {
            payload: unknown;
        }) => Buffer.byteLength(JSON.stringify(event.payload)));
        const turnBytes = events.filter((event: {
            type: string;
            payload: {
                id?: string;
            };
        }) => event.type === 'sessions.turnChanged' && event.payload.id === turn.id).map((event: {
            payload: unknown;
        }) => Buffer.byteLength(JSON.stringify(event.payload)));
        expect(runBytes.length).toBeGreaterThan(2);
        expect(turnBytes.length).toBeGreaterThan(1);
        expect([...runBytes, ...turnBytes].every(bytes => bytes <= 32768)).toBe(true);
        await writeFile('/tmp/aork24-combined-publication-proof.json', JSON.stringify({ negotiatedBytes: 16000, toolCount: 8, ownerIdChars: 100, toolIdChars: 160, definitionVersionChars: 64, privateToolSchemasBytes: 8 * 16384, compactRefsBytes: Buffer.byteLength(JSON.stringify(refs)), attachmentMetadataBytes: Buffer.byteLength(JSON.stringify(turn.attachments)), maxRunEventBytes: Math.max(...runBytes), maxTurnEventBytes: Math.max(...turnBytes), unrelatedWorkspaceStatus: 200, siblingMcpCall: 'succeeded' }, null, 2));
    }
    finally {
        await f.close();
    }
}, 30000);
