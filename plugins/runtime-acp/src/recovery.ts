import {AorkError} from '@aork/sdk';
import type {ServerPluginContext,SyncTransaction} from '@aork/sdk/server';
import {AGENT_PROVIDER_REGISTRY,type AgentProviderRegistry,type AgentLaunchSnapshot} from '@aork/contracts/agent';
import {nativeHistoryFactSchema,type NativeRecoveryPreparation,type NativeHistoryEntry} from '@aork/contracts/recovery';
import type {RunLaunch} from '@aork/contracts/runtime';
import type {operationRepository,Operation} from './persistence/repository.js';
import type * as acp from '@agentclientprotocol/sdk';
type Update=Parameters<acp.ClientNotificationHandlersByMethod[typeof acp.methods.client.session.update]>[0]['params'];
/** Native replay never enters live Turn/Interaction streams. */
export function nativeRecovery(context:ServerPluginContext,repository:ReturnType<typeof operationRepository>){
 const facts=context.factStream('nativeHistory',nativeHistoryFactSchema);
 const prepared=new WeakMap<object,{source:Operation;agent:AgentLaunchSnapshot}>();
 return{
  public:{historyFacts:facts.source,async prepareRecovery(sourceRunId:string,principal:string,agent:AgentLaunchSnapshot):Promise<NativeRecoveryPreparation>{
   const source=repository.get(sourceRunId);const run=source?.launch.run;
   if(!source||source.launch.principal!==principal||source.state!=='stopped'||!run?.nativeSessionId||!run.stateReference)throw new AorkError('NATIVE_RECOVERY_UNAVAILABLE','Saved native Session state is unavailable; retained workbench history remains readable',409);
   const original=source.launch.agent;
   if(!run.loadSession||run.protocolVersion!==1)throw new AorkError('NATIVE_RECOVERY_UNSUPPORTED','This Agent did not support native history loading',409);
   if(original.profile.providerId!==agent.profile.providerId||original.providerOwner.pluginId!==agent.providerOwner.pluginId||original.providerOwner.version!==agent.providerOwner.version||original.profile.revision!==agent.profile.revision||original.profile.stateDirectory!==agent.profile.stateDirectory||run.stateReference!==agent.profile.stateDirectory||original.providerDefinitionVersion!==agent.providerDefinitionVersion||original.detectedVersion!==agent.detectedVersion)throw new AorkError('NATIVE_RECOVERY_VERSION_MISMATCH','Saved native state belongs to a different Provider configuration or version',409);
   const provider=context.service<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY).get(agent.profile.providerId);
   if(!provider?.inspectNativeSession)throw new AorkError('NATIVE_RECOVERY_UNSUPPORTED','Provider has no native state inspection support; retained history remains readable',409);
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try{const state=await Promise.race([provider.inspectNativeSession({nativeSessionId:run.nativeSessionId,stateDirectory:agent.profile.stateDirectory,detectedVersion:agent.detectedVersion,signal:controller.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('inspection timeout')),2000);})]);if(state?.available!==true)throw new Error('unavailable');}
   catch{throw new AorkError('NATIVE_RECOVERY_STATE_UNAVAILABLE','Provider could not verify the saved native state; retained history remains readable',409);}finally{if(timer)clearTimeout(timer);controller.abort();}
   const token=Object.freeze({}) as NativeRecoveryPreparation;prepared.set(token,{source:structuredClone(source),agent});return token;
  }},
  accept(tx:SyncTransaction,launch:RunLaunch,token:NativeRecoveryPreparation){const value=prepared.get(token);prepared.delete(token);const current=value&&repository.get(value.source.launch.run.runId,tx);if(!value||value.agent!==launch.agent||!current||JSON.stringify(current)!==JSON.stringify(value.source)||current.launch.principal!==launch.principal||current.launch.run.sessionId!==launch.run.sessionId||current.launch.run.generation>=launch.run.generation||current.launch.workspace.id!==launch.workspace.id)throw new AorkError('NATIVE_RECOVERY_PREPARATION_STALE','Native recovery preparation changed; retry explicitly',409);return{sourceRunId:current.launch.run.runId,nativeSessionId:current.launch.run.nativeSessionId!};},
  stage(op:Operation){
   const entries:NativeHistoryEntry[]=[];let bytes=0,frames=0;let failed=false;let sealed=false;let tail=Promise.resolve();
   function ingest(params:Update){if(sealed||params.sessionId!==op.recovery?.nativeSessionId)return;const update=params.update;
    // Ignore all non-display protocol content, including thoughts and control metadata.
    let entry:NativeHistoryEntry|undefined;
    if((update.sessionUpdate==='user_message_chunk'||update.sessionUpdate==='agent_message_chunk'))entry={id:`entry:${entries.length}:${frames}`,role:update.sessionUpdate==='user_message_chunk'?'user':'agent',text:update.content.type==='text'?update.content.text:update.content.type==='image'?'[Native image]':update.content.type==='audio'?'[Native audio]':'[Native resource reference]',...(typeof update.messageId==='string'&&update.messageId.length>0&&update.messageId.length<=200?{messageId:update.messageId}:{})};
    else if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update')entry={id:`tool:${frames}`,role:'tool',text:`Agent tool report: ${update.status??'reported'}`};
    if(!entry)return;frames++;const encoded=Buffer.byteLength(JSON.stringify(entry));bytes+=encoded;
    if(frames>2000||bytes>4*1024*1024){failed=true;return;}
    // Preserve handler arrival order, and await this tail after the RPC resolves.
    const captured=entry;tail=tail.then(()=>{if(failed)return;
      const append=(text:string)=>{const previous=entries.at(-1);if(captured.messageId&&previous?.messageId===captured.messageId&&previous.role===captured.role&&previous.text.length+text.length<=4000)previous.text+=text;else entries.push({...captured,text,id:`entry:${entries.length}`});if(entries.length>2000)failed=true;};
      let chunk='';for(const point of captured.text){if(chunk.length+point.length>4000){append(chunk);chunk='';}chunk+=point;}if(chunk||captured.text==='')append(chunk);
    });
   }
   return{ingest,async finish(){sealed=true;await tail;if(failed)throw new AorkError('NATIVE_REPLAY_LIMIT','Native replay exceeded supported display bounds; prior history remains readable',409);return entries;},commit(tx:SyncTransaction,entries:NativeHistoryEntry[]){const base={sessionId:op.launch.run.sessionId,generation:op.launch.run.runId,sourceRunId:op.recovery!.sourceRunId};for(const[sequence,entry]of entries.entries())facts.append(tx,op.launch.run.sessionId,{...base,kind:'entry',sequence,entry});facts.append(tx,op.launch.run.sessionId,{...base,kind:'complete',count:entries.length});},abort(){sealed=true;failed=true;}};
  },
 };
}
