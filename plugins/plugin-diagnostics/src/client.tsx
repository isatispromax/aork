import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import type { PluginDiagnosticsSnapshot } from '@aork/sdk/server';
import styles from './diagnostics.module.css';
function Diagnostics({ runtime }: ViewProps) {
  const [snapshot, setSnapshot] = useState<PluginDiagnosticsSnapshot>(); const [failed, setFailed] = useState(false);
  useEffect(() => { let current = true; void runtime.query<PluginDiagnosticsSnapshot>('plugins.diagnostics').then(value => { if (current) setSnapshot(value); }).catch(() => { if (current) setFailed(true); }); return () => { current = false; }; }, [runtime]);
  return <section className={styles.panel}><h2>插件诊断</h2>{failed ? <p role="alert">诊断暂时不可用，请在本地运行 doctor。</p> : !snapshot ? <p role="status">正在检查插件…</p> : <><p>当前组合：{snapshot.profile.id}</p><ul>{snapshot.plugins.map(plugin => <li key={plugin.id}><strong>{plugin.id}@{plugin.version}</strong><p>服务：{plugin.provides.join('、') || '无'} · 配置：{plugin.configured ? '已配置' : '默认'}</p></li>)}</ul>{snapshot.rejected ? <aside role="alert"><h3>上次预检被拒绝</h3><strong>{snapshot.rejected.code}</strong><p>{snapshot.rejected.pluginId}@{snapshot.rejected.version}</p><p>{snapshot.rejected.message}</p><p>{snapshot.rejected.remedy}</p></aside> : <p role="status">当前插件组合兼容，尚无被拒绝的预检。</p>}</>}</section>;
}
function SettingsSection({ runtime }: ViewProps) { return runtime.renderView('aork.plugins.diagnostics@1'); }
export function activate(context: ClientPluginContext) { context.registerView('diagnostics', Diagnostics); context.registerExtension('section', SettingsSection); }
