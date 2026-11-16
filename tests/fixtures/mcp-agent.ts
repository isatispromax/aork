import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createInterface} from 'node:readline';
import {isAbsolute,dirname} from 'node:path';
import {connect} from 'node:net';
import {lstat} from 'node:fs/promises';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
declare const AORK_MCP_FIXTURE_STATE:string;
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
const configuration=existsSync('mcp-native-config.json')?JSON.parse(readFileSync('mcp-native-config.json','utf8')):{};
const send=(value:unknown)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value as object})+'\n');
let activeCancel:AbortController|undefined;let client:Client;let list:Awaited<ReturnType<Client['listTools']>>;
async function openTools(parameters:{mcpServers:{command:string;args:string[];env:{name:string;value:string}[]}[]}){
 const descriptor=parameters.mcpServers[0];if(!descriptor||!isAbsolute(descriptor.command)||!isAbsolute(descriptor.args[0]!))throw Error('missing absolute actual bridge descriptor');
 client=new Client({name:'controlled-acp-mcp',version:'1'});const environment=Object.fromEntries(descriptor.env.map(entry=>[entry.name,entry.value]));const endpoint=environment.AORK_TOOL_SOCKET!,token=environment.AORK_RUN_TOKEN!;
 async function rejected(value:unknown,raw=false){return await new Promise<boolean>(resolve=>{const socket=connect(endpoint);let got=false;const timer=setTimeout(()=>{socket.destroy();resolve(false);},2500);socket.on('data',()=>{got=true;});socket.once('connect',()=>{if(raw){const head=Buffer.alloc(4);head.writeUInt32BE(2097152);socket.write(head);return;}const bytes=Buffer.from(JSON.stringify(value));const frame=Buffer.alloc(bytes.length+4);frame.writeUInt32BE(bytes.length);bytes.copy(frame,4);socket.write(frame);});socket.once('error',()=>{});socket.once('close',()=>{clearTimeout(timer);resolve(!got);});});}
 const protections={wrongToken:await rejected({kind:'auth',token:'A'.repeat(43)}),missingToken:await rejected({kind:'auth'}),selfSession:await rejected({kind:'auth',token,sessionId:'invented'}),oversizeFrame:await rejected(null,true),parentMode:(await lstat(dirname(endpoint))).mode&511,socketMode:(await lstat(endpoint)).mode&511};
 await client.connect(new StdioClientTransport({command:descriptor.command,args:descriptor.args,env:environment}));list=await client.listTools();writeFileSync('mcp-descriptor-shape.json',JSON.stringify({protections,absoluteNode:true,absoluteBridge:true,envNames:Object.keys(environment).sort(),tools:list.tools.map(tool=>({name:tool.name,title:tool.title}))}));
}
createInterface({input:process.stdin}).on('line',line=>{void(async()=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:configuration.loadSession===true,...(configuration.promptCapabilities?{promptCapabilities:configuration.promptCapabilities}:{})},agentInfo:{name:'mcp-controlled',version:'1.2.3'},authMethods:[]}});
 if(request.method==='session/new'){await openTools(request.params);if(configuration.loadSession)writeFileSync(AORK_MCP_FIXTURE_STATE,JSON.stringify([{role:'agent',text:'Saved MCP answer'}]));send({id:request.id,result:{sessionId:'mcp-native',...(configuration.configOptions?{configOptions:configuration.configOptions}:{}),...(configuration.modes?{modes:configuration.modes}:{})}});}
 if(request.method==='session/load'){
  await openTools(request.params);const writer=list.tools.find(tool=>tool.title==='Write workspace text');const denied=await client.callTool({name:writer!.name,arguments:{path:'replay-must-not-write.txt',text:'must be denied before readiness'}});writeFileSync('mcp-load-gate.json',JSON.stringify({denied:denied.isError===true}));
  for(const entry of JSON.parse(readFileSync(AORK_MCP_FIXTURE_STATE,'utf8')))send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:entry.role+'_message_chunk',content:{type:'text',text:entry.text}}}});
  writeFileSync('mcp-load-entered','entered');await new Promise<void>(resolve=>{const timer=setInterval(()=>{if(existsSync('mcp-load-release')){clearInterval(timer);resolve();}},10);});send({id:request.id,result:{...(configuration.configOptions?{configOptions:configuration.configOptions}:{})}});
 }
 if(request.method==='session/set_config_option'){const option=configuration.configOptions?.find((option:{id:string})=>option.id===request.params.configId);if(!option)throw Error('unknown configuration');option.currentValue=request.params.value;send({id:request.id,result:{configOptions:configuration.configOptions}});}
 if(request.method==='session/prompt'){
  const input=JSON.parse(request.params.prompt[0].text);if(input.disconnectBridge){await client.close();return;}
  if(input.backgroundTool){const tool=list.tools.find(tool=>tool.title===input.backgroundTool);void client.callTool({name:tool?.name??input.backgroundTool,arguments:input.arguments}).catch(()=>{});send({id:request.id,result:{stopReason:'end_turn'}});return;}
  if(input.repeatTool){const tool=list.tools.find(tool=>tool.title===input.repeatTool);if(!Number.isInteger(input.count)||input.count<1||input.count>110)throw Error('invalid repeat count');for(let index=0;index<input.count;index++)await client.callTool({name:tool?.name??input.repeatTool,arguments:input.arguments});send({id:request.id,result:{stopReason:'end_turn'}});return;}
  activeCancel=new AbortController();if(input.cancelAfterMs)setTimeout(()=>activeCancel?.abort(),input.cancelAfterMs);const tool=list.tools.find(tool=>tool.title===input.tool);let result:unknown;try{result=await client.callTool({name:tool?.name??input.tool,arguments:input.largeArgumentsBytes?{path:'large.txt',text:'x'.repeat(input.largeArgumentsBytes)}:input.arguments},{signal:activeCancel.signal});}catch{result={isError:true,content:[{type:'text',text:'MCP request rejected'}]};}
  send({method:'session/update',params:{sessionId:'mcp-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:input.summarize?JSON.stringify({resultBytes:Buffer.byteLength(JSON.stringify(result))}):JSON.stringify(result)}}}});send({id:request.id,result:{stopReason:activeCancel.signal.aborted?'cancelled':'end_turn'}});activeCancel=undefined;
 }
 if(request.method==='session/cancel')activeCancel?.abort();
})().catch(()=>{send({id:JSON.parse(line).id,error:{code:-32603,message:'controlled MCP operation failed'}});});});
