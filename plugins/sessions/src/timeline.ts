import { AorkError } from '@aork/sdk';
import { sessionTimelineSchema } from '@aork/contracts/session';
import type { SessionTimeline, Turn } from '@aork/contracts/session';

const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const actionable=(turn:Turn)=>['accepted','queued','dispatching','running','cancelling'].includes(turn.state);
function preview(text:string){
  if(size(text)<=512)return text;
  let result='';let bytes=2;
  for(const point of text){const next=size(point)-2;if(bytes+next>512)break;result+=point;bytes+=next;}
  return result;
}
/** Bounded display projection only. Full original records remain in the owner repository. */
export function boundedTimeline(input:SessionTimeline,reservedBytes=0):SessionTimeline{
  const budget=900000-reservedBytes;
  const value=sessionTimelineSchema.parse(input);
  while(value.turns.length>150){const index=value.turns.findIndex(turn=>!actionable(turn));if(index<0)break;value.turns.splice(index,1);value.truncated=true;}
  const visible=new Set(value.turns.map(turn=>turn.id));
  value.messages=value.messages.filter(message=>visible.has(message.turnId));value.tools=value.tools.filter(tool=>visible.has(tool.turnId));
  if(size(value)<=budget)return value;

  const protectedInputs=new Set(value.turns.filter(actionable).map(turn=>`${turn.id}:user`));
  value.turns=value.turns.map(turn=>{
    const{configuration,attachments,...summary}=turn;
    return configuration!==undefined||attachments!==undefined?{...summary,detailsOmitted:true as const,...(configuration?{configurationRevision:configuration.revision}:{}),...(attachments?{attachmentCount:attachments.length}:{})}:summary;
  });
  value.messages=value.messages.map(message=>{
    if(!protectedInputs.has(message.id))return message;
    const text=preview(message.text);return text===message.text?message:{...message,text,truncated:true as const};
  });
  value.truncated=true;
  let bytes=size(value);
  function remove<T>(items:T[],index:number){const charge=size(items[index])+(items.length>1?1:0);items.splice(index,1);bytes-=charge;}
  while(bytes>budget){
    const message=value.messages.findIndex(message=>!protectedInputs.has(message.id));
    if(message>=0){remove(value.messages,message);continue;}
    if(value.tools.length){remove(value.tools,0);continue;}
    const historical=value.turns.findIndex(turn=>!actionable(turn));
    if(historical>=0){remove(value.turns,historical);continue;}
    // 101 actionable summaries and their 512-byte previews fit below this
    // budget under the accepted queue/DTO bounds. Never hide accepted work.
    throw new AorkError('TIMELINE_BOUNDS_EXCEEDED','Actionable history exceeds its supported display bounds',503);
  }
  return value;
}
