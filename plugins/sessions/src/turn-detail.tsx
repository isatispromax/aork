import { useEffect, useRef, useState } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import { SESSION_TURN_DETAIL, turnDetailSchema } from '@aork/contracts/session';
import type { TurnDetail } from '@aork/contracts/session';
import styles from './sessions.module.css';

/** Every provider can use this same public owner-scoped resource/schema. */
export function TurnDetails({runtime,turnId,label}:{runtime:UiRuntime;turnId:string;label:string}){
  const[detail,setDetail]=useState<TurnDetail>();const[error,setError]=useState('');const[busy,setBusy]=useState(false);const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  async function load(){if(busy||detail)return;setBusy(true);setError('');try{const response=await runtime.resource(SESSION_TURN_DETAIL,{turnId});const value=turnDetailSchema.parse(JSON.parse(new TextDecoder().decode(response.bytes)));if(live.current)setDetail(value);}catch(failure){if(live.current)setError(failure instanceof Error?failure.message:'读取原始输入失败');}finally{if(live.current)setBusy(false);}}
  return <details className={styles.inputDetail} onToggle={event=>{if(event.currentTarget.open)void load();}}><summary aria-label={label}>完整输入与配置</summary>{busy&&<p role="status">正在读取原始输入…</p>}{error&&<p role="alert">{error}</p>}{detail&&<section aria-label="轮次原始输入与配置"><h4>原始输入</h4><pre>{detail.input.text}</pre>{detail.turn.configuration&&<><h4>受理时的配置</h4><pre>{JSON.stringify(detail.turn.configuration,null,2)}</pre></>}{detail.turn.attachments?.length?<><h4>受理时的附件引用</h4><ul>{detail.turn.attachments.map(item=><li key={`${item.kind}:${item.path}`}>{item.path} · {item.kind} · {item.size} B</li>)}</ul></>:null}</section>}</details>;
}
