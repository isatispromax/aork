import { useRef, useState } from 'react';
import type { ViewProps } from '@aork/sdk/client';
import { STRUCTURED_FORM, structuredInputSchema, validateInputContent, type InputContent, type InputSubmission, type StructuredInput } from '@aork/contracts/structured-input';
import { selectRequest, useRequestFocus, useRequests } from './requests.js';
import styles from './permissions.module.css';
const labels: Record<StructuredInput['state'], string> = { pending: '等待补充信息', responding: '响应已受理，等待发送确认', responded: '已发送响应', expired: '响应通道已失效', cancelled: '响应已取消', delivery_unknown: '响应交付结果未知，请勿重复发送', invalidated: '响应通道已失效' };
export function InputCards({ runtime }: ViewProps) {
    const { values, diagnostics, requested, historyError, truncated } = useRequests(runtime, 'input', structuredInputSchema.parse);
    if (!values.length && !diagnostics.length && !historyError && !requested) return null;
    return <section className={styles.cards} aria-label="信息请求">
        <header>Agent 信息请求</header>
        {diagnostics.map(value => <p className={styles.diagnostic} role="status" key={value.id}>{value.message}</p>)}
        {values.map(value => <article key={value.id}>
            <strong>{value.title}</strong>
            <small>来源：{value.source.providerId}{value.source.toolCallId ? ` · 工具 ${value.source.toolCallId}` : ''}</small>
            <p role="status">{labels[value.state]}</p>
            {value.reason && <p>{value.reason}</p>}
            {value.state === 'pending' && <button aria-pressed={value.id === requested} onClick={() => selectRequest('input', value.id)}>填写信息</button>}
        </article>)}
        {runtime.renderView(STRUCTURED_FORM)}
        {truncated && <p>较早的信息请求历史已截断；有效请求优先显示。</p>}
        {historyError && <p role="alert">{historyError}</p>}
    </section>;
}
interface Attempt {
    interactionId: string;
    submission: InputSubmission;
    commandId: string;
}
const definite = new Set(['INTERACTION_CLOSED', 'INTERACTION_UNAVAILABLE', 'INTERACTION_FIELDS_INVALID', 'INVALID_PAYLOAD', 'REQUEST_TOO_LARGE']);
export function StructuredForm({ runtime }: ViewProps) {
    const { value, selected, actionError: queryError, opening } = useRequests(runtime, 'input', structuredInputSchema.parse);
    const heading = useRequestFocus(selected?.id);
    const [attempt, setAttempt] = useState<Attempt>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const sending = useRef(false);
    async function send(submission: InputSubmission, retry = false) {
        if (sending.current || !retry && (value?.state !== 'pending' || opening || queryError || attempt))
            return;
        const next = retry ? attempt : value ? { interactionId: value.id, submission, commandId: crypto.randomUUID() } : undefined;
        if (!next)
            return;
        sending.current = true;
        setBusy(true);
        setError('');
        setAttempt(next);
        try {
            await runtime.command('interactions.submit', { interactionId: next.interactionId, ...next.submission }, next.commandId, { version: 1 });
            setAttempt(undefined);
        }
        catch (failure) {
            if (failure instanceof Error && 'code' in failure && definite.has(String(failure.code)))
                setAttempt(undefined);
            setError(failure instanceof Error ? failure.message : '响应受理结果未确认');
        }
        finally {
            sending.current = false;
            setBusy(false);
        }
    }
    if (!value && !attempt && !opening)
        return queryError ? <p role="alert">{queryError}</p> : null;
    return <div className={styles.form}>
        {selected && <h3 ref={heading} tabIndex={-1}>信息请求：{selected.title}</h3>}
        {opening && <p role="status">正在读取信息请求…</p>}
        {value?.state === 'pending' && <Fields key={value.id} value={value} disabled={busy || Boolean(attempt) || Boolean(queryError) || opening} send={send} />}
        {attempt && !busy && <button onClick={() => void send(attempt.submission, true)}>重试同一响应</button>}
        {(error || queryError) && <p role="alert">{error || queryError}</p>}
    </div>;
}
function Fields({ value, disabled, send }: {
    value: StructuredInput;
    disabled: boolean;
    send: (submission: InputSubmission) => Promise<void>;
}) {
    const [content, setContent] = useState<InputContent>(() => Object.assign(Object.create(null), Object.fromEntries(Object.entries(value.requestedSchema.properties).filter(([, field]) => field.default != null).map(([name, field]) => [name, field.default!]))));
    const [errors, setErrors] = useState<Record<string, string>>(() => Object.create(null));
    function change(name: string, raw: string, type: string) { setContent(previous => { const next: InputContent = Object.assign(Object.create(null), previous); if (raw === '' && type !== 'string')
        delete next[name];
    else
        next[name] = type === 'boolean' ? raw === 'true' : type === 'number' || type === 'integer' ? Number(raw) : raw; return next; }); }
    return <form aria-label="结构化输入表单" noValidate onSubmit={event => { event.preventDefault(); if (disabled)
        return; const errors = validateInputContent(value.requestedSchema, content); setErrors(errors); if (!Object.keys(errors).length)
        void send({ action: 'accept', content }); }}>
 <p>请检查信息后发送。仅用于工作信息，请勿填写密码、密钥或支付凭据。</p>{value.requestedSchema.description && <p>{value.requestedSchema.description}</p>}
 {Object.entries(value.requestedSchema.properties).map(([name, field]) => {
            const id = `input-${value.id}-${name}`;
            const errorId = `${id}-error`;
            const helpId = `${id}-help`;
            const common = { id, disabled, 'aria-invalid': Boolean(errors[name]), 'aria-describedby': [field.description ? helpId : '', errors[name] ? errorId : ''].filter(Boolean).join(' ') || undefined, required: value.requestedSchema.required?.includes(name) };
            return <div className={styles.field} key={name}><label htmlFor={id}>{field.title ?? name}</label>{common.required && <small>必填</small>}
 {field.type === 'boolean' ? <select {...common} value={content[name] === undefined ? '' : String(content[name])} onChange={event => change(name, event.target.value, field.type)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : field.type === 'string' && field.enum ? <select {...common} value={content[name] === undefined ? '' : String(field.enum.indexOf(String(content[name])))} onChange={event => { const option = event.target.value; setContent(previous => { const next: InputContent = Object.assign(Object.create(null), previous); if (option === '')
                delete next[name];
            else
                next[name] = field.enum![Number(option)]!; return next; }); }}><option value="">请选择</option>{field.enum.map((option, index) => <option key={index} value={index}>{option}</option>)}</select> : <input {...common} type={field.type === 'string' ? 'text' : 'number'} value={content[name] === undefined ? '' : String(content[name])} maxLength={field.type === 'string' ? 2 * (field.maxLength ?? 2000) : undefined} min={field.type === 'number' || field.type === 'integer' ? field.minimum ?? undefined : undefined} max={field.type === 'number' || field.type === 'integer' ? field.maximum ?? undefined : undefined} step={field.type === 'integer' ? 1 : 'any'} onChange={event => change(name, event.target.value, field.type)}/>}
 {field.description && <small id={helpId}>{field.description}</small>}{errors[name] && <p role="alert" id={errorId}>{errors[name]}</p>}</div>;
        })}
 {errors['']&&<p role="alert">{errors['']}</p>}<div className={styles.actions}><button type="submit" disabled={disabled}>发送信息</button><button type="button" disabled={disabled} onClick={() => void send({ action: 'decline' })}>拒绝提供</button><button type="button" disabled={disabled} onClick={() => void send({ action: 'cancel' })}>取消填写</button></div></form>;
}
