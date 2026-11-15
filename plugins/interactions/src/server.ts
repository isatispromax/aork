import { isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { ACP_RUNTIME, type AcpRuntime } from '@aork/contracts/runtime';
import { INTERACTIONS_SERVICE,permissionSchema } from '@aork/contracts/interaction';
import { interactionRepository } from './persistence/repository.js';
export {persistence} from './persistence/repository.js';
export function activate(context:ServerPluginContext){
 const repository=interactionRepository(context.repository);let runtime:AcpRuntime|undefined;try{runtime=context.service<AcpRuntime>(ACP_RUNTIME);}catch(error){if(!isAorkError(error)||error.code!=='SERVICE_UNAVAILABLE')throw error;}
 context.transactions.run(tx=>{for(const row of repository.list(tx))if(row.interaction.state==='pending'&&row.interaction.hostEpoch!==context.owner.hostEpoch)repository.put(tx,row.principal,{...row.interaction,state:'invalidated',reason:'Host restarted; the old Agent response channel is closed.'});});
 if(runtime)context.consumeFacts(runtime.permissionFacts,{id:'pendingProjection',events:{'interactions.changed':{version:1,payload:permissionSchema}},apply(fact,tx){const value=fact.payload;const interaction=value.interaction.hostEpoch!==context.owner.hostEpoch&&value.interaction.state==='pending'?{...value.interaction,state:'invalidated' as const,reason:'The old response channel is closed.'}:value.interaction;repository.put(tx,value.principal,interaction);return{principal:value.principal,events:[{type:'interactions.changed',version:1,entityId:interaction.id,payload:interaction}]};}});
 context.query('interactions.pending',{access:'authenticated',execute(request){return{pending:repository.list().filter(row=>row.principal===request.identity&&row.interaction.state==='pending').slice(-100).map(row=>row.interaction)};}});
 context.provide(INTERACTIONS_SERVICE,Object.freeze({ownerId:context.pluginId}));
}
