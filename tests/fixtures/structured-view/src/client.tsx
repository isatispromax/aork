import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { validateInputContent, type StructuredInput, type InputContent } from '@aork/contracts/structured-input';
function Form({ runtime }: ViewProps) {
    const sessionId = new URLSearchParams(location.hash.slice(1)).get('session');
    const [values, setValues] = useState<StructuredInput[]>([]);
    const [error, setError] = useState('');
    const [content, setContent] = useState<InputContent>({});
    const [busy, setBusy] = useState(false);
    const value = values.find(value => value.state === 'pending');
    useEffect(() => { if (!sessionId)
        return; return runtime.observeSnapshot<{
        interactions: StructuredInput[];
    }>('interactions.inputHistory', { sessionId }, { next(snapshot) { setValues(snapshot.interactions); }, error(failure) { setError(failure.message); } }, { owners: ['interactions'] }); }, [runtime, sessionId]);
    useEffect(() => { setContent(Object.fromEntries(Object.entries(value?.requestedSchema.properties ?? {}).filter(([, field]) => field.default != null).map(([name, field]) => [name, field.default!]))); }, [value?.id]);
    if (!value)
        return null;
    return <form aria-label="独立信息表单" noValidate onSubmit={async (event) => { event.preventDefault(); if (busy)
        return; const errors = validateInputContent(value.requestedSchema, content); if (Object.keys(errors).length) {
        setError(Object.values(errors).join('；'));
        return;
    } setBusy(true); try {
        await runtime.command('interactions.submit', { interactionId: value.id, action: 'accept', content }, crypto.randomUUID(), { version: 1 });
    }
    catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Response rejected');
    }
    finally {
        setBusy(false);
    } }}>
 <p>独立插件：{value.title}</p>{Object.entries(value.requestedSchema.properties).map(([name, field]) => <label key={name} style={{ display: 'block' }}>独立 {field.title ?? name}<input aria-label={`独立 ${field.title ?? name}`} value={content[name] === undefined ? '' : String(content[name])} disabled={busy} onChange={event => setContent(previous => ({ ...previous, [name]: field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : field.type === 'boolean' ? event.target.value === 'true' : event.target.value }))}/></label>)}
 <button disabled={busy}>独立发送信息</button>{error && <p role="alert">{error}</p>}</form>;
}
export function activate(context: ClientPluginContext) { context.registerView('form', Form); }
