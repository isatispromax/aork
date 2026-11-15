import { build } from 'esbuild';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from './session-host.js';
export async function mcpHost(augment?: Parameters<typeof sessionHost>[1]) { return sessionHost(false, async (options) => { await augment?.(options); await build({ entryPoints: ['tests/fixtures/mcp-agent.ts'], outfile: join(options.directory, 'controlled-agent.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } }); }); }
export async function startMcp(f: Awaited<ReturnType<typeof sessionHost>>, select = ['workspace-tools.read_text', 'workspace-tools.write_text']) {
    const env = await sessionEnvironment(f);
    const { tools } = await (await f.query('tools.catalog')).json();
    const created = await f.command('sessions.create', { ...env.input, tools: tools.filter((tool: {
            id: string;
        }) => select.includes(tool.id)).map(({ id, definitionVersion }: {
            id: string;
            definitionVersion: string;
        }) => ({ id, definitionVersion })) });
    if (created.status !== 200)
        throw Error(await created.text());
    const session = (await created.json()).result;
    const started = await f.command('sessions.startRun', { sessionId: session.id });
    if (started.status !== 200)
        throw Error(await started.text());
    const run = (await started.json()).result;
    await waitMcp(async () => await (await f.query()).json(), value => value.sessions.some((entry: {
        session: {
            id: string;
        };
        execution: {
            state: string;
        };
    }) => entry.session.id === session.id && entry.execution.state === 'ready'));
    return { env, session, run };
}
export async function waitMcp<T>(read: () => Promise<T>, accept: (value: T) => boolean) { let value: T; const deadline = Date.now() + 10000; do {
    value = await read();
    if (accept(value))
        return value;
    await new Promise(resolve => setTimeout(resolve, 20));
} while (Date.now() < deadline); throw Error('Expected MCP state missing: ' + JSON.stringify(value!)); }
export async function calls(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string) { return (await fetch(`${f.host.url}/api/resources/tools.calls?sessionId=${sessionId}`, { headers: { Cookie: f.cookie } })).json(); }
export async function callMcp(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string, tool: string, arguments_: unknown) { const sent = await f.command('sessions.sendText', { sessionId, text: JSON.stringify({ tool, arguments: arguments_ }) }); if (sent.status !== 200)
    throw Error(await sent.text()); const turn = (await sent.json()).result; return waitMcp(() => calls(f, sessionId), value => value.calls?.some((call: {
    turnId: string;
    state: string;
}) => call.turnId === turn.id && call.state !== 'running')); }
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
export async function installConformance(options: Parameters<NonNullable<Parameters<typeof sessionHost>[1]>>[0], replaceUi = false) { const archive = join(options.directory, 'tools.aork-plugin'); const profileFile = join(options.directory, 'tools-profile.json'); options.profile.plugins.push({ id: 'tool-conformance', version: '0.1.0', enabled: true }); if (replaceUi)
    options.profile.ui.providers['aork.tools.selection@1'] = 'tool-conformance:selection'; await writeFile(profileFile, JSON.stringify(options.profile)); await promisify(execFile)(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'tests/fixtures/tool-provider', '--out', archive]); await promisify(execFile)(process.execPath, ['dist/server/main.mjs', 'plugin', 'install', archive, '--data-dir', join(options.directory, 'data'), '--distribution-dir', options.distributionDir, '--profile', profileFile]); }
