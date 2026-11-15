import type * as acp from '@agentclientprotocol/sdk';
import { negotiatedInputSchema } from '@aork/contracts/input';
import type { NegotiatedInput } from '@aork/contracts/input';

/** Strip opaque Agent metadata; reject oversized/ambiguous options rather than invent choices. */
export function negotiatedInput(capabilities:acp.PromptCapabilities|undefined, native:Pick<acp.NewSessionResponse,'modes'|'configOptions'>, revision=1):NegotiatedInput {
  const value=negotiatedInputSchema.parse({revision,prompt:{image:capabilities?.image===true,audio:capabilities?.audio===true,embeddedContext:capabilities?.embeddedContext===true},
    ...(native.modes?{modes:{currentModeId:native.modes.currentModeId,availableModes:native.modes.availableModes.map(mode=>({id:mode.id,name:mode.name}))}}:{}),
    configOptions:(native.configOptions??[]).map(option=>({id:option.id,name:option.name,...(option.category?{category:option.category}:{}),type:option.type,currentValue:option.currentValue,...(option.type==='select'?{options:option.options.flatMap(item=>'group'in item?item.options.map(choice=>({value:choice.value,name:choice.name,group:item.name})):[{value:item.value,name:item.name}])}:{})}))});
  if(new Set(value.configOptions.map(item=>item.id)).size!==value.configOptions.length)throw Error('Duplicate configuration IDs');
  for(const option of value.configOptions)if(option.type==='select'&&(new Set(option.options.map(item=>item.value)).size!==option.options.length||!option.options.some(item=>item.value===option.currentValue)))throw Error('Invalid configuration selection');
  if(value.modes&&(new Set(value.modes.availableModes.map(mode=>mode.id)).size!==value.modes.availableModes.length||!value.modes.availableModes.some(mode=>mode.id===value.modes!.currentModeId)))throw Error('Invalid mode selection');
  if(Buffer.byteLength(JSON.stringify(value))>16000)throw Error('Negotiated configuration exceeds durable bounds');
  return value;
}
