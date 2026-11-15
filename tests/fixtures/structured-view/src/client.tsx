import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { validateInputContent, type StructuredInput, type InputContent, type InputSubmission } from '@aork/contracts/structured-input';
function Form({ runtime }: ViewProps) {
  const sessionId = new URLSearchParams(location.hash.slice(1)).get('session');
  const [values, setValues] = useState<StructuredInput[]>([]);
  const [queryError, setQueryError] = useState('');
  const [error, setError] = useState('');
  const [content, setContent] = useState<InputContent>(()=>Object.create(null));
  const [busy, setBusy] = useState(false);
  const value = values.find(value => value.state === 'pending');
  useEffect(() => {
    if (!sessionId) return;
    return runtime.observeSnapshot<{ interactions: StructuredInput[] }>('interactions.inputHistory', { sessionId }, {
      next(snapshot) { setValues(snapshot.interactions); setQueryError(''); },
      error(failure) { setQueryError(failure.message); },
    }, { owners: ['interactions'] });
  }, [runtime, sessionId]);
  useEffect(() => {
    setContent(Object.assign(Object.create(null),Object.fromEntries(Object.entries(value?.requestedSchema.properties ?? {}).filter(([, field]) => field.default != null).map(([name, field]) => [name, field.default!]))));
  }, [value?.id]);
  async function submit(submission:InputSubmission) {
    if (!value || busy || queryError) return;
    if (submission.action==='accept') {
      const errors=validateInputContent(value.requestedSchema,submission.content);
      if (Object.keys(errors).length) {setError(Object.values(errors).join('；'));return;}
    }
    setBusy(true); setError('');
    try { await runtime.command('interactions.submit',{interactionId:value.id,...submission},crypto.randomUUID(),{version:1}); }
    catch (failure) { setError(failure instanceof Error?failure.message:'Response rejected'); }
    finally {setBusy(false);}
  }
  if (!value) return null;
  return <form aria-label="独立信息表单" noValidate onSubmit={event=>{event.preventDefault();void submit({action:'accept',content});}}>
    <p>独立插件：{value.title}</p>
    {Object.entries(value.requestedSchema.properties).map(([name,field])=>{
      const props={style:{maxWidth:'100%'},'aria-label':`独立 ${field.title??name}`,disabled:busy||Boolean(queryError),value:content[name]===undefined?'':String(content[name])};
      const change=(raw:string)=>setContent(previous=>Object.assign(Object.create(null),previous,{[name]:field.type==='number'||field.type==='integer'?Number(raw):field.type==='boolean'?raw==='true':raw}));
      return <label key={name} style={{display:'block'}}>独立 {field.title??name}
        {field.type==='boolean'?<select {...props} onChange={event=>change(event.target.value)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>:field.type==='string'&&field.enum?<select {...props} onChange={event=>change(event.target.value)}><option value="">请选择</option>{field.enum.map(option=><option key={option} value={option}>{option}</option>)}</select>:<input {...props} type={field.type==='string'?'text':'number'} onChange={event=>change(event.target.value)}/>}
      </label>;
    })}
    <button disabled={busy||Boolean(queryError)}>独立发送信息</button>
    <button type="button" disabled={busy||Boolean(queryError)} onClick={()=>void submit({action:'decline'})}>独立拒绝提供</button>
    <button type="button" disabled={busy||Boolean(queryError)} onClick={()=>void submit({action:'cancel'})}>独立取消填写</button>
    {(error||queryError)&&<p role="alert">{error||queryError}</p>}
  </form>;
}
export function activate(context: ClientPluginContext) { context.registerView('form', Form); }
