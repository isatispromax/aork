import { useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import styles from './login.module.css';

function Login({ runtime }: ViewProps) {
  const { bootstrap } = runtime; const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { await runtime.refreshAccess(); } catch { setError('访问认证暂时不可用，请联系服务器维护者。'); }
    finally { setBusy(false); }
  }
  return <main className={styles.page}>
    <header className={styles.brand}><span aria-hidden="true">a</span><strong>Aork</strong><small>个人 AI 工作台</small></header>
    <section className={styles.card} aria-labelledby="access-title">
      <span className={styles.eyebrow}>连接你的工作环境</span>
      <h1 id="access-title">需要工作台访问链接</h1>
      <p className={styles.description}>请打开服务器启动时在终端输出的访问链接。链接验证后会建立浏览器会话，并从地址栏移除 Token。</p>
      <div className={styles.notice} role="status"><strong>{bootstrap.access.state === 'unavailable' ? '认证服务暂时不可用' : '当前浏览器尚未获得访问授权'}</strong><p>工作环境与 Agent 留在服务器。访问链接只从服务器本地取得。</p></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.login} disabled={busy} onClick={() => { void refresh(); }}>{busy ? '正在检查…' : '重新检查访问权限'}</button>
      <details className={styles.diagnostics}>
        <summary><span aria-hidden="true">{runtime.icon('diagnostics')} </span>启动诊断 · {bootstrap.plugins.length} 个插件已激活</summary>
        <dl><dt>发行组合</dt><dd>{bootstrap.profile.id}</dd><dt>SDK</dt><dd>{bootstrap.sdkVersion}</dd><dt>插件</dt><dd>{bootstrap.plugins.map(plugin => `${plugin.id}@${plugin.version}`).join('，')}</dd><dt>图版本</dt><dd className={styles.hash}>{bootstrap.pluginGraphHash}</dd><dt>本地维护</dt><dd><code>{bootstrap.maintenance.command}</code></dd></dl>
      </details>
    </section>
    <footer className={styles.footer}>Aork · 个人远程工作台</footer>
  </main>;
}
function Controls({ runtime }: ViewProps) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function logout() {
    setBusy(true); setError('');
    try { await runtime.command('auth.logout', {}, crypto.randomUUID()); }
    catch { setError('退出失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <span><button disabled={busy} onClick={() => { void logout(); }}>{busy ? '正在退出…' : '退出访问'}</button>{error && <span role="alert">{error}</span>}</span>;
}
export function activate(context: ClientPluginContext) { context.registerView('login', Login); context.registerView('controls', Controls); }
