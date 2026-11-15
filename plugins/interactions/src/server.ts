import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { ACP_RUNTIME, type AcpRuntime } from '@aork/contracts/runtime';
import { INTERACTIONS_SERVICE, permissionSchema, respondPermissionSchema, interactionSnapshotParametersSchema } from '@aork/contracts/interaction';
import { interactionRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';
export function activate(context: ServerPluginContext) {
    const repository = interactionRepository(context.repository);
    let runtime: AcpRuntime | undefined;
    try {
        runtime = context.service<AcpRuntime>(ACP_RUNTIME);
    }
    catch (error) {
        if (!isAorkError(error) || error.code !== 'SERVICE_UNAVAILABLE')
            throw error;
    }
    context.transactions.run(tx => { for (const row of repository.list(tx))
        if (['pending','responding'].includes(row.interaction.state) && row.interaction.hostEpoch !== context.owner.hostEpoch)
            repository.put(tx, row.principal, { ...row.interaction, state: row.interaction.state==='responding'?'delivery_unknown':'expired', reason: 'Host restarted; the old Agent response channel is closed.' }); });
    if (runtime)
        context.consumeFacts(runtime.permissionFacts, { id: 'pendingProjection', events: { 'interactions.changed': { version: 1, payload: permissionSchema } }, apply(fact, tx) { const value = fact.payload; const interaction = value.interaction.hostEpoch !== context.owner.hostEpoch && value.interaction.state === 'pending' ? { ...value.interaction, state: 'invalidated' as const, reason: 'The old response channel is closed.' } : value.interaction; repository.put(tx, value.principal, interaction); return { principal: value.principal, events: [{ type: 'interactions.changed', version: 1, entityId: interaction.id, payload: interaction }] }; } });
    function selectedSession(parameters:Readonly<Record<string,string>>) {
        const parsed=interactionSnapshotParametersSchema.safeParse(parameters);
        if(!parsed.success)throw new AorkError('INTERACTION_QUERY_INVALID','Choose a valid Session ID',400);
        return parsed.data.sessionId;
    }
    function owned(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot,sessionId?:string) {
        // The filter never establishes ownership of a Session. Only this
        // principal's own Runtime-derived Interaction rows can enter the view.
        return repository.list(token).filter(row=>row.principal===identity&&(!sessionId||row.interaction.sessionId===sessionId)).map(row=>row.interaction);
    }
    function pending(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot,sessionId?:string) {
        const values=owned(identity,token,sessionId).filter(value=>value.state==='pending');
        return {pending:values.slice(-32),...(values.length>32?{truncated:true}:{})};
    }
    function history(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot,sessionId?:string) {
        const values=owned(identity,token,sessionId);
        const live=values.filter(value=>value.state==='pending'||value.state==='responding');
        const terminal=values.filter(value=>value.state!=='pending'&&value.state!=='responding');
        const interactions=live.length>=32?live.slice(-32):[...terminal.slice(-(32-live.length)),...live];
        return {interactions,...(values.length>interactions.length?{truncated:true}:{})};
    }
    context.query('interactions.pending',{access:'authenticated',execute(request){return pending(request.identity);}});
    context.snapshot('interactions.pending',{maxBytes:900000,read(parameters,request,token){return pending(request.identity,token,selectedSession(parameters));}});
    context.snapshot('interactions.history',{maxBytes:900000,read(parameters,request,token){return history(request.identity,token,selectedSession(parameters));}});
    context.resource('interactions.detail', {maxBytes:32768,read(parameters,request){const value=repository.list().find(row=>row.principal===request.identity&&row.interaction.id===parameters.id)?.interaction;if(!value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);return {bytes:Buffer.from(JSON.stringify(value)),mediaType:'application/json'};}});
    context.query('interactions.history',{access:'authenticated',execute(request){return history(request.identity);}});
    context.durableCommand('interactions.respond',{
      version:1,payload:respondPermissionSchema,result:permissionSchema,events:{'interactions.changed':{version:1,payload:permissionSchema}},
      execute(payload,_prepared,tx,request){
        const value=repository.list(tx).find(row=>row.principal===request.identity&&row.interaction.id===payload.interactionId)?.interaction;
        if(!value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);
        if(value.state!=='pending'||value.hostEpoch!==context.owner.hostEpoch)throw new AorkError('INTERACTION_CLOSED','This permission response channel has closed or was already claimed',409);
        if(!value.options.some(option=>option.optionId===payload.optionId))throw new AorkError('INTERACTION_OPTION_INVALID','Choose an option offered by the Agent',400);
        if(!runtime)throw new AorkError('RUNTIME_UNAVAILABLE','The live response channel is unavailable',409);
        const responding={...value,state:'responding' as const,selectedOptionId:payload.optionId};
        if(!repository.claim(tx,request.identity!,responding))throw new AorkError('INTERACTION_CLOSED','Another response already claimed this request',409);
        runtime.acceptResponse(tx,context.owner,request.identity!,value,payload.optionId);
        return {result:responding,events:[{type:'interactions.changed',version:1,entityId:value.id,payload:responding}]};
      }
    });
    context.provide(INTERACTIONS_SERVICE, Object.freeze({ ownerId: context.pluginId }));
}
