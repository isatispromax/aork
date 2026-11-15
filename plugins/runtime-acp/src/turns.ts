import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import { runtimeTurnFactSchema, type RuntimeTurnFact } from '@aork/contracts/runtime';
import { permissionFactSchema, permissionSchema, type PermissionInteraction } from '@aork/contracts/interaction';
import { promptContentSchema } from '@aork/contracts/input';
import type { PromptContent,NegotiatedInput } from '@aork/contracts/input';
import { structuredInputSchema, structuredInputFactSchema, inputDiagnosticFactSchema, inputSubmissionSchema, validateInputContent, nativeInputRequestSchema, type StructuredInput, type InputSubmission } from '@aork/contracts/structured-input';
import { sendTextSchema, type Turn } from '@aork/contracts/session';
import type { Operation, operationRepository, PromptOperation, ResponseOperation } from './persistence/repository.js';
type Repository = ReturnType<typeof operationRepository>;
type TurnFactValue = { [Kind in RuntimeTurnFact['kind']]: Omit<Extract<RuntimeTurnFact, {kind:Kind}>, 'runId'|'generation'|'hostEpoch'|'turnId'> }[RuntimeTurnFact['kind']];
type PermissionContext = Parameters<acp.ClientRequestHandlersByMethod[typeof acp.methods.client.session.requestPermission]>[0];
type Update = Parameters<acp.ClientNotificationHandlersByMethod[typeof acp.methods.client.session.update]>[0]['params'];
type Interaction=PermissionInteraction|StructuredInput;
type InputContext=acp.ClientRequestContext<unknown>;
interface Channel {
    value: Interaction;
    settle: () => void;
    respond: (response:ResponseOperation) => void;
    response?: ResponseOperation;
    writeStarted?: boolean;
    invalidated?: boolean;
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
    outbound: Map<string, Channel>;
    inputDiagnostic?:boolean;
    closed: boolean;
    failed: boolean;
    invalidations: Interaction[];
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
export function turnEngine(context: ServerPluginContext, repository: Repository, admissionOpen:()=>boolean) {
    const facts = context.factStream('turns', runtimeTurnFactSchema);
    const permissions = context.factStream('permissions', permissionFactSchema);
    const diagnostics=context.factStream('inputDiagnostics',inputDiagnosticFactSchema);
    const inputs = context.factStream('inputs', structuredInputFactSchema);
    function emit(tx:SyncTransaction,id:string,payload:{principal:string;interaction:Interaction}){if('kind' in payload.interaction)inputs.append(tx,id,{principal:payload.principal,interaction:payload.interaction});else permissions.append(tx,id,{principal:payload.principal,interaction:payload.interaction});}
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
        emit(tx, value.id, { principal: run.op.launch.principal, interaction: value }); }); run.invalidations.splice(0, pending.length); }
    function responseValue(channel:Channel,state:Interaction['state'],reason?:string):Interaction {const value=channel.value;return {...value,...(channel.response?('kind' in value?{selectedAction:channel.response.submission?.action}:{selectedOptionId:channel.response.optionId}):{}),state,...(reason?{reason}:{})};}
    function finishResponse(run:LiveTurn,channel:Channel,state:Interaction['state'],reason?:string) {
        const value=responseValue(channel,state,reason);
        context.transactions.run(tx=>{if(channel.response)repository.putResponse(tx,{...channel.response,state:'terminal',interaction:value});emit(tx,value.id,{principal:run.op.launch.principal,interaction:value});});
    }
    function responseMatches(channel:Channel,response:ResponseOperation){
        const live=channel.value;const saved=response.interaction;
        if(live.id!==saved.id||live.runId!==saved.runId||live.sessionId!==saved.sessionId||live.turnId!==saved.turnId||live.generation!==saved.generation||live.hostEpoch!==saved.hostEpoch||live.nativeSessionId!==saved.nativeSessionId||typeof live.requestId!==typeof saved.requestId||live.requestId!==saved.requestId)return false;
        return 'kind' in live?'kind' in saved&&response.optionId===undefined&&response.submission!==undefined&&validInput(live,response.submission):!('kind' in saved)&&response.submission===undefined&&live.options.some(option=>option.optionId===response.optionId);
    }
    function responseOpen(run:LiveTurn,channel:Channel) {
        const parent=repository.get(run.op.launch.run.runId);const prompt=current(run);
        return admissionOpen()&&!run.closed&&!run.failed&&!channel.invalidated&&parent?.state==='ready'&&!parent.stopRequested&&prompt&&!prompt.cancelRequested&&prompt.turnId===channel.value.turnId&&prompt.generation===channel.value.generation&&prompt.hostEpoch===channel.value.hostEpoch&&channel.value.nativeSessionId===run.nativeSessionId&&(!channel.response||responseMatches(channel,channel.response));
    }
    function validInput(value:StructuredInput,submission:InputSubmission){const parsed=inputSubmissionSchema.safeParse(submission);return parsed.success&&(parsed.data.action!=='accept'||!Object.keys(validateInputContent(value.requestedSchema,parsed.data.content)).length);}
    function dispatchResponses() {
        for(const response of repository.responses()) {
            if(response.state!=='pending'||response.interaction.hostEpoch!==context.owner.hostEpoch)continue;
            const value=response.interaction;const run=runs.get(value.runId);const channel=run?.channels.get(JSON.stringify([typeof value.requestId,value.requestId]));
            if(!run||!channel||!responseMatches(channel,response)||!responseOpen(run,channel)) {
                const invalid={...value,state:'cancelled' as const,...('kind' in value?{selectedAction:response.submission?.action}:{selectedOptionId:response.optionId}),reason:'The response channel closed before delivery.'};
                context.transactions.run(tx=>{repository.putResponse(tx,{...response,state:'terminal',interaction:invalid});emit(tx,value.id,{principal:repository.get(value.runId,tx)!.launch.principal,interaction:invalid});});continue;
            }
            // A durable attempt precedes resolving the SDK handler. Its response may
            // still be queued, so the physical writer rechecks the gate once more.
            context.transactions.run(tx=>repository.putResponse(tx,{...response,state:'attempting'}));
            channel.response={...response,state:'attempting'};run.outbound.set(JSON.stringify([typeof value.requestId,value.requestId]),channel);channel.respond(response);
        }
    }
    function invalidate(run: LiveTurn, reason: string) {
        const channels = [...run.channels.values()];
        run.channels.clear();
        for (const channel of channels) {
            channel.invalidated=true;
            channel.dispose();
            channel.settle();
            const value = responseValue(channel,channel.writeStarted||channel.response&&!reason.toLowerCase().includes('cancel')?'delivery_unknown':reason.toLowerCase().includes('cancel')?'cancelled':'expired', reason);
            if(channel.response)context.transactions.run(tx=>repository.putResponse(tx,{...channel.response!,state:'terminal',interaction:value}));
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
    function inputFailure(parent:Operation,input:{content?:PromptContent[];text:string;configurationRevision?:number|undefined;configuration?:NegotiatedInput|undefined}){
        if(parent.launch.run.negotiated?.revision!==input.configurationRevision||!isDeepStrictEqual(parent.launch.run.negotiated,input.configuration)||parent.launch.run.configuration&&['accepted','dispatching','delivery_unknown'].includes(parent.launch.run.configuration.state))return 'Run configuration changed before input dispatch. Submit a new input using the current Run options.';
        const parsed=promptContentSchema.array().min(1).max(5).safeParse(input.content??[{type:'text',text:input.text}]);if(!parsed.success||Buffer.byteLength(JSON.stringify(parsed.data))>512*1024)return 'Captured input no longer satisfies supported prompt bounds.';
        for(const block of parsed.data){const capabilities=parent.launch.run.negotiated?.prompt;if(block.type==='image'?!capabilities?.image:block.type==='audio'?!capabilities?.audio:block.type==='resource'?!capabilities?.embeddedContext:false)return 'Run does not support the captured prompt content.';}
    }
    context.transactions.run(tx=>{for(const response of repository.responses(tx)){if(response.state==='terminal'||response.interaction.hostEpoch===context.owner.hostEpoch)continue;const value={...response.interaction,state:response.state==='attempting'?'delivery_unknown' as const:'expired' as const,...('kind' in response.interaction?{selectedAction:response.submission?.action}:{selectedOptionId:response.optionId}),reason:'Host restarted; interaction responses are never automatically resent.'};repository.putResponse(tx,{...response,state:'terminal',interaction:value});emit(tx,value.id,{principal:repository.get(value.runId,tx)!.launch.principal,interaction:value});}});
    return {
        response(tx:SyncTransaction,owner:OwnerDescriptor,principal:string,value:PermissionInteraction,optionId:string) {
            context.verifyOwner(owner);const op=repository.get(value.runId,tx);
            if(!op||op.launch.owner.serviceOwners['aork.interactions@1']?.pluginId!==owner.pluginId||op.launch.principal!==principal)throw new AorkError('INTERACTION_OWNER_INVALID','Only the selected Interaction owner can admit a response',409);
            if(value.hostEpoch!==context.owner.hostEpoch||value.generation!==op.launch.run.generation||value.sessionId!==op.launch.run.sessionId||!value.options.some(option=>option.optionId===optionId))throw new AorkError('INTERACTION_CLOSED','The response context is no longer current',409);
            if(repository.responses(tx).some(response=>response.interaction.id===value.id))throw new AorkError('INTERACTION_CLOSED','A response was already admitted',409);
            repository.putResponse(tx,{interaction:value,optionId,state:'pending'});
        },
        inputResponse(tx:SyncTransaction,owner:OwnerDescriptor,principal:string,value:StructuredInput,submission:InputSubmission){
            context.verifyOwner(owner);const op=repository.get(value.runId,tx);
            if(!op||op.launch.owner.serviceOwners['aork.interactions@1']?.pluginId!==owner.pluginId||op.launch.principal!==principal)throw new AorkError('INTERACTION_OWNER_INVALID','Only the selected Interaction owner can admit a response',409);
            if(value.hostEpoch!==context.owner.hostEpoch||value.generation!==op.launch.run.generation||value.sessionId!==op.launch.run.sessionId||!validInput(value,submission))throw new AorkError('INTERACTION_CLOSED','The response context is no longer current',409);
            if(repository.responses(tx).some(response=>response.interaction.id===value.id))throw new AorkError('INTERACTION_CLOSED','A response was already admitted',409);
            repository.putResponse(tx,{interaction:value,submission,state:'pending'});
        },
        beforeResponse(op:Operation,id:unknown,message:Record<string,unknown>) {
            const run=runs.get(op.launch.run.runId);const key=JSON.stringify([typeof id,id]);const channel=run?.outbound.get(key);
            if(!run||!channel?.response){const result=message.result as {outcome?:{outcome?:string};action?:string}|undefined;return result?.outcome?.outcome==='selected'?{...message,result:{outcome:{outcome:'cancelled'}}}:result?.action==='accept'||result?.action==='decline'?{...message,result:{action:'cancel'}}:message;}
            if(!responseOpen(run,channel)) {if(!channel.invalidated){channel.invalidated=true;finishResponse(run,channel,'cancelled','Cancellation or connection change closed the response before writing.');}return {...message,result:'kind' in channel.value?{action:'cancel'}:{outcome:{outcome:'cancelled'}}};}
            channel.writeStarted=true;return message;
        },
        responseWritten(op:Operation,id:unknown,success:boolean) {
            const run=runs.get(op.launch.run.runId);const key=JSON.stringify([typeof id,id]);const channel=run?.outbound.get(key);
            if(!run||!channel?.response)return;
            run.channels.delete(key);run.outbound.delete(key);channel.dispose();
            if(!channel.invalidated)finishResponse(run,channel,success?'responded':channel.response?'delivery_unknown':'expired',success?undefined:'Interaction response delivery is uncertain; it will not be resent.');
        },
        facts: facts.source, permissions: permissions.source, inputs:inputs.source, diagnostics:diagnostics.source,
        ready(op: Operation, agent: acp.ClientContext, nativeSessionId: string, stop: LiveTurn['stop']) { runs.set(op.launch.run.runId, { op, agent, nativeSessionId, stop, tail: Promise.resolve(), pendingBytes: 0, pendingFrames: 0, sequence: 0, channels: new Map(), outbound:new Map(), closed: false, failed: false, invalidations: [], tools: new Map() }); },
        accept(tx: SyncTransaction, owner: OwnerDescriptor, input: {
            turnId: string;
            runId: string;
            generation: number;
            text: string;content:PromptContent[];configurationRevision?:number|undefined;configuration?:NegotiatedInput|undefined;
        }) {
            context.verifyOwner(owner);
            sendTextSchema.parse({ sessionId: repository.get(input.runId, tx)?.launch.run.sessionId, text: input.text });
            const run = repository.get(input.runId, tx);
            if (!run || runs.get(input.runId)?.closed || run.state !== 'ready' || run.stopRequested || run.launch.owner.pluginId !== owner.pluginId || run.launch.run.generation !== input.generation || run.launch.run.hostEpoch !== context.owner.hostEpoch || !runs.has(input.runId))
                throw new AorkError('RUN_NOT_READY', 'Run is unavailable for prompt dispatch', 409);
            if (repository.prompts(tx).some(op => op.runId === input.runId && active(op)))
                throw new AorkError('SESSION_TURN_ACTIVE', 'Run already has an active prompt', 409);
            const failure=inputFailure(run,input);
            if(failure){const failed={...input,hostEpoch:context.owner.hostEpoch,state:'terminal' as const,progress:false,cancelRequested:false};repository.insertPrompt(tx,failed);append(tx,failed,{kind:'state',state:'failed',reason:failure});return;}
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
            if(new Set(value.options.map(option=>option.optionId)).size!==value.options.length)return reject('Agent permission options have duplicate identities; managed execution was stopped.');
            const factBytes = Buffer.byteLength(JSON.stringify({ principal: op.launch.principal, interaction: value }));
            if (factBytes > 24000)return reject('Agent permission request exceeded durable bounds; managed execution was stopped.');
            return new Promise(resolve => {
                let settled = false;
                const settle = () => { if (!settled) {
                    settled = true;
                    resolve({ outcome: { outcome: 'cancelled' } });
                } };
                const abort = () => { if (run.channels.get(key) !== channel)
                    return; run.channels.delete(key); channel.invalidated=true; channel.dispose(); settle(); if(channel.response)context.transactions.run(tx=>repository.putResponse(tx,{...channel.response!,state:'terminal',interaction:responseValue(channel,channel.response?'delivery_unknown':'expired','Agent response channel disconnected or was cancelled.')})); void ingest(run, 1000, () => context.transactions.run(tx => emit(tx, value.id, { principal: op.launch.principal, interaction: { ...value, state: channel.response?'delivery_unknown':'expired', reason: 'Agent response channel disconnected or was cancelled.' } }))); };
                const channel: Channel = { value, settle, respond(response){if(!settled&&response.optionId!==undefined){settled=true;resolve({outcome:{outcome:'selected',optionId:response.optionId}});}}, dispose: () => ctx.signal.removeEventListener('abort', abort) };
                run.channels.set(key, channel);
                ctx.signal.addEventListener('abort', abort, { once: true });
                void ingest(run, factBytes + 4000, () => context.transactions.run(tx => { const currentPrompt = current(run, tx); if (!currentPrompt || currentPrompt.cancelRequested || run.closed || settled)
                    return; progress(tx, currentPrompt); emit(tx, value.id, { principal: op.launch.principal, interaction: value }); }));
            });
        },
        input(op:Operation,ctx:InputContext,stop:(reason:string)=>Promise<void>):Promise<acp.CreateElicitationResponse>{
            const run=runs.get(op.launch.run.runId);const prompt=run&&current(run);
            const parsed=nativeInputRequestSchema.safeParse(ctx.params);
            if(!parsed.success){
                if(run&&prompt&&!run.inputDiagnostic){run.inputDiagnostic=true;const diagnostic={id:randomUUID(),sessionId:op.launch.run.sessionId,...base(prompt),code:'INPUT_UNSUPPORTED' as const,message:'此 Agent 请求超出当前工作表单能力；认证、URL 或未知字段约束未启用。' as const};void ingest(run,1000,()=>context.transactions.run(tx=>diagnostics.append(tx,diagnostic.id,{principal:op.launch.principal,diagnostic})));}
                throw acp.RequestError.invalidParams(undefined,'Aork supports bounded non-sensitive Session work forms only; URL, request scope, unknown fields or constraints are unsupported');
            }
            const params=parsed.data;
            if(ctx.signal.aborted||run?.closed)return Promise.resolve({action:'cancel'});
            if(!run||!prompt||params.sessionId!==run.nativeSessionId||ctx.requestId===undefined)throw acp.RequestError.invalidParams(undefined,'Only a current Session work form is supported');
            if(repository.get(prompt.runId)?.stopRequested||prompt.cancelRequested)return Promise.resolve({action:'cancel'});
            const requestId=ctx.requestId;const key=JSON.stringify([typeof requestId,requestId]);
            if(run.channels.has(key)||run.channels.size>=16){void stop('Agent response channel limit exceeded; managed execution was stopped.');throw acp.RequestError.invalidParams(undefined,'Response channel limit exceeded');}
            const value=structuredInputSchema.parse({id:randomUUID(),kind:'structured',sessionId:op.launch.run.sessionId,runId:prompt.runId,generation:prompt.generation,hostEpoch:prompt.hostEpoch,turnId:prompt.turnId,nativeSessionId:run.nativeSessionId,requestId,title:params.message,source:{method:'elicitation/create',providerId:op.launch.agent.profile.providerId,...(params.toolCallId!=null?{toolCallId:params.toolCallId}:{})},requestedSchema:params.requestedSchema,state:'pending'});
            const bytes=Buffer.byteLength(JSON.stringify({principal:op.launch.principal,interaction:value}));
            if(bytes>24000)throw acp.RequestError.invalidParams(undefined,'Form exceeds supported durable bounds');
            return new Promise(resolve=>{
                let settled=false;const settle=()=>{if(!settled){settled=true;resolve({action:'cancel'});}};
                const abort=()=>{if(run.channels.get(key)!==channel)return;run.channels.delete(key);channel.invalidated=true;channel.dispose();settle();const expired=responseValue(channel,channel.response?'delivery_unknown':'expired','Agent response channel disconnected or was cancelled.');if(channel.response)context.transactions.run(tx=>repository.putResponse(tx,{...channel.response!,state:'terminal',interaction:expired}));void ingest(run,1000,()=>context.transactions.run(tx=>emit(tx,value.id,{principal:op.launch.principal,interaction:expired})));};
                const channel:Channel={value,settle,respond(response){if(!settled&&response.submission){settled=true;resolve(response.submission);}},dispose:()=>ctx.signal.removeEventListener('abort',abort)};
                run.channels.set(key,channel);ctx.signal.addEventListener('abort',abort,{once:true});
                void ingest(run,bytes+4000,()=>context.transactions.run(tx=>{const currentPrompt=current(run,tx);if(!currentPrompt||currentPrompt.cancelRequested||run.closed||settled)return;progress(tx,currentPrompt);emit(tx,value.id,{principal:op.launch.principal,interaction:value});}));
            });
        },
        tick() {
            dispatchResponses();
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
                        const initiated = context.transactions.run(tx => { const latest = repository.prompt(prompt.turnId, tx)!; const parent = repository.get(prompt.runId, tx); if (!parent || parent.stopRequested || parent.state !== 'ready'||parent.launch.run.runId!==latest.runId||parent.launch.run.generation!==latest.generation||parent.launch.run.hostEpoch!==latest.hostEpoch||latest.hostEpoch!==context.owner.hostEpoch||parent.launch.owner.pluginId!==run.op.launch.owner.pluginId) {
                            repository.updatePrompt(tx, { ...latest, state: 'terminal' });
                            append(tx, latest, { kind: 'state', state: 'cancelled', reason: 'Run ended before prompt delivery.' });
                            return false;
                        } const failure=inputFailure(parent,latest);if(failure){repository.updatePrompt(tx,{...latest,state:'terminal'});append(tx,latest,{kind:'state',state:'failed',reason:failure});return false;} repository.updatePrompt(tx, { ...latest, state: 'attempting' }); append(tx, latest, { kind: 'state', state: latest.cancelRequested ? 'cancelling' : 'dispatching' }); return true; });
                        if (!initiated) {
                            delete run.active;
                            continue;
                        }
                        if (prompt.cancelRequested) {
                            void ingest(run, 1000, () => terminal(run, 'cancelled', 'Cancelled before prompt delivery.'));
                            continue;
                        }
                        const response = run.agent.request<acp.PromptResponse, acp.PromptRequest>(acp.methods.agent.session.prompt, { sessionId: run.nativeSessionId, prompt: prompt.content??[{ type: 'text' as const, text: prompt.text }] } satisfies acp.PromptRequest);
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
