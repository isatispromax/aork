import { useEffect, useRef, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import type { AgentProfile, AgentsOverview } from '@aork/contracts/agent';
import styles from './agents.module.css';
const reasons: Record<string, string> = { 'provider-missing': 'Provider 未注册', 'binary-missing': '未找到 Agent 二进制', 'unsupported-version': '版本不满足要求', 'provider-failed': 'Provider 检测失败', 'credential-unavailable': '凭据不可用', 'state-directory-unavailable': '状态目录不可用', 'native-authentication-required': '尚需原生认证', ready: '凭据可用', 'missing-key': '缺少独立主密钥', 'missing-reference': '凭据引用失效', unreadable: '凭据无法解密', 'not-required': '无需凭据', 'native-directory-only': '仅受限目录保护' };
const authLabels = { none: '无需认证', 'api-key': '手动 API 凭据', 'native-oauth': '原生 OAuth 状态' };
function Agents({ runtime }: ViewProps) {
  const [overview, setOverview] = useState<AgentsOverview>(); const [error, setError] = useState(''); const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
  const [providerId, setProviderId] = useState(''); const [name, setName] = useState(''); const [version, setVersion] = useState('*'); const [parameters, setParameters] = useState<Record<string, string>>({});
  const [authentication, setAuthentication] = useState<AgentProfile['authentication']>('none'); const [credentialRef, setCredentialRef] = useState(''); const [editing, setEditing] = useState<AgentProfile>();
  const [credentialLabel, setCredentialLabel] = useState(''); const [secret, setSecret] = useState('');
  const retries = useRef(new Map<string, { payload: string; id: string }>());
  function commandId(operation: string, payload: unknown) { const serialized = JSON.stringify(payload); const previous = retries.current.get(operation); if (previous?.payload === serialized) return previous.id; const id = crypto.randomUUID(); retries.current.set(operation, { payload: serialized, id }); return id; }
  async function reload() { const value = await runtime.query<AgentsOverview>('agents.overview', { cache: 'reload' }); setOverview(value); setProviderId(current => current || value.providers[0]?.id || ''); return value; }
  useEffect(() => { let alive = true; void runtime.query<AgentsOverview>('agents.overview', { cache: 'reload' }).then(value => { if (alive) { setOverview(value); setProviderId(value.providers[0]?.id || ''); setAuthentication(value.providers[0]?.authentication[0] ?? 'none'); } }).catch(() => { if (alive) setError('Agent 设置读取失败，请重试。'); }); return () => { alive = false; }; }, [runtime]);
  const provider = overview?.providers.find(item => item.id === providerId);
  function selectProvider(id: string) { const selected = overview?.providers.find(item => item.id === id); setProviderId(id); setParameters({}); setCredentialRef(''); setAuthentication(selected?.authentication[0] ?? 'none'); }
  function edit(profile: AgentProfile) { setEditing(profile); setName(profile.name); setProviderId(profile.providerId); setVersion(profile.versionRequirement); setParameters(Object.fromEntries(Object.entries(profile.parameters).map(([key, value]) => [key, String(value ?? '')]))); setAuthentication(profile.authentication); setCredentialRef(profile.credentialRef ?? ''); setError(''); setStatus(''); }
  function reset() { setEditing(undefined); setName(''); setVersion('*'); setParameters({}); setCredentialRef(''); setAuthentication(provider?.authentication[0] ?? 'none'); }
  async function saveProfile() {
    const payload = { name, providerId, versionRequirement: version, parameters, authentication, credentialRef: authentication === 'api-key' ? credentialRef || null : null, ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) };
    const operation = editing ? 'agents.editProfile' : 'agents.createProfile'; setBusy(true); setError(''); setStatus('');
    try { await runtime.command(operation, payload, commandId(operation, payload)); retries.current.delete(operation); reset(); setStatus('Agent Profile 已保存'); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent Profile 保存失败'); } finally { setBusy(false); }
  }
  async function saveCredential() {
    const payload = { providerId, label: credentialLabel, secret }; setBusy(true); setError(''); setStatus('');
    try { await runtime.command('agents.storeCredential', payload, commandId('agents.storeCredential', payload)); retries.current.delete('agents.storeCredential'); setSecret(''); setCredentialLabel(''); await reload(); setStatus('凭据已保存，已有秘密不会回传。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '凭据保存失败'); } finally { setBusy(false); }
  }
  return <section className={styles.settings} aria-labelledby="agent-settings-title">
    <div className={styles.heading}><div><h2 id="agent-settings-title">Agent</h2><p>管理接入配置与服务器凭据引用</p></div><button type="button" disabled={busy} onClick={() => { setError(''); void reload().catch(() => setError('Agent 设置读取失败，请重试。')); }}>重新检测</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}<p role="status" className={styles.status}>{status}</p>
    {!overview ? <p>{error ? '暂时无法读取 Agent 设置。' : '正在读取 Agent 设置…'}</p> : <>
      <div className={styles.providers} aria-label="Provider 接入状态">{overview.providers.length ? overview.providers.map(item => <div className={styles.row} key={item.id}><div><strong>{item.label}</strong><small>{item.id} · 定义 {item.version}</small></div><span>{item.detection.status === 'available' ? `可用 · ${item.detection.version}` : reasons[item.detection.reason]}</span></div>) : <p>尚未安装 Agent Provider。安装并启用 Provider 后可保存配置；此处不代表 Claude 或 Codex 已接入。</p>}</div>
      <div className={styles.storage}><strong>凭据保护</strong><p>{overview.credentialStorage.status === 'ready' ? '手动 API 凭据加密存储；已有秘密不会回传浏览器。' : '手动 API 凭据缺少独立主密钥，请在服务器配置后重启。'}</p><p>原生 OAuth 状态仅保存在受限目录，尚需对应 Provider 完成认证。</p></div>
      {overview.profiles.length > 0 && <div className={styles.saved} aria-label="已保存 Agent Profile">{overview.profiles.map(({ profile, availability, reason, credentialStatus }) => <div className={styles.row} key={profile.id}><div><strong>{profile.name}</strong><small>{profile.providerId} · {profile.versionRequirement} · 修订 {profile.revision}</small><small>{availability === 'available' ? '可用' : reasons[reason ?? 'provider-failed']} · {reasons[credentialStatus]}</small></div><button type="button" disabled={busy} onClick={() => edit(profile)} aria-label={`编辑 ${profile.name}`}>编辑</button></div>)}</div>}
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void saveProfile(); }}>
        <h3>{editing ? '编辑 Agent Profile' : '新建 Agent Profile'}</h3>
        <label>Provider<select aria-label="Agent Provider" value={providerId} required disabled={busy || !overview.providers.length} onChange={event => selectProvider(event.target.value)}>{!overview.providers.length && <option value="">无可用 Provider</option>}{overview.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <div className={styles.columns}><label>配置名称<input value={name} required maxLength={120} onChange={event => setName(event.target.value)} /></label><label>版本要求<input value={version} required maxLength={100} onChange={event => setVersion(event.target.value)} placeholder="例如 ^1.0.0" /></label></div>
        {provider?.parameters.map(field => <label key={field.name}>{field.label}<input value={parameters[field.name] ?? ''} maxLength={2000} onChange={event => setParameters(current => ({ ...current, [field.name]: event.target.value }))} /></label>)}
        <label>认证方式<select value={authentication} onChange={event => { setAuthentication(event.target.value as AgentProfile['authentication']); setCredentialRef(''); }}>{provider?.authentication.map(method => <option value={method} key={method}>{authLabels[method]}</option>)}</select></label>
        {authentication === 'api-key' && <label>凭据引用<select value={credentialRef} required onChange={event => setCredentialRef(event.target.value)}><option value="">选择服务器凭据</option>{overview.credentials.filter(item => item.providerId === providerId).map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
        <div className={styles.actions}><button type="submit" disabled={busy || !provider}>{editing ? '更新 Agent Profile' : '保存 Agent Profile'}</button>{editing && <button type="button" disabled={busy} onClick={reset}>取消编辑</button>}</div>
      </form>
      {provider?.authentication.includes('api-key') && <form className={styles.form} onSubmit={event => { event.preventDefault(); void saveCredential(); }}>
        <h3>新增服务器凭据</h3><p>为当前 Provider 保存新 API 凭据。表单不会读取已有秘密。</p>
        <label>凭据名称<input value={credentialLabel} required maxLength={120} onChange={event => setCredentialLabel(event.target.value)} /></label>
        <label>新 API 凭据<input type="password" autoComplete="new-password" value={secret} required maxLength={16000} onChange={event => setSecret(event.target.value)} /></label>
        <button type="submit" disabled={busy || overview.credentialStorage.status !== 'ready'}>保存新凭据</button>
      </form>}
      {overview.credentials.length > 0 && <ul className={styles.credentials} aria-label="服务器凭据">{overview.credentials.map(item => <li key={item.id}><span>{item.label}</span><small>{reasons[item.status]} · {item.providerId}</small></li>)}</ul>}
    </>}
  </section>;
}
export function activate(context: ClientPluginContext) { context.registerExtension('agents', Agents); }
