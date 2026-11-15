import { useEffect, useRef, useState } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { PERMISSION_FORM, permissionSchema, type PermissionInteraction } from '@aork/contracts/interaction';
import { InputCards, StructuredForm } from './forms.js';
import styles from './permissions.module.css';

const labels: Record<PermissionInteraction['state'], string> = {
  pending: '等待明确选择', responding: '响应已受理，等待发送确认', responded: '已发送响应',
  expired: '响应通道已失效', cancelled: '响应已取消', delivery_unknown: '响应交付结果未知，请勿重复批准', invalidated: '响应通道已失效',
};
function useSelection() {
  const read = () => new URLSearchParams(location.hash.slice(1));
  const [value, setValue] = useState(read);
  useEffect(() => { const change = () => setValue(read()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  return value;
}
function usePermissions(runtime: UiRuntime) {
  const selection = useSelection(); const sessionId = selection.get('session');
  const [values, setValues] = useState<PermissionInteraction[]>([]);
  const [truncated, setTruncated] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const stop = runtime.observeSnapshot<{ interactions: unknown[]; truncated?: boolean }>('interactions.history', { sessionId }, {
      next(value) { if (active) { setValues(value.interactions.map(item => permissionSchema.parse(item))); setTruncated(value.truncated === true); setError(''); } },
      error(failure) { if (active) setError(failure.message); },
    }, { owners: ['interactions'] });
    return () => { active = false; void stop(); };
  }, [runtime, sessionId]);
  return { values: values.filter(value => value.sessionId === sessionId), selection, error, truncated };
}
function Cards({ runtime }: ViewProps) {
  const { values, error, truncated } = usePermissions(runtime);
  if (!values.length && !error) return null;
  return <section className={styles.cards} aria-label="权限请求">
    <header>Agent 权限请求</header>
    {values.map(value => <article key={value.id} aria-label={value.title}>
      <strong>{value.title}</strong><small>来源：Agent · Run {value.runId} · 连接代次 {value.generation}</small>
      <p role="status">{labels[value.state]}</p>{value.reason && <p>{value.reason}</p>}
      {value.state === 'pending' && <button onClick={() => { const selection = new URLSearchParams(location.hash.slice(1)); selection.set('interaction', value.id); location.hash = selection.toString(); }}>处理权限</button>}
    </article>)}
    {runtime.renderView(PERMISSION_FORM)}
    {truncated && <p>较早的权限历史已截断；有效请求优先显示。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
interface Attempt { interactionId: string; optionId: string; commandId: string }
const definiteRejections = new Set(['INTERACTION_CLOSED', 'INTERACTION_UNAVAILABLE', 'INTERACTION_OPTION_INVALID', 'INVALID_PAYLOAD']);
function Permission({ runtime }: ViewProps) {
  const { values, selection, error: queryError } = usePermissions(runtime);
  const value = values.find(value => value.id === selection.get('interaction')) ?? values.find(value => value.state === 'pending');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState<Attempt>();
  const sending = useRef(false);
  async function submit(optionId: string, retry = false) {
    if (sending.current || !retry && value?.state !== 'pending') return;
    // A receipt retry uses the saved command even after a fresh snapshot has
    // removed its pending card. It can never create a new approval command.
    const next = retry ? attempt : value ? { interactionId: value.id, optionId, commandId: crypto.randomUUID() } : undefined;
    if (!next) return;
    sending.current = true; setBusy(true); setError(''); setAttempt(next);
    try {
      await runtime.command<CommandReceipt<PermissionInteraction>>('interactions.respond', { interactionId: next.interactionId, optionId: next.optionId }, next.commandId, { version: 1 });
      setAttempt(undefined);
    } catch (failure) {
      const code = failure instanceof Error && 'code' in failure ? failure.code : undefined;
      if (definiteRejections.has(String(code))) setAttempt(undefined);
      setError(failure instanceof Error ? failure.message : '响应受理结果未确认');
    } finally { sending.current = false; setBusy(false); }
  }
  if (!value && !attempt) return queryError ? <p role="alert">{queryError}</p> : null;
  return <div className={styles.form} aria-label="权限审批表单">
    {value?.state === 'pending' && <><p>选择 Agent 提供的权限选项</p><div>{value.options.map(option => <button key={option.optionId} disabled={busy || Boolean(attempt) || Boolean(queryError)} onClick={() => void submit(option.optionId)}>{option.name}</button>)}</div></>}
    {attempt && !busy && <button onClick={() => void submit(attempt.optionId, true)}>重试同一响应</button>}
    {(error || queryError) && <p role="alert">{error || queryError}</p>}
  </div>;
}
export function activate(context: ClientPluginContext) { context.registerView('cards', Cards); context.registerView('permission', Permission); context.registerView('input-cards',InputCards); context.registerView('form',StructuredForm); }
