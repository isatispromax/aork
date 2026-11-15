import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import styles from './quiet.module.css';

function Layout({ runtime }: ViewProps) {
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState('');
  const [settings, showSettings] = useState(false);
  useEffect(() => { void runtime.query<{ label: string }>('quiet.settings').then(value => setLabel(value.label)).catch(() => setStatus('设置读取失败')); }, [runtime]);
  return <div className={styles.layout}><aside className={styles.sidebar}><strong>Quiet Aork</strong><p>独立界面组合</p>{runtime.renderExtensions('aork.workbench.navigation@1')}<div className={styles.bottom}><button onClick={() => showSettings(!settings)}>{runtime.icon('settings')} 设置</button>{runtime.renderView('aork.auth.controls@1')}</div></aside><main className={styles.main}><header className={styles.header}>{label || '我的工作台'}<div aria-label="页头扩展" className={styles.extensions}>{runtime.renderExtensions('aork.workbench.header@1')}</div></header>{settings ? <section className={styles.content}><h1>工作台设置</h1><form onSubmit={event => { event.preventDefault(); void runtime.command<{ label: string }>('quiet.settings.save', { label }, crypto.randomUUID()).then(value => { setLabel(value.label); setStatus('已保存'); }).catch(() => setStatus('设置保存失败')); }}><label>工作台名称<input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} /></label><button type="submit">保存设置</button><p role="status">{status}</p></form>{runtime.renderExtensions('aork.settings.sections@1')}</section> : runtime.renderView('aork.workbench.home@1')}</main></div>;
}
export function activate(context: ClientPluginContext) {
  context.registerView('layout', Layout);
  context.registerExtension('service', () => <span>服务设置</span>);
  context.registerExtension('privacy', () => <span>本机优先</span>);
  context.registerExtension('extra', () => <span>可隐藏扩展</span>);
  context.registerTheme('theme', { version: 1, tokens: { '--aork-background': '#f9fafb', '--aork-surface': '#fff', '--aork-text': '#0f1115', '--aork-muted': '#60646c', '--aork-border': '#e5e7eb', '--aork-accent': '#2854a6', '--aork-font': 'system-ui, -apple-system, sans-serif' } });
  context.registerIcons('icons', { version: 1, icons: { settings: '⚙', workspace: '▤' } });
}
