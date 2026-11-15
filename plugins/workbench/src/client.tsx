import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import styles from './workbench.module.css';

function Layout({ runtime }: ViewProps) {
  return <div className={styles.layout}><header className={styles.header}>Aork <span>个人 AI 工作台</span></header><main>{runtime.renderView('aork.workbench.home@1')}</main></div>;
}
function Home() { return <section className={styles.home}><h1>工作台已启动</h1><p>默认启动组合已加载。当前未启用项目、会话、文件或 Agent 工作能力。</p></section>; }
export function activate(context: ClientPluginContext) {
  context.registerView('layout', Layout);
  context.registerView('home', Home);
  context.registerTheme('theme', { version: 1, tokens: { '--aork-background': '#f8f8f7', '--aork-surface': '#ffffff', '--aork-text': '#232322', '--aork-muted': '#777773', '--aork-border': '#e4e4e0', '--aork-accent': '#367a67', '--aork-font': 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } });
  context.registerIcons('icons', { version: 1, icons: { workspace: '▣', settings: '⚙', diagnostics: 'ⓘ' } });
}
