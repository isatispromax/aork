import { randomUUID, createHash } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import { runtimeTurnFactSchema, type RuntimeTurnFact } from '@aork/contracts/runtime';
import { permissionFactSchema, permissionSchema, type PermissionInteraction } from '@aork/contracts/interaction';
import { sendTextSchema, type Turn } from '@aork/contracts/session';
import type { Operation, operationRepository, PromptOperation } from './persistence/repository.js';
type Repository = ReturnType<typeof operationRepository>;
type TurnFactValue = { [Kind in RuntimeTurnFact['kind']]: Omit<Extract<RuntimeTurnFact, {kind:Kind}>, 'runId'|'generation'|'hostEpoch'|'turnId'> }[RuntimeTurnFact['kind']];
type PermissionContext = Parameters<acp.ClientRequestHandlersByMethod[typeof acp.methods.client.session.requestPermission]>[0];
type Update = Parameters<acp.ClientNotificationHandlersByMethod[typeof acp.methods.client.session.update]>[0]['params'];
interface Channel {
    value: PermissionInteraction;
    settle: () => void;
    dispose: () => void;
}
interface LiveTurn {
    op: Operation;
    agent: acp.ClientContext;
    nativeSessionId: string;
    stop: (reason: string) => Promise<void>;
    tail: Promise<void>;
    pendingBytes: number;
    pendingFrames: number;
    active?: string;
    sequence: number;
    channels: Map<string, Channel>;
    closed: boolean;
    failed: boolean;
    invalidations: PermissionInteraction[];
    stopOutcome?: {
        confirmed: boolean;
        reason: string;
    };
    stopExpected?: string;
    cancelSent?: string;
    cancelTimer?: ReturnType<typeof setTimeout>;
    prompt?: Promise<void>;
    tools: Map<string, RuntimeTurnFact & {
        kind: 'tool';
    }>;
}
const active = (op: PromptOperation) => op.state !== 'terminal';
function displayText(value: string) {
    let text = ''; let bytes = 2;
    for (const point of value) {
        const size = Buffer.byteLength(JSON.stringify(point)) - 2;
        if (bytes + size > 8000 || text.length + point.length > 4000) break;
        text += point; bytes += size;
    }
    return text;
}
/** No deferred, SDK context or live process authority crosses this owner boundary. */
export function turnEngine(context: ServerPluginContext, repository: Repository) {
    const facts = context.factStream('turns', runtimeTurnFactSchema);
    const permissions = context.factStream('permissions', permissionFactSchema);
    const runs = new Map<string, LiveTurn>();
    const base = (op: PromptOperation) => ({ runId: op.runId, generation: op.generation, hostEpoch: op.hostEpoch, turnId: op.turnId });
    function append(tx: SyncTransaction, op: PromptOperation, value: TurnFactValue) { facts.append(tx, op.turnId, { ...base(op), ...value }); }
    function fatal(run: LiveTurn, reason='Critical Turn persistence failed; managed execution was stopped.') { if (run.failed)
        return; run.failed = true; run.closed = true; invalidate(run, 'Persistence failed; response channel is closed.'); void run.stop(reason).catch(() => { }); }
    // SDK invokes handlers concurrently. This short ordered lane contains persistence only,
    // never a permission resolver or the lifetime of a prompt.
    function ingest(run: LiveTurn, bytes: number, apply: () => void) {
        if (run.pendingBytes + bytes > 256 * 1024 || run.pendingFrames >= 256) {
            fatal(run,'Agent output exceeded bounded ingestion capacity; managed execution was stopped.');
            return Promise.resolve();
        }
        run.pendingBytes += bytes;
        run.pendingFrames++;
        const task = run.tail.then(() => apply());
        run.tail = task.catch(() => fatal(run)).finally(() => { run.pendingBytes -= bytes; run.pendingFrames--; });
        return run.tail;
    }
    function progress(tx: SyncTransaction, prompt: PromptOperation) { repository.updatePrompt(tx, { ...prompt, state: 'running', progress: true }); if (!prompt.progress)
        append(tx, prompt, { kind: 'state', state: 'running' }); }
    function current(run: LiveTurn, tx?: SyncTransaction) { if (!run.active)
        return; const op = repository.prompt(run.active, tx); return op && active(op) && op.generation === run.op.launch.run.generation ? op : undefined; }
    function flushInvalidations(run: LiveTurn) { if (!run.invalidations.length)
        return; const pending = [...run.invalidations]; context.transactions.run(tx => { for (const value of pending)
        permissions.append(tx, value.id, { principal: run.op.launch.principal, interaction: value }); }); run.invalidations.splice(0, pending.length); }
    function invalidate(run: LiveTurn, reason: string) {
        const channels = [...run.channels.values()];
        run.channels.clear();
        for (const channel of channels) {
            channel.dispose();
            channel.settle();
            const value = { ...channel.value, state: 'invalidated' as const, reason };
            run.invalidations.push(value);
            void ingest(run, 1000, () => flushInvalidations(run));
        }
    }
    function terminal(run: LiveTurn, state: Turn['state'], reason?: string, stopReason?: string) { context.transactions.run(tx => { const op = current(run, tx); if (!op)
        return; repository.updatePrompt(tx, { ...op, state: 'terminal' }); append(tx, op, { kind: 'state', state, ...(reason ? { reason } : {}), ...(stopReason ? { stopReason } : {}) }); }); if (run.cancelTimer)
        clearTimeout(run.cancelTimer); delete run.cancelTimer; delete run.active; delete run.cancelSent; run.tools.clear(); invalidate(run, 'Prompt finished; response channel is closed.'); }
    // Before listeners: old attempted work is classified from durable attributable progress;
    // accepted/pending input is retained and paused by Sessions, never resent.
    context.transactions.run(tx => { for (const op of repository.prompts(tx)) {
        if (!active(op) || op.hostEpoch === context.owner.hostEpoch)
            continue;
        repository.updatePrompt(tx, { ...op, state: 'terminal' });
        append(tx, op, { kind: 'state', dispatchPaused: true, state: op.state === 'pending' ? 'accepted' : op.progress ? 'interrupted' : 'delivery_unknown', reason: 'Host restarted before a definitive prompt result; no input is automatically resent.' });
    } });
    return {
        facts: facts.source, permissions: permissions.source,
        ready(op: Operation, agent: acp.ClientContext, nativeSessionId: string, stop: LiveTurn['stop']) { runs.set(op.launch.run.runId, { op, agent, nativeSessionId, stop, tail: Promise.resolve(), pendingBytes: 0, pendingFrames: 0, sequence: 0, channels: new Map(), closed: false, failed: false, invalidations: [], tools: new Map() }); },
        accept(tx: SyncTransaction, owner: OwnerDescriptor, input: {
            turnId: string;
            runId: string;
            generation: number;
            text: string;
        }) {
            context.verifyOwner(owner);
            sendTextSchema.parse({ sessionId: repository.get(input.runId, tx)?.launch.run.sessionId, text: input.text });
            const run = repository.get(input.runId, tx);
            if (!run || runs.get(input.runId)?.closed || run.state !== 'ready' || run.stopRequested || run.launch.owner.pluginId !== owner.pluginId || run.launch.run.generation !== input.generation || run.launch.run.hostEpoch !== context.owner.hostEpoch || !runs.has(input.runId))
                throw new AorkError('RUN_NOT_READY', 'Run is unavailable for prompt dispatch', 409);
            if (repository.prompts(tx).some(op => op.runId === input.runId && active(op)))
                throw new AorkError('SESSION_TURN_ACTIVE', 'Run already has an active prompt', 409);
            repository.insertPrompt(tx, { ...input, hostEpoch: context.owner.hostEpoch, state: 'pending', progress: false, cancelRequested: false });
        },
        cancel(tx: SyncTransaction, owner: OwnerDescriptor, turnId: string) { context.verifyOwner(owner); const op = repository.prompt(turnId, tx); const run = op && repository.get(op.runId, tx); if (!op || !run || run.launch.owner.pluginId !== owner.pluginId || op.hostEpoch !== context.owner.hostEpoch)
            throw new AorkError('TURN_UNAVAILABLE', 'Turn has no current live response channel', 409); if (active(op))
            repository.updatePrompt(tx, { ...op, cancelRequested: true }); },
        update(op: Operation, params: Update) {
            const run = runs.get(op.launch.run.runId);
            if (!run || run.closed || params.sessionId !== run.nativeSessionId || !run.active)
                return;
            const update = params.update;
            if (update.sessionUpdate === 'agent_message_chunk') {
                const text = update.content.type === 'text' ? update.content.text : '[Unsupported Agent content]';
                let chunk = '';
                let bytes = 0;
                const flush = () => { if (!chunk)
                    return; const saved = chunk; chunk = ''; bytes = 0; const sequence = ++run.sequence; void ingest(run, Buffer.byteLength(JSON.stringify(saved)) + 1000, () => context.transactions.run(tx => { const prompt = current(run, tx); if (!prompt)
                    return; progress(tx, prompt); append(tx, prompt, { kind: 'text', sequence, text: saved, ...('messageId' in update && typeof update.messageId === 'string' ? { messageId: update.messageId.slice(0, 200) } : {}) }); })); };
                for (const point of text) {
                    const size = Buffer.byteLength(JSON.stringify(point));
                    if (bytes + size > 8000 || chunk.length + point.length > 4000)
                        flush();
                    chunk += point;
                    bytes += size;
                }
                flush();
            }
            else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
                const id = update.toolCallId.length <= 200 ? update.toolCallId : `long:${createHash('sha256').update(update.toolCallId).digest('hex')}`;
                if (run.tools.size >= 2000 && !run.tools.has(id)) {
                    fatal(run);
                    return;
                }
                const prior = run.tools.get(id)?.tool;
                const text = update.content ? displayText(update.content.map(item => item.type === 'content' && item.content.type === 'text' ? item.content.text : '[Unsupported tool content]').join('\n')) : prior?.text;
                const tool = { turnId: run.active, toolCallId: id, title: ('title' in update && typeof update.title === 'string' ? update.title : prior?.title ?? 'Agent tool report').slice(0, 500), status: update.status ?? prior?.status ?? 'pending', ...(text !== undefined ? { text } : {}), ...('kind' in update && typeof update.kind === 'string' ? { kind: update.kind.slice(0, 50) } : prior?.kind ? { kind: prior.kind } : {}) };
                const fact = { ...base(repository.prompt(run.active)!), kind: 'tool' as const, tool };
                run.tools.set(id, fact);
                void ingest(run, Buffer.byteLength(JSON.stringify(fact)) + 1000, () => context.transactions.run(tx => { const prompt = current(run, tx); if (!prompt)
                    return; progress(tx, prompt); facts.append(tx, prompt.turnId, fact); }));
            }
            else if (update.sessionUpdate === 'usage_update') {
                const usage = { used: update.used, size: update.size, ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}) };
                void ingest(run, 1000, () => context.transactions.run(tx => { const prompt = current(run, tx); if (prompt)
                    append(tx, prompt, { kind: 'usage', usage }); }));
            }
        },
        permission(op: Operation, ctx: PermissionContext, stop:(reason:string)=>Promise<void>): Promise<acp.RequestPermissionResponse> {
            const run = runs.get(op.launch.run.runId);
            if(ctx.signal.aborted||run?.closed)return Promise.resolve({outcome:{outcome:'cancelled'}});
            const reject=(reason:string)=>{if(run){run.failed=true;run.closed=true;invalidate(run,reason);}void stop(reason).catch(()=>{});return Promise.resolve<acp.RequestPermissionResponse>({outcome:{outcome:'cancelled'}});};
            const prompt = run && current(run);
            if(!run||!prompt||ctx.params.sessionId!==run.nativeSessionId||ctx.requestId===undefined)return reject('Unsolicited Agent permission request closed its managed connection.');
            if(repository.get(prompt.runId)?.stopRequested||prompt.cancelRequested)return Promise.resolve({outcome:{outcome:'cancelled'}});
            const requestId=ctx.requestId;const key=JSON.stringify([typeof requestId,requestId]);
            if(run.channels.has(key)||run.channels.size>=16)return reject('Agent permission channel limit exceeded; managed execution was stopped.');
            const candidate = permissionSchema.safeParse({ id: randomUUID(), sessionId: op.launch.run.sessionId, runId: prompt.runId, generation: prompt.generation, hostEpoch: prompt.hostEpoch, turnId: prompt.turnId, nativeSessionId: run.nativeSessionId, requestId, title: Array.from(ctx.params.toolCall.title ?? 'Agent permission request').slice(0, 250).join(''), options: ctx.params.options.map(option => ({ optionId: option.optionId, name: Array.from(option.name).slice(0, 100).join(''), kind: option.kind })), state: 'pending' });
            if (!candidate.success)return reject('Agent permission request exceeded supported bounds; managed execution was stopped.');
            const value = candidate.data;
            const factBytes = Buffer.byteLength(JSON.stringify({ principal: op.launch.principal, interaction: value }));
            if (factBytes > 24000)return reject('Agent permission request exceeded durable bounds; managed execution was stopped.');
            return new Promise(resolve => {
                let settled = false;
                const settle = () => { if (!settled) {
                    settled = true;
                    resolve({ outcome: { outcome: 'cancelled' } });
                } };
                const abort = () => { if (run.channels.get(key) !== channel)
                    return; run.channels.delete(key); channel.dispose(); settle(); void ingest(run, 1000, () => context.transactions.run(tx => permissions.append(tx, value.id, { principal: op.launch.principal, interaction: { ...value, state: 'invalidated', reason: 'Agent response channel disconnected or was cancelled.' } }))); };
                const channel: Channel = { value, settle, dispose: () => ctx.signal.removeEventListener('abort', abort) };
                run.channels.set(key, channel);
                ctx.signal.addEventListener('abort', abort, { once: true });
                void ingest(run, factBytes + 4000, () => context.transactions.run(tx => { const currentPrompt = current(run, tx); if (!currentPrompt || currentPrompt.cancelRequested || run.closed || settled)
                    return; progress(tx, currentPrompt); permissions.append(tx, value.id, { principal: op.launch.principal, interaction: value }); }));
            });
        },
        tick() {
            for (const prompt of repository.prompts()) {
                if (!active(prompt) || prompt.hostEpoch !== context.owner.hostEpoch)
                    continue;
                const run = runs.get(prompt.runId);
                if (!run || run.closed)
                    continue;
                if (prompt.state === 'pending' && !run.active) {
                    run.active = prompt.turnId;
                    run.sequence = 0;
                    run.tools.clear();
                    try {
                        const initiated = context.transactions.run(tx => { const latest = repository.prompt(prompt.turnId, tx)!; const parent = repository.get(prompt.runId, tx); if (!parent || parent.stopRequested || parent.state !== 'ready') {
                            repository.updatePrompt(tx, { ...latest, state: 'terminal' });
                            append(tx, latest, { kind: 'state', state: 'cancelled', reason: 'Run ended before prompt delivery.' });
                            return false;
                        } repository.updatePrompt(tx, { ...latest, state: 'attempting' }); append(tx, latest, { kind: 'state', state: latest.cancelRequested ? 'cancelling' : 'dispatching' }); return true; });
                        if (!initiated) {
                            delete run.active;
                            continue;
                        }
                        if (prompt.cancelRequested) {
                            void ingest(run, 1000, () => terminal(run, 'cancelled', 'Cancelled before prompt delivery.'));
                            continue;
                        }
                        const response = run.agent.request(acp.methods.agent.session.prompt, { sessionId: run.nativeSessionId, prompt: [{ type: 'text', text: prompt.text }] });
                        run.prompt = response.then(result => ingest(run, 1000, () => terminal(run, result.stopReason === 'cancelled' ? 'cancelled' : 'completed', undefined, result.stopReason)), error => ingest(run, 1000, () => { if (error instanceof acp.RequestError) {
                            terminal(run, 'failed', `Agent returned a definitive prompt error (code ${error.code}).`);
                            return;
                        } if (run.stopExpected)
                            return; const latest = current(run); if (latest)
                            terminal(run, latest.progress ? 'interrupted' : 'delivery_unknown', 'Agent connection lost before a definitive prompt result. No input is automatically resent.'); })).then(() => { }).catch(() => fatal(run));
                    }
                    catch {
                        fatal(run);
                    }
                }
                if (prompt.cancelRequested && run.active === prompt.turnId && run.cancelSent !== prompt.turnId) {
                    run.cancelSent = prompt.turnId;
                    invalidate(run, 'Turn cancellation closed the response channel.');
                    void run.tail.then(() => run.agent.notify(acp.methods.agent.session.cancel, { sessionId: run.nativeSessionId })).catch(() => { });
                    run.cancelTimer = setTimeout(() => { if (run.active === prompt.turnId) {
                        run.stopExpected = 'Cancellation grace expired; managed execution was stopped.';
                        void run.stop(run.stopExpected);
                    } }, 1500);
                }
            }
        },
        revoke(runId: string, reason: string) { const run = runs.get(runId); if (!run)
            return; run.closed = true; run.stopExpected = reason; invalidate(run, reason); if (run.cancelTimer)
            clearTimeout(run.cancelTimer); },
        async stopped(runId: string, confirmed: boolean, reason: string) { const run = runs.get(runId); if (!run)
            return; run.stopOutcome = { confirmed, reason }; await run.prompt; await run.tail; await ingest(run, 1000, () => { flushInvalidations(run); const prompt = current(run); if (prompt)
            terminal(run, confirmed && prompt.cancelRequested ? 'cancelled' : prompt.progress ? 'interrupted' : 'delivery_unknown', reason); }); if (confirmed && !run.active && !run.invalidations.length)
            runs.delete(runId); },
        flushStopped() { for (const [runId, run] of runs) {
            const outcome = run.stopOutcome;
            if (!outcome)
                continue;
            flushInvalidations(run);
            const prompt = current(run);
            if (prompt)
                terminal(run, outcome.confirmed && prompt.cancelRequested ? 'cancelled' : prompt.progress ? 'interrupted' : 'delivery_unknown', outcome.reason);
            if (outcome.confirmed && !run.active)
                runs.delete(runId);
        } },
        async drain() { for (const run of runs.values())
            await run.tail; },
    };
}
