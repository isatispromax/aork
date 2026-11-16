/** The only controlled substitute is the external ACP process. It records native wire in its Workspace. */
export function negotiatedAgent(rich = true) {
  return `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
let mode='inspect';let config=${JSON.stringify(rich ? [{id:'engine',name:'Research model',category:'model',type:'select',currentValue:'research-small',options:[{group:'research',name:'Research family',options:[{value:'research-small',name:'Research Small'},{value:'research-large',name:'Research Large'}]}]},{id:'careful',name:'Careful reasoning',category:'_custom',type:'boolean',currentValue:false}] : [{id:'style',name:'Answer style',type:'select',currentValue:'brief',options:[{value:'brief',name:'Brief'},{value:'long',name:'Long'}]}])};
config=config.map(option=>({...option,_meta:{token:'agent-private-config'}}));
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('negotiated-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentInfo:{name:${JSON.stringify(rich ? 'Rich research' : 'Text only')},version:'1.2.3'},agentCapabilities:{promptCapabilities:${JSON.stringify(rich ? {embeddedContext:true,image:true} : {})}},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-negotiated',_meta:{token:'agent-private-native'},configOptions:config,...(${rich}?{modes:{currentModeId:mode,availableModes:[{id:'inspect',name:'Inspect'},{id:'write',name:'Write'}]}}:{})}});
if(r.method==='session/set_mode'){mode=r.params.modeId;send({id:r.id,result:{}});}
if(r.method==='session/set_config_option'){config=config.map(c=>c.id===r.params.configId?{...c,currentValue:r.params.value}:c);send({id:r.id,result:{configOptions:config}});}
if(r.method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-negotiated',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Negotiated answer'}}}});send({id:r.id,result:{stopReason:'end_turn'}});}});`;
}
