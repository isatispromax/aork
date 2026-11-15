import { useEffect, useState } from 'react';
import type { ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { attachmentReferenceSchema, INPUT_LIMITS } from '@aork/contracts/input';
import type { AttachmentReference, ConfigurationChange, SessionInputContext } from '@aork/contracts/input';
import { sessionsOverviewSchema } from '@aork/contracts/session';
import type { SessionsOverview } from '@aork/contracts/session';
import type { RuntimeRun } from '@aork/contracts/runtime';
import type { FileListing, FileSearch } from '@aork/contracts/workspace';
import styles from './sessions.module.css';
function inputContext(value:unknown):value is SessionInputContext{
  if(!value||typeof value!=='object')return false;const context=value as Partial<SessionInputContext>;
  return context.version===1&&typeof context.sessionId==='string'&&typeof context.disabled==='boolean'&&typeof context.onAttachmentsChange==='function'&&attachmentReferenceSchema.array().max(INPUT_LIMITS.attachments).safeParse(context.attachments).success;
}
export function InputOptions({runtime,context}:ViewProps){
  if(!inputContext(context))return <p role="alert">输入选项需要版本 1 的公开 SessionInputContext。</p>;
  return <Options runtime={runtime} input={context}/>;
}
function Options({runtime,input}:ViewProps&{input:SessionInputContext}){
  const [overview,setOverview]=useState<SessionsOverview>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [accepted,setAccepted]=useState<string>();
  const [files,setFiles]=useState<FileListing['entries']>([]);const [file,setFile]=useState('');const [query,setQuery]=useState('');const [kind,setKind]=useState<AttachmentReference['kind']>('text');
  const entry=overview?.sessions.find(entry=>entry.session.id===input.sessionId);const run=entry?.execution.state==='not-started'?undefined:entry?.execution;const negotiated=run?.negotiated;
  const pending=Boolean(run?.configuration&&['accepted','dispatching','delivery_unknown'].includes(run.configuration.state));const disabled=input.disabled||busy||pending||Boolean(accepted);
  useEffect(()=>{let active=true;const stop=runtime.subscribe<SessionsOverview>('sessions.overview',{next(value){if(active){const next=sessionsOverviewSchema.parse(value);setOverview(next);const run=next.sessions.find(entry=>entry.session.id===input.sessionId)?.execution;if(run&&run.state!=='not-started'&&run.configuration&&run.configuration.id===accepted&&!['accepted','dispatching'].includes(run.configuration.state))setAccepted(undefined);}},error(failure){if(active)setError(failure.message);}},{intervalMs:500});return()=>{active=false;void stop();};},[runtime,input.sessionId,accepted]);
  const supported:AttachmentReference['kind'][]=negotiated?[...(negotiated.prompt.embeddedContext?['text' as const]:[]),...(negotiated.prompt.image?['image' as const]:[]),...(negotiated.prompt.audio?['audio' as const]:[])]:[];
  useEffect(()=>{if(supported.length&&!supported.includes(kind))setKind(supported[0]!);},[negotiated?.revision,run?.runId]);
  async function configure(change:ConfigurationChange){if(!run||!negotiated||disabled)return;setBusy(true);setError('');try{const receipt=await runtime.command<CommandReceipt<RuntimeRun>>('sessions.configureRun',{runId:run.runId,generation:run.generation,expectedRevision:negotiated.revision,change},crypto.randomUUID());setAccepted(receipt.result.configuration?.id);}catch(failure){setError(failure instanceof Error?failure.message:'配置结果未确认，请刷新运行状态。');}finally{setBusy(false);}}
  async function browse(){if(!entry)return;setBusy(true);setError('');try{const response=await runtime.resource(query?'workspace.search':'workspace.files',query?{workspaceId:entry.session.workspaceId,query}:{workspaceId:entry.session.workspaceId,path:''});const result=JSON.parse(new TextDecoder().decode(response.bytes)) as FileListing|FileSearch;setFiles(result.entries.filter(item=>item.kind==='file'));if(result.truncated)setError('文件列表已截断，请使用更精确的文件名搜索。');}catch(failure){setError(failure instanceof Error?failure.message:'读取工作区文件失败');}finally{setBusy(false);}}
  return <section className={styles.inputOptions} aria-label="Agent 输入选项">
    {negotiated&&<div className={styles.configOptions}>
      {negotiated.modes&&<label>运行模式<select disabled={disabled} value={negotiated.modes.currentModeId} onChange={event=>void configure({kind:'mode',modeId:event.target.value})}>{negotiated.modes.availableModes.map(mode=><option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label>}
      {negotiated.configOptions.map(option=><label key={option.id}>{option.name}{option.type==='boolean'?<input type="checkbox" disabled={disabled} checked={option.currentValue} onChange={event=>void configure({kind:'option',configId:option.id,value:event.target.checked})}/>:<select disabled={disabled} value={option.currentValue} onChange={event=>void configure({kind:'option',configId:option.id,value:event.target.value})}>{option.options.map(choice=><option key={choice.value} value={choice.value}>{choice.group?`${choice.group} · `:''}{choice.name}</option>)}</select>}</label>)}
    </div>}
    {run?.configuration&&<p role="status">{({accepted:'配置变更已受理',dispatching:'正在确认配置',applied:'配置已确认',failed:'配置变更失败',delivery_unknown:'配置结果未知'})[run.configuration.state]}{run.configuration.reason?` · ${run.configuration.reason}`:''}</p>}
    {negotiated&&!supported.length&&<p className={styles.hint}>此 Agent 未协商附件内容输入。</p>}
    {supported.length>0&&<details onToggle={event=>{if(event.currentTarget.open&&!files.length)void browse();}}><summary>添加工作区附件</summary><p className={styles.hint}>请在启动 Run 前于文件面板上传；Run 占用工作区时上传会被拒绝。每个文件最多 128 KiB，输入合计最多 256 KiB。受理时保存内容快照。</p><div className={styles.attachmentPicker}><label>文件名搜索<input value={query} maxLength={120} onChange={event=>setQuery(event.target.value)}/></label><button type="button" disabled={busy} onClick={()=>void browse()}>查找文件</button><label>工作区文件<select value={file} onChange={event=>setFile(event.target.value)}><option value="">选择文件</option>{files.map(item=><option key={item.path} value={item.path}>{item.path} · {item.size} B</option>)}</select></label><label>附件类型<select value={kind} onChange={event=>setKind(event.target.value as AttachmentReference['kind'])}>{supported.map(kind=><option key={kind} value={kind}>{({text:'文字上下文',image:'图片',audio:'音频'})[kind]}</option>)}</select></label><button type="button" disabled={disabled||!file||input.attachments.length>=INPUT_LIMITS.attachments} onClick={()=>{if(input.attachments.some(item=>item.path===file&&item.kind===kind)){setError('此附件已在输入中。');return;}input.onAttachmentsChange([...input.attachments,{path:file,kind}]);}}>添加附件</button></div></details>}
    {input.attachments.length>0&&<ul className={styles.attachments}>{input.attachments.map((item,index)=><li key={`${item.path}:${item.kind}`}><span>{item.path} · {item.kind}</span><button type="button" disabled={input.disabled} aria-label={`移除附件 ${item.path}`} onClick={()=>input.onAttachmentsChange(input.attachments.filter((_,position)=>position!==index))}>×</button></li>)}</ul>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
