import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { specTypeSchemas } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { TOOL_LIMITS, toolResultSchema } from '@aork/contracts/tools';
import type { ToolCallRecord, ToolContext, ToolDescriptor, ToolResult, RunToolHandle, ToolRuntimeHooks, RunToolSnapshot } from '@aork/contracts/tools';
import type { WorkspaceRunAuthority, WorkspaceRunFiles } from '@aork/contracts/workspace';
import { framed } from './ipc.js';
import { toolRepository } from './persistence/repository.js';
type Repository = ReturnType<typeof toolRepository>;
export interface ExecutableTool {
    descriptor: ToolDescriptor;
    parse: (value: unknown) => unknown;
    handler: (value: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}
const authSchema = z.object({ kind: z.literal('auth'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const requestSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('call'), id: z.string().regex(/^[1-9][0-9]{0,15}$/), tool: z.string().max(64), arguments: z.record(z.string(), z.json()) }).strict(), z.object({ kind: z.literal('cancel'), id: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict()]);
let unauthenticated = 0;
let totalExecuting = 0;
const errorResult = (code: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: `Aork tool error: ${code}` }] });
export async function openGrant(options: {
    context: ServerPluginContext;
    repository: Repository;
    snapshot: RunToolSnapshot;
    hooks: ToolRuntimeHooks;
    authority: WorkspaceRunAuthority;
    files: WorkspaceRunFiles;
    lookup: (descriptor: ToolDescriptor) => ExecutableTool;
    record: (call: ToolCallRecord) => void;
    grantChanged: (state: 'live' | 'revoked') => void;
}): Promise<RunToolHandle> {
    const { context, repository, snapshot, hooks } = options;
    let gate = true;
    let notified = false;
    const jobs = new Map<string, {
        abort: AbortController;
        done: Promise<void>;
        turnId?: string;
    }>();
    const sockets = new Set<Socket>();
    let authenticated: Socket | undefined;
    const grantCurrent = () => { const row = repository.grant(snapshot.grantId); if (!gate || row?.state !== 'live' || row.snapshot.run.hostEpoch !== context.owner.hostEpoch)
        throw new AorkError('TOOL_GRANT_REVOKED', 'Run tool authorization has ended', 409); };
    const revoke = () => { if (!gate)
        return; gate = false; for (const job of jobs.values())
        job.abort.abort(); for (const socket of sockets)
        socket.destroy(); server.close(); };
    const fail = () => { if (notified || !gate)
        return; notified = true; revoke(); try {
        options.grantChanged('revoked');
    }
    catch { } hooks.onFailure(); };
    if (!snapshot.tools.length) {
        options.grantChanged('live');
        return { revoke() { gate = false; }, async drain() { }, cancelTurn() { } };
    }
    const base = await realpath(process.platform === 'darwin' ? '/private/tmp' : '/tmp');
    const directory = await mkdtemp(`${base}/akm-${process.getuid?.() ?? 'u'}-`);
    let endpoint = `${directory}/s`;
    const server = createServer(socket => {
        if (!gate || unauthenticated >= 16) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        unauthenticated++;
        let waiting = true;
        let closed = false;
        let admitted = false;
        let lastId = 0;
        const timer = setTimeout(() => socket.destroy(), 2000);
        socket.once('close', () => { if (closed)
            return; closed = true; sockets.delete(socket); clearTimeout(timer); if (waiting)
            unauthenticated--; if (admitted)
            fail(); });
        const frames = framed(socket, value => {
            if (waiting) {
                const parsed = authSchema.safeParse(value);
                const candidate = parsed.success ? Buffer.from(parsed.data.token) : Buffer.alloc(0);
                if (!parsed.success || candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes) || authenticated) {
                    socket.destroy();
                    return;
                }
                try {
                    grantCurrent();
                    for (const descriptor of snapshot.tools)
                        options.lookup(descriptor);
                }
                catch {
                    socket.destroy();
                    return;
                }
                waiting = false;
                unauthenticated--;
                admitted = true;
                authenticated = socket;
                clearTimeout(timer);
                frames.send({ kind: 'ready', tools: snapshot.tools });
                return;
            }
            const request = requestSchema.parse(value);
            if (request.kind === 'cancel') {
                jobs.get(request.id)?.abort.abort();
                return;
            }
            const numeric = Number(request.id);
            if (!Number.isSafeInteger(numeric) || numeric <= lastId) {
                socket.destroy();
                return;
            }
            lastId = numeric;
            const result = (value: ToolResult) => frames.send({ kind: 'result', id: request.id, result: value });
            let entry: ExecutableTool;
            let args: unknown;
            let scope: {
                ready: boolean;
                turnId?: string;
            };
            try {
                grantCurrent();
                scope = hooks.currentScope();
                if (!scope.ready)
                    throw new AorkError('RUN_NOT_READY', 'Run is not ready', 409);
                if (Buffer.byteLength(JSON.stringify(request.arguments)) > TOOL_LIMITS.argumentBytes)
                    throw new AorkError('TOOL_ARGUMENTS_TOO_LARGE', 'Tool arguments exceed the byte limit', 413);
                if (jobs.size >= TOOL_LIMITS.inFlight || totalExecuting >= TOOL_LIMITS.totalInFlight)
                    throw new AorkError('TOOL_BUSY', 'Tool execution capacity is full', 409);
                const descriptor = snapshot.tools.find(tool => tool.wireName === request.tool);
                if (!descriptor)
                    throw new AorkError('TOOL_NOT_SELECTED', 'Tool was not selected for this Run', 403);
                entry = options.lookup(descriptor);
                args = entry.parse(request.arguments);
                grantCurrent();
                entry = options.lookup(descriptor);
            }
            catch (error) {
                const code = isAorkError(error) ? error.code : 'TOOL_ARGUMENTS_INVALID';
                const descriptor = snapshot.tools.find(tool => tool.wireName === request.tool);
                if (descriptor) {
                    try {
                        const scope = hooks.currentScope();
                        options.record({ id: randomUUID(), run: snapshot.run, sessionId: snapshot.sessionId, tool: { id: descriptor.id, definitionVersion: descriptor.definitionVersion }, ...(scope.turnId ? { turnId: scope.turnId } : {}), state: 'failed', cancellationRequested: false, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result: errorResult(code), errorCode: code });
                    }
                    catch {
                        fail();
                    }
                }
                result(errorResult(code));
                return;
            }
            const controller = new AbortController();
            let resolveDone!: () => void;
            const done = new Promise<void>(resolve => { resolveDone = resolve; });
            let unregister: () => void;
            try {
                unregister = hooks.registerJob(async () => { controller.abort(); await done; });
            }
            catch {
                result(errorResult('RUN_STOPPING'));
                return;
            }
            const job = { abort: controller, done, ...(scope.turnId ? { turnId: scope.turnId } : {}) };
            jobs.set(request.id, job);
            totalExecuting++;
            const record: ToolCallRecord = { id: randomUUID(), run: snapshot.run, sessionId: snapshot.sessionId, tool: { id: entry.descriptor.id, definitionVersion: entry.descriptor.definitionVersion }, ...(scope.turnId ? { turnId: scope.turnId } : {}), state: 'running', cancellationRequested: false, createdAt: new Date().toISOString() };
            // Register before either durable admission or invocation, without yielding to a stop race.
            try {
                options.record(record);
            }
            catch {
                unregister();
                jobs.delete(request.id);
                totalExecuting--;
                resolveDone();
                result(errorResult('TOOL_RECORD_FAILED'));
                fail();
                return;
            }
            let terminalRecorded=false;
            const cancelled = () => { if(terminalRecorded)return;record.cancellationRequested = true; try {
                options.record({ ...record });
            }
            catch {
                fail();
            } };
            controller.signal.addEventListener('abort', cancelled, { once: true });
            let facadeOpen = true;
            const started: Promise<unknown>[] = [];
            let ioError: unknown;
            let files: ReturnType<WorkspaceRunFiles['files']>;
            const check = () => { grantCurrent(); if (!facadeOpen || controller.signal.aborted)
                throw new AorkError('TOOL_CALL_CLOSED', 'Invocation file access has ended', 409); };
            function track<T>(operation: () => Promise<T>): Promise<T> { try {
                check();
                if (started.length >= 32)
                    throw new AorkError('TOOL_IO_LIMIT', 'Invocation file operation limit exceeded', 409);
                const task = operation();
                started.push(task);
                void task.catch(error => { ioError ??= error; });
                return task;
            }
            catch (error) {
                const task = Promise.reject<T>(error);
                void task.catch(() => { });
                return task;
            } }
            const deadline = setTimeout(() => { controller.abort(); fail(); }, 30000);
            void (async () => {
                let returned: ToolResult | undefined;
                let failure: unknown;
                try {
                    files = options.files.files(options.authority, controller.signal);
                    returned = await entry.handler(args, { signal: controller.signal, run: Object.freeze({...snapshot.run}), ...(scope.turnId ? { turnId: scope.turnId } : {}), files: { preview: (...args) => track(() => files.preview(...args)), writeText: (...args) => track(() => files.writeText(...args)) } });
                }
                catch (error) {
                    failure = error;
                }
                // Providers may start IO without awaiting it. The actual IO still owns this job and Claim.
                facadeOpen = false;
                await Promise.allSettled(started);
                failure ??= ioError;
                try {
                    let outcome: ToolResult;
                    let state: ToolCallRecord['state'];
                    let errorCode: string | undefined;
                    if (failure) {
                        errorCode = isAorkError(failure) ? failure.code : 'TOOL_HANDLER_FAILED';
                        outcome = errorResult(errorCode);
                        state = controller.signal.aborted ? 'cancelled' : 'failed';
                    }
                    else {
                        try {
                            outcome = toolResultSchema.parse(returned);
                            const validated = await specTypeSchemas.CallToolResult['~standard'].validate(outcome);
                            if (validated.issues)
                                throw Error();
                            if (Buffer.byteLength(JSON.stringify(outcome)) > TOOL_LIMITS.resultBytes)
                                throw Error();
                            state = outcome.isError ? 'failed' : 'succeeded';
                        }
                        catch {
                            errorCode = 'TOOL_RESULT_INVALID';
                            outcome = errorResult(errorCode);
                            state = 'failed';
                        }
                    }
                    const finished = { ...record, state, result: outcome, cancellationRequested: controller.signal.aborted, finishedAt: new Date().toISOString(), ...(errorCode ? { errorCode } : {}) };
                    options.record(finished);
                    terminalRecorded=true;
                    result(outcome);
                }
                catch {
                    try {
                        options.record({ ...record, state: 'unknown', cancellationRequested: controller.signal.aborted, finishedAt: new Date().toISOString(), errorCode: 'TOOL_FINALIZATION_UNKNOWN' });terminalRecorded=true;
                    }
                    catch { }
                    fail();
                }
                finally {
                    clearTimeout(deadline);
                    controller.signal.removeEventListener('abort', cancelled);
                    unregister();
                    jobs.delete(request.id);
                    totalExecuting--;
                    resolveDone();
                }
            })().catch(() => { fail(); });
        }, () => socket.destroy());
    });
    const token = randomBytes(32).toString('base64url');
    const tokenBytes = Buffer.from(token);
    try {
        await chmod(directory, 0o700);
        const parent = await lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700 || Buffer.byteLength(endpoint) > 90)
            throw Error();
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(); }); });
        await chmod(endpoint, 0o600);
        const socket = await lstat(endpoint);
        if (!socket.isSocket() || (socket.mode & 0o777) !== 0o600)
            throw Error();
        options.grantChanged('live');
    }
    catch {
        gate = false;
        for (const socket of sockets)
            socket.destroy();
        server.close();
        await rm(directory, { recursive: true, force: true });
        throw new AorkError('TOOL_BRIDGE_FAILED', 'Protected local tool bridge could not start', 409);
    }
    server.on('error', fail);
    let drainTask: Promise<void> | undefined;
    return { descriptor: { command: process.execPath, args: [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], env: [{ name: 'AORK_TOOL_SOCKET', value: endpoint }, { name: 'AORK_RUN_TOKEN', value: token }] }, revoke,
        drain() { revoke(); return drainTask ??= (async () => { await Promise.all([...jobs.values()].map(job => job.done)); for (const socket of sockets)
            socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); })(); },
        cancelTurn(turnId) { for (const job of jobs.values())
            if (job.turnId === turnId)
                job.abort.abort(); } };
}
