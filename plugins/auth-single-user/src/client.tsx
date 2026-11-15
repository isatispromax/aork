import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import styles from './login.module.css';

function Login({ runtime }: ViewProps) {
  const { bootstrap } = runtime;
  return <main className={styles.page}>
    <header className={styles.brand}><span aria-hidden="true">a</span><strong>Aork</strong><small>个人 AI 工作台</small></header>
    <section className={styles.card} aria-labelledby="login-title">
      <span className={styles.eyebrow}>欢迎回来</span>
      <h1 id="login-title">登录你的工作台</h1>
      <p className={styles.description}>工作环境与 Agent 在服务器上，浏览器连接你的工作。</p>
      <div className={styles.notice} role="status"><strong>{bootstrap.access.state === 'setup_required' ? '账号尚未初始化' : '认证功能尚未就绪'}</strong><p>账号初始化与登录尚未开放，请联系服务器维护者。当前无法访问受保护的工作内容。</p></div>
      <button className={styles.login} disabled>登录</button>
      <details className={styles.diagnostics}>
        <summary><span aria-hidden="true">{runtime.icon('diagnostics')} </span>启动诊断 · {bootstrap.plugins.length} 个插件已激活</summary>
        <dl><dt>发行组合</dt><dd>{bootstrap.profile.id}</dd><dt>SDK</dt><dd>{bootstrap.sdkVersion}</dd><dt>插件</dt><dd>{bootstrap.plugins.map(plugin => `${plugin.id}@${plugin.version}`).join('，')}</dd><dt>图版本</dt><dd className={styles.hash}>{bootstrap.pluginGraphHash}</dd><dt>本地维护</dt><dd><code>{bootstrap.maintenance.command}</code></dd></dl>
      </details>
    </section>
    <footer className={styles.footer}>Aork · 个人远程工作台</footer>
  </main>;
}
export function activate(context: ClientPluginContext) { context.registerView('login', Login); }
