import * as acp from '@agentclientprotocol/sdk';
import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import type { ConfigurationChange, NegotiatedInput } from '@aork/contracts/input';
import type { RuntimeRun } from '@aork/contracts/runtime';
import type { Operation, operationRepository } from './persistence/repository.js';
import { negotiatedInput, validateNegotiatedInput } from './negotiated.js';
export function validateChange(value:NegotiatedInput,change:ConfigurationChange){
  const option=change.kind==='option'?value.configOptions.find(item=>item.id===change.configId):undefined;
  if(change.kind==='mode'? !value.modes?.availableModes.some(mode=>mode.id===change.modeId):!option||(option.type==='boolean'?typeof change.value!=='boolean':!option.options.some(item=>item.value===change.value)))throw new AorkError('RUN_CONFIGURATION_UNSUPPORTED','This Run did not negotiate that configuration value',409);
}
export function configurationEngine(context:ServerPluginContext,repository:ReturnType<typeof operationRepository>,publish:(op:Operation,state:RuntimeRun['state'],details?:Partial<RuntimeRun>|((current:Operation)=>Partial<RuntimeRun>))=>RuntimeRun|undefined){
  const live=new Map<string,{agent:acp.ClientContext;nativeSessionId:string;stop:(reason:string)=>Promise<void>;task?:Promise<void>;closed:boolean;generation:number;hostEpoch:string}>();
  return{
    ready(op:Operation,agent:acp.ClientContext,nativeSessionId:string,stop:(reason:string)=>Promise<void>){live.set(op.launch.run.runId,{agent,nativeSessionId,stop,closed:false,generation:op.launch.run.generation,hostEpoch:op.launch.run.hostEpoch});},
    update(op:Operation,params:acp.SessionNotification){const connection=live.get(op.launch.run.runId);if(!connection||connection.closed||params.sessionId!==connection.nativeSessionId)return;const update=params.update;if(update.sessionUpdate!=='current_mode_update'&&update.sessionUpdate!=='config_option_update')return;
      try{const current=repository.get(op.launch.run.runId);const value=current?.launch.run.negotiated;if(!current||current.stopRequested||current.state!=='ready'||!value)return;let next:NegotiatedInput;
        if(update.sessionUpdate==='current_mode_update'){validateChange(value,{kind:'mode',modeId:update.currentModeId});next={...value,revision:value.revision+1,modes:{...value.modes!,currentModeId:update.currentModeId}};}
        else{next=negotiatedInput(value.prompt,{configOptions:update.configOptions},value.revision+1);if(value.modes)next.modes=value.modes;}
        publish(current,'ready',{negotiated:validateNegotiatedInput(next)});
      }catch{void connection.stop('Agent sent invalid configuration state; managed execution was stopped.').catch(()=>{});}
    },
    accept(tx:SyncTransaction,owner:OwnerDescriptor,input:{runId:string;generation:number;expectedRevision:number;id:string;change:ConfigurationChange}){
      context.verifyOwner(owner);const op=repository.get(input.runId,tx);const run=op?.launch.run;const connection=live.get(input.runId);
      if(!op||!run||op.state!=='ready'||op.stopRequested||op.launch.owner.pluginId!==owner.pluginId||run.generation!==input.generation||run.hostEpoch!==context.owner.hostEpoch||!connection||connection.closed)throw new AorkError('RUN_NOT_READY','Run is unavailable for configuration',409);
      if(!run.negotiated||run.negotiated.revision!==input.expectedRevision)throw new AorkError('RUN_CONFIGURATION_CHANGED','Configuration changed; reload the current Run options',409);
      if(run.configuration&&['accepted','dispatching'].includes(run.configuration.state)||repository.prompts(tx).some(prompt=>prompt.runId===input.runId&&prompt.state!=='terminal'))throw new AorkError('RUN_CONFIGURATION_BUSY','Wait for the current Turn or configuration operation',409);
      validateChange(run.negotiated,input.change);const configuration={id:input.id,expectedRevision:input.expectedRevision,sequence:(run.configuration?.sequence??0)+1,state:'accepted' as const,change:input.change};repository.update(tx,{...op,launch:{...op.launch,run:{...run,configuration}}});return configuration;
    },
    tick(){for(const op of repository.active()){
      const run=op.launch.run;const intent=run.configuration;const connection=live.get(run.runId);
      if(op.state!=='ready'||op.stopRequested||intent?.state!=='accepted'||!connection||connection.closed||connection.task)continue;
      // Commit the send attempt before touching external I/O. Never replay it after restart.
      let initiated:RuntimeRun|undefined;
      try{initiated=publish(op,'ready',current=>{
        const latest=current.launch.run;const accepted=latest.configuration;
        if(accepted?.id!==intent.id||accepted.state!=='accepted')return{};
        const stale=current.state!=='ready'||latest.runId!==run.runId||latest.generation!==connection.generation||latest.hostEpoch!==connection.hostEpoch||latest.hostEpoch!==context.owner.hostEpoch||accepted.expectedRevision===undefined||latest.negotiated?.revision!==accepted.expectedRevision;
        try{if(stale||!latest.negotiated)throw Error('Stale configuration');validateChange(latest.negotiated,accepted.change);}
        catch{return{configuration:{...accepted,state:'failed',reason:'Run configuration changed before native configuration dispatch. Choose from the current Run options.'}};}
        return{configuration:{...accepted,state:'dispatching'}};
      });}catch{void connection.stop('Configuration dispatch persistence failed; managed execution was stopped.').catch(()=>{});continue;}
      if(initiated?.configuration?.id!==intent.id||initiated.configuration.state!=='dispatching')continue;
      connection.task=(async()=>{let timeout:ReturnType<typeof setTimeout>|undefined;
        try{const before=repository.get(run.runId);if(!before?.launch.run.negotiated||connection.closed)throw Error('Connection closed');const current=before.launch.run.negotiated;validateChange(current,intent.change);
          const change=intent.change;const request=change.kind==='mode'?connection.agent.request(acp.methods.agent.session.setMode,{sessionId:connection.nativeSessionId,modeId:change.modeId}).then(()=>undefined):connection.agent.request(acp.methods.agent.session.setConfigOption,{sessionId:connection.nativeSessionId,configId:change.configId,...(typeof change.value==='boolean'?{type:'boolean' as const,value:change.value}:{value:change.value})});
          const result=await Promise.race([request,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Configuration timeout')),5000);})]);
          if(connection.closed)return;
          const latest=repository.get(run.runId)?.launch.run.negotiated;if(!latest)throw Error('Configuration disappeared');
          let next:NegotiatedInput;
          if(change.kind==='mode')next={...latest,revision:latest.revision+1,modes:{...latest.modes!,currentModeId:change.modeId}};
          else{if(!result)throw Error('Missing authoritative options');next=negotiatedInput(latest.prompt,{configOptions:result.configOptions},latest.revision+1);if(latest.modes)next.modes=latest.modes;}
          publish(op,'ready',{negotiated:validateNegotiatedInput(next),configuration:{...intent,state:'applied'}});
        }catch(error){if(!connection.closed){const definitive=error instanceof acp.RequestError;publish(op,'ready',{configuration:{...intent,state:definitive?'failed':'delivery_unknown',reason:definitive?`Agent rejected configuration (code ${error.code}).`:'Configuration result is uncertain; this Run must stop before more input.'}});if(!definitive)await connection.stop('Configuration result is uncertain; managed execution was stopped.');}}
        finally{if(timeout)clearTimeout(timeout);delete connection.task;}
      })().catch(()=>{void connection.stop('Configuration persistence failed; managed execution was stopped.').catch(()=>{});});
    }},
    revoke(runId:string){const connection=live.get(runId);if(connection)connection.closed=true;const op=repository.get(runId);const intent=op?.launch.run.configuration;if(op&&intent&&['accepted','dispatching'].includes(intent.state))publish(op,'stopping',{configuration:{...intent,state:intent.state==='accepted'?'failed':'delivery_unknown',reason:intent.state==='accepted'?'Run stopped before configuration dispatch.':'Run stopped before a definitive configuration result.'}});},
    async drain(){await Promise.all([...live.values()].map(item=>item.task));live.clear();},
  };
}
