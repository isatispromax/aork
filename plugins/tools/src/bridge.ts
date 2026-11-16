import { connect } from 'node:net';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {isolatedSchemaValidators} from './schema.js';
import { framed } from './ipc.js';
import { toolDescriptorSchema, toolResultSchema } from '@aork/contracts/tools';
const endpoint = process.env.AORK_TOOL_SOCKET;
const token = process.env.AORK_RUN_TOKEN;
if (!endpoint || Buffer.byteLength(endpoint) > 90 || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    process.stderr.write('Aork tools authorization unavailable\n');
    process.exit(1);
}
const socket = connect(endpoint);
let next = 0;
let closed = false;
let tools: z.infer<typeof toolDescriptorSchema>[] = [];
let ready!: (value: void) => void;
let failed!: (reason: Error) => void;
const authenticated = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    cleanup: () => void;
}>();
function close() { if (closed)
    return; closed = true; failed(new Error('Aork tool bridge closed')); for (const entry of pending.values()) {
    entry.cleanup();
    entry.reject(new Error('Aork tool call ended without a result'));
} pending.clear(); socket.destroy(); process.stdin.destroy(); }
const frames = framed(socket, value => { const row = z.object({ kind: z.enum(['ready', 'result']), id: z.string().max(64).optional(), tools: z.array(toolDescriptorSchema).max(8).optional(), result: toolResultSchema.optional() }).strict().parse(value); if (row.kind === 'ready') {
    if (row.id || !row.tools)
        throw Error();
    tools = row.tools;
    ready();
    return;
} const request = row.id && pending.get(row.id); if (!request || !row.result)
    throw Error(); pending.delete(row.id!); request.cleanup(); request.resolve(row.result); }, close);
socket.once('connect', () => frames.send({ kind: 'auth', token }));
socket.once('close', close);
const timeout = setTimeout(close, 2000);
await authenticated;
clearTimeout(timeout);
const handle = serveStdio(() => {
    const server = new Server({ name: 'aork-run-tools', version: '0.1.0' }, { capabilities: { tools: {} },jsonSchemaValidator:isolatedSchemaValidators });
    server.setRequestHandler('tools/list', () => ({ tools: tools.map(tool => ({ name: tool.wireName, title: tool.title, description: tool.description, inputSchema: tool.inputSchema as {
                type: 'object';
            } })) }));
    server.setRequestHandler('tools/call', async (request, ctx) => { if (closed || pending.size >= 4)
        throw Error('Aork tools unavailable or busy'); const id = String(++next); return await new Promise<z.infer<typeof toolResultSchema>>((resolve, reject) => { const signal = ctx.mcpReq.signal; const cancel = () => { frames.send({ kind: 'cancel', id }); }; signal.addEventListener('abort', cancel, { once: true }); pending.set(id, { resolve: value => resolve(toolResultSchema.parse(value)), reject, cleanup: () => signal.removeEventListener('abort', cancel) }); if (!frames.send({ kind: 'call', id, tool: request.params.name, arguments: request.params.arguments ?? {} })) {
        pending.delete(id);
        signal.removeEventListener('abort', cancel);
        reject(new Error('Aork tool request could not be delivered'));
    } }); });
    return server;
});
process.stdin.once('end', () => { void handle.close(); close(); });
process.once('SIGTERM', () => { void handle.close(); close(); });
