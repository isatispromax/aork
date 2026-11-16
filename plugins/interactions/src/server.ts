import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { ACP_RUNTIME, type AcpRuntime } from '@aork/contracts/runtime';
import { INTERACTIONS_SERVICE, permissionSchema, respondPermissionSchema, interactionSnapshotParametersSchema, type PendingIndex } from '@aork/contracts/interaction';
import { structuredInputSchema, inputDiagnosticSchema, submitInputSchema, validateInputContent, type StructuredInput } from '@aork/contracts/structured-input';
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
    if (runtime)
        context.consumeFacts(runtime.permissionFacts, { id: 'pendingProjection', events: { 'interactions.changed': { version: 1, payload: permissionSchema } }, apply(fact, tx) { const value = fact.payload; const current=repository.list(tx).find(row=>row.interaction.id===value.interaction.id)?.interaction;if(current&&value.interaction.state==='pending'&&current.state!=='pending')return{principal:value.principal,events:[]}; const interaction = value.interaction.hostEpoch !== context.owner.hostEpoch && value.interaction.state === 'pending' ? { ...value.interaction, state: 'invalidated' as const, reason: 'The old response channel is closed.' } : value.interaction; repository.put(tx, value.principal, interaction); return { principal: value.principal, events: [{ type: 'interactions.changed', version: 1, entityId: interaction.id, payload: interaction }] }; } });
    if(runtime?.inputFacts)context.consumeFacts(runtime.inputFacts,{
      id:'inputProjection',events:{'interactions.inputChanged':{version:1,payload:structuredInputSchema}},
      apply(fact,tx){
        const value=fact.payload;
        const current=repository.list(tx).find(row=>row.interaction.id===value.interaction.id)?.interaction;
        if(current&&value.interaction.state==='pending'&&current.state!=='pending')return{principal:value.principal,events:[]};
        // A committed fact can outlive its Host before this projection/offset
        // commits. Replaying it must not recreate a pending native channel.
        const interaction=value.interaction.hostEpoch!==context.owner.hostEpoch&&value.interaction.state==='pending'
          ? {...value.interaction,state:'expired' as const,reason:'Host restarted; the old Agent response channel is closed.'}
          : value.interaction;
        repository.put(tx,value.principal,interaction);
        return {principal:value.principal,events:[{type:'interactions.inputChanged',version:1,entityId:interaction.id,payload:interaction}]};
      }
    });
    if(runtime?.inputDiagnosticFacts)context.consumeFacts(runtime.inputDiagnosticFacts,{id:'inputDiagnosticsProjection',events:{'interactions.inputDiagnostic':{version:1,payload:inputDiagnosticSchema}},apply(fact,tx){const value=fact.payload;repository.putDiagnostic(tx,value.principal,value.diagnostic);return {principal:value.principal,events:[{type:'interactions.inputDiagnostic',version:1,entityId:value.diagnostic.id,payload:value.diagnostic}]};}});
    // Registration catches up committed Runtime facts immediately. Definitive
    // response results win before any remaining old channels need a fallback.
    context.transactions.run(tx => { for (const row of repository.list(tx)) {
        if (!['pending','responding'].includes(row.interaction.state) || row.interaction.hostEpoch === context.owner.hostEpoch) continue;
        const interaction = { ...row.interaction, state: row.interaction.state === 'responding' ? 'delivery_unknown' as const : 'expired' as const, reason: 'Host restarted; the old Agent response channel is closed.' };
        repository.put(tx,row.principal,interaction);
        const structured = 'kind' in interaction;
        context.publishEvents(tx,row.principal,[{type:structured?'interactions.inputChanged':'interactions.changed',version:1,entityId:interaction.id,payload:interaction}],structured?{'interactions.inputChanged':{version:1,payload:structuredInputSchema}}:{'interactions.changed':{version:1,payload:permissionSchema}});
    } });
    function selectedSession(parameters:Readonly<Record<string,string>>) {
        const parsed=interactionSnapshotParametersSchema.safeParse(parameters);
        if(!parsed.success)throw new AorkError('INTERACTION_QUERY_INVALID','Choose a valid Session ID',400);
        return parsed.data.sessionId;
    }
    function owned(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot|import('@aork/sdk/server').SyncTransaction,sessionId?:string) {
        // The filter never establishes ownership of a Session. Only this
        // principal's own Runtime-derived Interaction rows can enter the view.
        return repository.list(token).filter(row=>row.principal===identity&&(!sessionId||row.interaction.sessionId===sessionId)).map(row=>row.interaction);
    }
    function pending(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot|import('@aork/sdk/server').SyncTransaction,sessionId?:string) {
        const values=owned(identity,token,sessionId).filter(value=>!('kind' in value)&&value.state==='pending');
        return {pending:values.slice(-32),...(values.length>32?{truncated:true}:{})};
    }
    function history(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot|import('@aork/sdk/server').SyncTransaction,sessionId?:string) {
        const values=owned(identity,token,sessionId).filter(value=>!('kind' in value));
        const live=values.filter(value=>value.state==='pending'||value.state==='responding');
        const terminal=values.filter(value=>value.state!=='pending'&&value.state!=='responding');
        const interactions=live.length>=32?live.slice(-32):[...terminal.slice(-(32-live.length)),...live];
        return {interactions,...(values.length>interactions.length?{truncated:true}:{})};
    }
    context.snapshot('interactions.request',{maxBytes:32768,read(parameters,request,token){
      if(Object.keys(parameters).some(key=>key!=='id')||!parameters.id||!/^[0-9a-f-]{36}$/.test(parameters.id))throw new AorkError('INTERACTION_QUERY_INVALID','Choose a valid Interaction',400);
      const value=owned(request.identity,token).find(value=>value.id===parameters.id);
      if(!value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);return value;
    }});
    context.snapshot('interactions.pendingIndex',{maxBytes:100000,read(parameters,request,token){
      const after=parameters.after??'';
      if(Object.keys(parameters).some(key=>key!=='after')||(after&&!/^[0-9a-f-]{36}$/.test(after)))throw new AorkError('INTERACTION_QUERY_INVALID','Choose a valid pending page',400);
      const all=owned(request.identity,token).filter(value=>value.state==='pending'&&value.hostEpoch===context.owner.hostEpoch).sort((a,b)=>a.id.localeCompare(b.id));
      const page=all.filter(value=>value.id>after).slice(0,51);
      if(!page.length)return {count:all.length,items:[]};
      const items:PendingIndex['items']=[];
      // Full native form titles can JSON-escape to3000 bytes each. Bound the
      // complete serialized summary page, not only its50-item count. Reserving
      // the fixed UUID continuation frame also leaves room below maxBytes for
      // the transport envelope; ordinary short-title pages still hold50.
      const budget=96000;
      let bytes=Buffer.byteLength(JSON.stringify({count:all.length,items:[],next:page[0]!.id}));
      for(const value of page.slice(0,50)){
        const item:PendingIndex['items'][number]={id:value.id,sessionId:value.sessionId,kind:'kind' in value?'form':'permission',title:value.title};
        const charge=Buffer.byteLength(JSON.stringify(item))+(items.length?1:0);
        if(bytes+charge>budget)break;
        items.push(item);bytes+=charge;
      }
      // Every legal individual request is far below this page budget. Keep an
      // invalid owner record explicit rather than silently skipping its ID.
      if(!items.length)throw new AorkError('INTERACTION_SUMMARY_TOO_LARGE','A request exceeds the supported summary page bound',500);
      return {count:all.length,items,...(page.length>items.length?{next:items.at(-1)!.id}:{})};
    }});
    context.query('interactions.pending',{access:'authenticated',execute(request){return pending(request.identity);}});
    context.snapshot('interactions.pending',{maxBytes:900000,read(parameters,request,token){return pending(request.identity,token,selectedSession(parameters));}});
    context.snapshot('interactions.history',{maxBytes:900000,read(parameters,request,token){return history(request.identity,token,selectedSession(parameters));}});
    context.resource('interactions.detail', {maxBytes:32768,read(parameters,request){const value=repository.list().find(row=>row.principal===request.identity&&row.interaction.id===parameters.id&&!('kind' in row.interaction))?.interaction;if(!value||'kind' in value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);return {bytes:Buffer.from(JSON.stringify(value)),mediaType:'application/json'};}});
    context.query('interactions.history',{access:'authenticated',execute(request){return history(request.identity);}});
    context.durableCommand('interactions.respond',{
      version:1,payload:respondPermissionSchema,result:permissionSchema,events:{'interactions.changed':{version:1,payload:permissionSchema}},
      execute(payload,_prepared,tx,request){
        const value=repository.list(tx).find(row=>row.principal===request.identity&&row.interaction.id===payload.interactionId)?.interaction;
        if(!value||'kind' in value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);
        if(value.state!=='pending'||value.hostEpoch!==context.owner.hostEpoch)throw new AorkError('INTERACTION_CLOSED','This permission response channel has closed or was already claimed',409);
        if(!value.options.some(option=>option.optionId===payload.optionId))throw new AorkError('INTERACTION_OPTION_INVALID','Choose an option offered by the Agent',400);
        if(!runtime)throw new AorkError('RUNTIME_UNAVAILABLE','The live response channel is unavailable',409);
        const responding={...value,state:'responding' as const,selectedOptionId:payload.optionId};
        if(!repository.claim(tx,request.identity!,responding))throw new AorkError('INTERACTION_CLOSED','Another response already claimed this request',409);
        runtime.acceptResponse(tx,context.owner,request.identity!,value,payload.optionId);
        return {result:responding,events:[{type:'interactions.changed',version:1,entityId:value.id,payload:responding}]};
      }
    });
    function inputHistory(identity:string|undefined,token?:import('@aork/sdk/server').ReadSnapshot|import('@aork/sdk/server').SyncTransaction,sessionId?:string,pendingOnly=false){
      const values=owned(identity,token,sessionId).filter((value):value is StructuredInput=>'kind' in value);
      const live=values.filter(value=>pendingOnly?value.state==='pending':['pending','responding'].includes(value.state));
      const terminal=pendingOnly?[]:values.filter(value=>!['pending','responding'].includes(value.state));
      const interactions=live.length>=32?live.slice(-32):[...terminal.slice(-(32-live.length)),...live];
      const diagnostics=repository.diagnostics(token).filter(row=>row.principal===identity&&(!sessionId||row.diagnostic.sessionId===sessionId)).slice(-8).map(row=>row.diagnostic);
      return pendingOnly?{pending:interactions,...(live.length>32?{truncated:true}:{})}:{interactions,diagnostics,...(values.length>interactions.length?{truncated:true}:{})};
    }
    for(const [name,pendingOnly]of [['interactions.inputPending',true],['interactions.inputHistory',false]] as const){
      context.query(name,{access:'authenticated',execute(request){return inputHistory(request.identity,undefined,undefined,pendingOnly);}});
      context.snapshot(name,{maxBytes:900000,read(parameters,request,token){return inputHistory(request.identity,token,selectedSession(parameters),pendingOnly);}});
    }
    context.resource('interactions.inputDetail',{maxBytes:32768,read(parameters,request){const value=owned(request.identity).find(value=>value.id===parameters.id&&'kind' in value);if(!value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);return {bytes:Buffer.from(JSON.stringify(value)),mediaType:'application/json'};}});
    context.durableCommand('interactions.submit',{
      version:1,payload:submitInputSchema,result:structuredInputSchema,events:{'interactions.inputChanged':{version:1,payload:structuredInputSchema}},
      execute(payload,_prepared,tx,request){
        const value=owned(request.identity,tx).find((value):value is StructuredInput=>value.id===payload.interactionId&&'kind' in value);
        if(!value)throw new AorkError('INTERACTION_UNAVAILABLE','Interaction is unavailable',404);
        if(value.state!=='pending'||value.hostEpoch!==context.owner.hostEpoch)throw new AorkError('INTERACTION_CLOSED','This form response channel has closed or was already claimed',409);
        const {interactionId:_,...submission}=payload;
        if(submission.action==='accept'&&Object.keys(validateInputContent(value.requestedSchema,submission.content)).length)throw new AorkError('INTERACTION_FIELDS_INVALID','Correct the fields to match the Agent request',400);
        if(!runtime?.acceptInputResponse)throw new AorkError('RUNTIME_UNAVAILABLE','The live form response channel is unavailable',409);
        const responding={...value,state:'responding' as const,selectedAction:submission.action};
        if(!repository.claim(tx,request.identity!,responding))throw new AorkError('INTERACTION_CLOSED','Another response already claimed this request',409);
        runtime.acceptInputResponse(tx,context.owner,request.identity!,value,submission);
        return {result:responding,events:[{type:'interactions.inputChanged',version:1,entityId:value.id,payload:responding}]};
      }
    });
    context.provide(INTERACTIONS_SERVICE, Object.freeze({ ownerId: context.pluginId }));
}
