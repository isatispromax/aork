import {isolatedSchemaValidators} from './schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext, SyncTransaction, ReadSnapshot } from '@aork/sdk/server';
import { z } from 'zod';
import { TOOLS_SERVICE, TOOL_LIMITS, selectionSchema, toolRefSchema, toolDescriptorSchema, toolCallSchema } from '@aork/contracts/tools';
import type { ToolsService, ToolDefinition, ToolDescriptor, ToolRef, ToolContext, ToolResult, ToolCallRecord, RunToolHandle } from '@aork/contracts/tools';
import { WORKSPACE_RUN_FILES } from '@aork/contracts/workspace';
import type { WorkspaceRunFiles } from '@aork/contracts/workspace';
import {provideWriters} from './writers.js';
import { openGrant } from './grant.js';
import { toolRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';
export function activate(context: ServerPluginContext) {
    const repository = toolRepository(context.repository);
    const files = context.service<WorkspaceRunFiles>(WORKSPACE_RUN_FILES);
    type Registration = {
        nonce: symbol;
        owner: OwnerDescriptor;
        descriptor: ToolDescriptor;
        parse: (value: unknown) => unknown;
        handler: (value: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
    };
    const registry = new Map<string, Registration>();
    const live = new Map<string, RunToolHandle>();
    const failureHooks = new Map<string, () => void>();
    const revoked = new Set<string>();
    function fail(code = 'TOOL_UNAVAILABLE', message = 'The selected tool is unavailable'): never { throw new AorkError(code, message, 409); }
    const role = (owner: OwnerDescriptor, id: string) => { context.verifyOwner(owner); const selected = context.owner.serviceOwners[id]; if (!selected || owner.pluginId !== selected.pluginId || owner.version !== selected.version)
        fail('TOOL_CALLER_INVALID', 'Only the selected lifecycle owner may coordinate tools'); };
    function retire(id: string, nonce: symbol) { const entry = registry.get(id); if (entry?.nonce !== nonce)
        return; registry.delete(id); for (const grant of repository.activeGrants())
        if (grant.state !== 'revoked' && grant.snapshot.tools.some(tool => tool.id === id)) {
            revoked.add(grant.snapshot.grantId);
            live.get(grant.snapshot.grantId)?.revoke();
        } }
    function registrationDisposer(id:string,nonce:symbol){return()=>retire(id,nonce);}
    function prune() { for (const [id, entry] of registry)
        try {
            context.verifyOwner(entry.owner);
        }
        catch {
            retire(id, entry.nonce);
        } }
    function lookup(ref: ToolRef) { prune(); const entry = registry.get(ref.id); if (!entry || entry.descriptor.definitionVersion !== ref.definitionVersion)
        fail(); return entry; }
    function refs(values: readonly ToolRef[]) { if (values.length > TOOL_LIMITS.selection || new Set(values.map(tool => tool.id)).size !== values.length)
        fail('TOOL_SELECTION_INVALID', 'Choose at most eight distinct tools'); return values.map(value => structuredClone(lookup(toolRefSchema.parse(value)).descriptor)); }
    const events = { 'tools.selectionChanged': { version: 1, payload: selectionSchema }, 'tools.grantChanged': { version: 1, payload: z.object({ grantId: z.uuid(), runId: z.uuid(), state: z.enum(['planned', 'live', 'revoked']) }).strict() }, 'tools.callChanged': { version: 1, payload: toolCallSchema } };
    const grantEvent=(tx:SyncTransaction,grant:NonNullable<ReturnType<typeof repository.grant>>,state:'planned'|'live'|'revoked')=>context.publishEvents(tx,grant.principal,[{type:'tools.grantChanged',version:1,entityId:grant.snapshot.grantId,payload:{grantId:grant.snapshot.grantId,runId:grant.snapshot.run.runId,state}}],events);
    function callEvent(tx:SyncTransaction,principal:string,call:ToolCallRecord){
        // Events invalidate bounded snapshots; full results belong to the owning query/IPC.
        const {result:_result,...status}=call;
        context.publishEvents(tx,principal,[{type:'tools.callChanged',version:1,entityId:call.id,payload:status}],events);
    }
    function revokeGrant(tx:SyncTransaction,grant:NonNullable<ReturnType<typeof repository.grant>>,reason:string){
        if(grant.state==='revoked')return;
        repository.putGrant(tx,{...grant,state:'revoked',reason});
        grantEvent(tx,grant,'revoked');
    }
    const writers=provideWriters(context,repository,(tx,run)=>{const grant=repository.runGrant(run.runId,tx);if(grant&&grant.snapshot.run.generation===run.generation&&grant.snapshot.run.hostEpoch===run.hostEpoch)revokeGrant(tx,grant,'writers-checked');});
    function reconcileCalls(tx:SyncTransaction,reason:string,cancellationRequested=false){
        for(const call of repository.unfinished(tx)){
            const grant=repository.runGrant(call.run.runId,tx);
            if(!grant)throw new AorkError('TOOL_RECOVERY_INVALID','Tool call recovery requires its captured Run grant',500);
            const updated={...call,state:'unknown' as const,finishedAt:new Date().toISOString(),errorCode:reason,cancellationRequested:call.cancellationRequested||cancellationRequested};
            repository.putCall(tx,updated);
            callEvent(tx,grant.principal,updated);
        }
    }
    const publicSelection = (row: NonNullable<ReturnType<typeof repository.selection>>) => selectionSchema.parse({ sessionId: row.sessionId, revision: row.revision, tools: row.tools });
    function owned(id: string, principal: string | undefined, tx?: SyncTransaction|ReadSnapshot) { const row = repository.selection(id, tx); if (!row || row.principal !== principal)
        throw new AorkError('SESSION_UNAVAILABLE', 'Session is unavailable', 404); return row; }
    const service = (consumer: OwnerDescriptor): ToolsService => ({
        registerTool<T>(definition: ToolDefinition<T>, handler: (value: T, ctx: ToolContext) => ToolResult | Promise<ToolResult>) {
            context.verifyOwner(consumer);
            prune();
            toolRefSchema.parse({ id: definition.id, definitionVersion: definition.definitionVersion });
            if (!definition.id.startsWith(`${consumer.pluginId}.`))
                fail('TOOL_OWNER_INVALID', 'Tool IDs are qualified by the actual provider');
            const input = JSON.parse(JSON.stringify(definition.inputSchema));
            const encoded = JSON.stringify(input);
            if (Buffer.byteLength(encoded) > TOOL_LIMITS.schemaBytes || input.type !== 'object')
                fail('TOOL_SCHEMA_INVALID', 'Tool input schema must be a bounded JSON object schema');
            const descriptor = toolDescriptorSchema.parse({ writerCoverage:definition.writerCoverage??'unknown',registrationId: randomUUID(), id: definition.id, definitionVersion: definition.definitionVersion, title: definition.title, description: definition.description, access: definition.access, inputSchema: input, ownerPluginId: consumer.pluginId, ownerPluginVersion: consumer.version, schemaDigest: createHash('sha256').update(encoded).digest('hex'), wireName: `t_${createHash('sha256').update(definition.id).digest('hex').slice(0, 40)}` });
            if (registry.has(descriptor.id) || [...registry.values()].some(entry => entry.descriptor.wireName === descriptor.wireName) || registry.size >= TOOL_LIMITS.registrations || [...registry.values()].filter(entry => entry.owner.pluginId === consumer.pluginId).length >= TOOL_LIMITS.perOwner)
                fail('TOOL_REGISTRATION_CONFLICT', 'Tool registration conflicts with a current registration or exceeds capacity');
            let nodes = 0;
            function boundedSchema(value: unknown, depth = 0) { if (depth > 16 || ++nodes > 512)
                fail('TOOL_SCHEMA_INVALID', 'Schema structure exceeds the supported bounds'); if (value && typeof value === 'object') {
                if ('$async' in value)
                    fail('TOOL_SCHEMA_INVALID', 'Asynchronous JSON Schemas are not supported');
                if ('$ref' in value)
                    fail('TOOL_SCHEMA_INVALID', 'Schema references are not supported');
                for (const child of Object.values(value))
                    boundedSchema(child, depth + 1);
            } }
            boundedSchema(input);
            const validate = isolatedSchemaValidators.getValidator(input);
            const parser = definition.arguments;
            if (!parser || typeof parser.parse !== 'function' || typeof handler !== 'function')
                fail('TOOL_SCHEMA_INVALID', 'Tool registration needs an argument parser and handler');
            const parse = parser.parse.bind(parser);
            context.verifyOwner(consumer);
            const nonce = Symbol();
            registry.set(descriptor.id, { nonce, owner: consumer, descriptor, parse: value => { if (!validate(value).valid)
                    fail('TOOL_ARGUMENTS_INVALID', 'Arguments do not match the captured JSON schema'); const parsed=parse(value);if(parsed!==null&&(typeof parsed==='object'||typeof parsed==='function')&&typeof (parsed as {then?:unknown}).then==='function'){void Promise.resolve(parsed).catch(()=>{});fail('TOOL_ARGUMENTS_INVALID','Tool argument parsers must finish synchronously');}return parsed; }, handler: handler as Registration['handler'] });
            const id = descriptor.id;
            return registrationDisposer(id,nonce);
        },
        createSelection(tx, input, values) { role(consumer, 'aork.sessions@1'); refs(values); const prior = repository.selection(input.sessionId, tx); if (prior) {
            if (prior.principal !== input.principal || prior.workspaceId !== input.workspaceId)
                fail('TOOL_SELECTION_CONFLICT', 'Session selection belongs to another environment');
            return;
        } repository.putSelection(tx, { ...input, revision: 1, tools: structuredClone([...values]), archived: false }); },
        archiveSelection(tx, id) { role(consumer, 'aork.sessions@1'); const row = repository.selection(id, tx); if (row&&!row.archived)
            {repository.putSelection(tx, { ...row, archived: true });context.publishEvents(tx,row.principal,[{type:'tools.selectionChanged',version:1,entityId:row.sessionId,payload:publicSelection(row)}],events);} },
        captureRun(tx, input) { role(consumer, 'aork.sessions@1'); const row = repository.selection(input.sessionId, tx); if (!row || row.archived)
            fail('TOOL_SELECTION_UNAVAILABLE', 'Session tool selection is unavailable'); const snapshot = { grantId: randomUUID(), run: input.run, sessionId: row.sessionId, workspaceId: row.workspaceId, selectionRevision: row.revision, tools: refs(row.tools) }; repository.putGrant(tx, { snapshot, principal: row.principal, state: 'planned' });writers.capture(tx,snapshot);grantEvent(tx,{snapshot,principal:row.principal,state:'planned'},'planned'); return snapshot; },
        assertCaptured(tx, snapshot) { role(consumer, 'aork.runtime.acp@1'); const row = repository.grant(snapshot.grantId, tx); if (!row || row.state !== 'planned' || JSON.stringify(row.snapshot) !== JSON.stringify(snapshot))
            fail('TOOL_SNAPSHOT_INVALID', 'Run requires its exact captured tool snapshot'); for (const tool of snapshot.tools)
            if (JSON.stringify(lookup(tool).descriptor) !== JSON.stringify(tool))
                fail(); },
        async openRun(snapshot, hooks, authority) {
            role(consumer, 'aork.runtime.acp@1');
            context.transactions.run(tx => {service(consumer).assertCaptured(tx, snapshot);writers.begin(tx,snapshot);});
            const handle = await openGrant({ completed:()=>writers.completed(snapshot.run),context, repository, snapshot, hooks, authority, files, lookup(descriptor) { context.verifyOwner(consumer); const entry = lookup(descriptor); if (JSON.stringify(entry.descriptor) !== JSON.stringify(descriptor))
                    fail('TOOL_SNAPSHOT_INVALID', 'Captured tool registration changed'); return entry; },
                record(call) { context.transactions.run(tx => { repository.putCall(tx, call); const grant = repository.grant(snapshot.grantId, tx)!; callEvent(tx,grant.principal,call); }); },
                grantChanged(state) { context.transactions.run(tx => { const grant = repository.grant(snapshot.grantId, tx); if (!grant || grant.state === 'revoked')
                    return; repository.putGrant(tx, { ...grant, state }); context.publishEvents(tx, grant.principal, [{ type: 'tools.grantChanged', version: 1, entityId: snapshot.grantId, payload: { grantId: snapshot.grantId, runId: snapshot.run.runId, state } }], events); }); } });
            live.set(snapshot.grantId, handle);
            failureHooks.set(snapshot.grantId, hooks.onFailure);
            const row = repository.grant(snapshot.grantId);
            if (row?.state === 'revoked') {
                handle.revoke();
                hooks.onFailure();
            }
            return handle;
        },
        revokeInTransaction(tx, run, reason) { role(consumer, 'aork.runtime.acp@1'); const grant = repository.runGrant(run.runId, tx); if (grant && grant.snapshot.run.generation === run.generation && grant.snapshot.run.hostEpoch === run.hostEpoch)revokeGrant(tx,grant,reason.slice(0,100)); },
    });
    context.provideScoped(TOOLS_SERVICE, service);
    context.query('tools.catalog', { access: 'authenticated', execute() { prune(); return { tools: [...registry.values()].map(entry => { const { inputSchema: _schema, ...summary } = entry.descriptor; return structuredClone(summary); }) }; } });
    context.resource('tools.definition', { maxBytes: 32768, read(parameters) { const ref = toolRefSchema.parse(parameters); return { bytes: Buffer.from(JSON.stringify(lookup(ref).descriptor)), mediaType: 'application/json' }; } });
    const read = (parameters: Readonly<Record<string, string>>, principal: string | undefined, tx?: SyncTransaction|ReadSnapshot) => { const id = z.uuid().parse(parameters.sessionId); const row = owned(id, principal, tx); const requested = parameters.runId ? z.uuid().parse(parameters.runId) : undefined; const grants = repository.sessionGrants(id, tx); const selected = requested ? repository.runGrant(requested, tx) : grants.at(-1); if (requested && (!selected || selected.snapshot.sessionId !== id))
        throw new AorkError('RUN_UNAVAILABLE', 'Run is unavailable', 404); const runs = selected ? [{ snapshot: selected.snapshot, state: selected.state, writers:(()=>{const row=repository.writer(selected.snapshot.run.runId);return row?{coverage:row.coverage,phase:row.phase}:null;})() }] : []; return { selection: publicSelection(row), archived:row.archived, runs, history: grants.slice(-50).map(({ snapshot, state }) => ({ grantId: snapshot.grantId, run: snapshot.run, selectionRevision: snapshot.selectionRevision, tools: snapshot.tools.map(({ id, definitionVersion }) => ({ id, definitionVersion })), state })), historyTruncated: grants.length > 50 }; };
    context.snapshot('tools.session', { maxBytes: 1024 * 1024, read: (parameters, request,tx) => read(parameters, request.identity,tx) });
    context.resource('tools.session', { maxBytes: 1024 * 1024, read: (parameters, request) => ({ bytes: Buffer.from(JSON.stringify(read(parameters, request.identity))), mediaType: 'application/json' }) });
    context.durableCommand('tools.replaceSessionSelection', { version: 1, payload: selectionSchema.omit({ revision: true }).extend({ expectedRevision: z.number().int().positive() }), result: selectionSchema, events, execute(payload, _prepared, tx, request) { const row = owned(payload.sessionId, request.identity, tx); if (row.archived || row.revision !== payload.expectedRevision)
            fail('TOOL_SELECTION_CONFLICT', 'Selection changed or Session is archived; reload it'); refs(payload.tools); const updated = { ...row, revision: row.revision + 1, tools: payload.tools }; repository.putSelection(tx, updated); const result = publicSelection(updated); return { result, events: [{ type: 'tools.selectionChanged', version: 1, entityId: row.sessionId, payload: result }] }; } });
    function readCalls(parameters:Readonly<Record<string,string>>,principal:string|undefined,tx?:SyncTransaction|ReadSnapshot){
        const parsed=z.object({sessionId:z.uuid()}).strict().safeParse(parameters);if(!parsed.success)throw new AorkError('TOOL_CALL_QUERY_INVALID','Choose a valid Session',400);
        const id=parsed.data.sessionId;owned(id,principal,tx);const recent=repository.calls(id,tx);const calls=recent.slice(0,100);const ids=new Set(calls.map(call=>call.id));
        // Active identities survive the bounded history window; no result body is loaded here.
        for(const call of repository.activeCalls(id,tx))if(!ids.has(call.id)){calls.push(call);ids.add(call.id);}
        return{calls,truncated:recent.length>100};
    }
    function readCall(parameters:Readonly<Record<string,string>>,principal:string|undefined,tx?:SyncTransaction|ReadSnapshot){
        const parsed=z.object({callId:z.uuid()}).strict().safeParse(parameters);if(!parsed.success)throw new AorkError('TOOL_CALL_QUERY_INVALID','Choose a valid call ID',400);
        const call=repository.call(parsed.data.callId,tx);if(!call)throw new AorkError('TOOL_CALL_UNAVAILABLE','Tool call is unavailable',404);owned(call.sessionId,principal,tx);return call;
    }
    context.resource('tools.calls',{maxBytes:1024*1024,read:(parameters,request)=>({bytes:Buffer.from(JSON.stringify(readCalls(parameters,request.identity))),mediaType:'application/json'})});
    context.snapshot('tools.calls',{maxBytes:1024*1024,read:(parameters,request,tx)=>readCalls(parameters,request.identity,tx)});
    context.resource('tools.call',{maxBytes:1024*1024,read:(parameters,request)=>({bytes:Buffer.from(JSON.stringify(readCall(parameters,request.identity))),mediaType:'application/json'})});
    context.snapshot('tools.call',{maxBytes:1024*1024,read:(parameters,request,tx)=>readCall(parameters,request.identity,tx)});
    context.durableCommand('tools.revokeRun', { version: 1, payload: z.object({ runId: z.uuid() }).strict(), result: z.object({ runId: z.uuid(), state: z.literal('revoked') }).strict(), events, execute(payload, _prepared, tx, request) { const grant = repository.runGrant(payload.runId, tx); if (!grant || grant.principal !== request.identity)
            throw new AorkError('RUN_UNAVAILABLE', 'Run is unavailable', 404); if(grant.state==='revoked')return{result:{runId:payload.runId,state:'revoked' as const},events:[]};repository.putGrant(tx, { ...grant, state: 'revoked', reason: 'user-revoked' }); return { result: { runId: payload.runId, state: 'revoked' as const }, events: [{ type: 'tools.grantChanged', version: 1, entityId: grant.snapshot.grantId, payload: { grantId: grant.snapshot.grantId, runId: payload.runId, state: 'revoked' } }] }; } });
    // Recovery rows and their owning public events commit together before any listener.
    context.transactions.run(tx=>{
        for(const grant of repository.activeGrants(tx))if(grant.snapshot.run.hostEpoch!==context.owner.hostEpoch)revokeGrant(tx,grant,'host-restarted');
        reconcileCalls(tx,'HOST_RESTARTED');
    });
    const timer = setInterval(() => { try {
        context.verifyOwner(context.owner);
        prune();writers.prune();
        for (const [id, handle] of live) {
            const row = repository.grant(id);
            if (row?.state === 'revoked') {
                handle.revoke();
                failureHooks.get(id)?.();
                failureHooks.delete(id);
                handle.drain().then(() => {context.transactions.run(tx=>writers.flush(tx));writers.prune();live.delete(id);}).catch(() => { });
            }
        }
        for (const id of revoked) {
            const grant = repository.grant(id);
            if (grant && grant.state !== 'revoked')
                context.transactions.run(tx => {repository.putGrant(tx, { ...grant, state: 'revoked', reason: 'provider-unavailable' });grantEvent(tx,grant,'revoked');});
            revoked.delete(id);
        }
    }
    catch {
        clearInterval(timer);
        for (const handle of live.values())
            handle.revoke();
    } }, 100);
    context.effect(()=>async()=>{
        clearInterval(timer);
        // No cross-owner cleanup permission is borrowed. These transactions execute in
        // Tools' own Kernel-issued cleanup scope, including planned grants with no handle.
        for(const handle of live.values())handle.revoke();
        let revokeFailure:unknown;
        try{context.transactions.run(tx=>{for(const grant of repository.activeGrants(tx))revokeGrant(tx,grant,'tools-stopped');});}
        catch(error){revokeFailure=error;}
        try{
            const drains=await Promise.allSettled([...live.values()].map(handle=>handle.drain()));
            // Cancellation alone was not completion. Only after actual jobs/finally/IO
            // have joined may a lost terminal record be reconciled as delivery unknown.
            context.transactions.run(tx=>{
                for(const grant of repository.activeGrants(tx))revokeGrant(tx,grant,'tools-stopped');
                writers.flush(tx,true);
                reconcileCalls(tx,'TOOL_SCOPE_STOPPED',true);
            });
            const failed=drains.find(result=>result.status==='rejected');
            if(failed?.status==='rejected')throw failed.reason;
        }finally{live.clear();failureHooks.clear();registry.clear();}
        if(revokeFailure)throw revokeFailure;
    });
}
