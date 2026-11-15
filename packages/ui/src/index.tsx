import { Component, createElement } from 'react';
import type { ErrorInfo, ReactNode, ComponentType } from 'react';
import type { Bootstrap, Diagnostic } from '@aork/sdk';
import type { ClientPlugin, ClientPluginContext, IconProvider, ThemeProvider, UiRuntime, ViewProps } from '@aork/sdk/client';
import type { Disposer } from '@aork/sdk/server';

export function BootstrapFailure({ diagnostics, maintenance }: { diagnostics: Diagnostic[]; maintenance: string }) {
  return <main role="alert" style={{ maxWidth: 720, margin: '12vh auto', padding: 24, fontFamily: 'system-ui' }}>
    <h1>Aork 启动失败</h1>
    <p>无法装配当前插件界面，请在服务器检查 Distribution Profile。</p>
    <ul>{diagnostics.map((item, index) => <li key={index}><strong>{item.code}</strong> {item.location && <code>{item.location}</code>}<p>{item.message}</p></li>)}</ul>
    <p>本地维护命令</p><code>{maintenance}</code><p><button onClick={() => location.reload()}>重新加载</button></p>
  </main>;
}
class ViewBoundary extends Component<{ children: ReactNode; contract: string; provider: string; maintenance: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(_error: Error, _info: ErrorInfo) { /* Boundary content is the visible diagnostic; no private payload is logged. */ }
  override render() {
    if (this.state.failed) return <BootstrapFailure diagnostics={[{ code: 'UI_RENDER_FAILED', message: `Selected provider ${this.props.provider} failed to render`, location: this.props.contract }]} maintenance={this.props.maintenance} />;
    return this.props.children;
  }
}

export async function createUiRuntime(bootstrap: Bootstrap) {
  const views = new Map<string, ComponentType<ViewProps>>();
  const themes = new Map<string, ThemeProvider>();
  const icons = new Map<string, IconProvider>();
  const scopes: Disposer[][] = [];
  const dispose = async () => {
    const errors: unknown[] = [];
    for (const scope of scopes.splice(0).reverse()) for (const cleanup of scope.reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'UI cleanup failed');
  };
  const runtime: UiRuntime = {
    bootstrap,
    async query<T>(name: string): Promise<T> {
      const response = await fetch(`/api/queries/${encodeURIComponent(name)}`, { credentials: 'same-origin', headers: { 'X-Aork-Graph': bootstrap.pluginGraphHash } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Query failed');
      return result as T;
    },
    async command<T>(name: string, payload: unknown, commandId: string): Promise<T> {
      const response = await fetch(`/api/commands/${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Command failed');
      return result as T;
    },
    icon(semanticId) { return icons.get(bootstrap.ui.providers['aork.ui.icons@1']!)?.icons[semanticId] ?? '◇'; },
    renderView(contract) {
      const provider = bootstrap.ui.providers[contract];
      const View = provider && views.get(provider);
      if (!View) return <BootstrapFailure diagnostics={[{ code: 'UI_PROVIDER_NOT_REGISTERED', message: `Selected provider ${provider ?? '(missing)'} did not register a view`, location: contract }]} maintenance={bootstrap.maintenance.command} />;
      return <ViewBoundary key={`${bootstrap.pluginGraphHash}:${contract}`} contract={contract} provider={provider!} maintenance={bootstrap.maintenance.command}>{createElement(View, { runtime })}</ViewBoundary>;
    },
  };
  try {
    for (const plugin of bootstrap.plugins) {
      if (!plugin.client) continue;
      const url = new URL(plugin.client, location.origin);
      if (url.origin !== location.origin || !/^\/plugins\/[a-f0-9]{64}\//.test(url.pathname)) throw new Error(`Unsafe client entry for ${plugin.id}`);
      const scope: Disposer[] = []; scopes.push(scope);
      for (const style of plugin.styles) {
        const styleUrl = new URL(style, location.origin);
        if (styleUrl.origin !== location.origin || !styleUrl.pathname.startsWith(url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1))) throw new Error(`Unsafe style for ${plugin.id}`);
        const element = document.createElement('link'); element.rel = 'stylesheet'; element.href = styleUrl.href;
        const ready = new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error(`Unable to load stylesheet for ${plugin.id}`)); });
        document.head.append(element); scope.push(() => element.remove()); await ready;
      }
      const declaration = (id: string) => {
        const provider = plugin.manifest.ui.providers.find(provider => provider.id === id);
        if (!provider) throw new Error(`${plugin.id}:${id} is not declared in the static manifest`);
        return provider;
      };
      function register<T>(map: Map<string, T>, id: string, value: T) {
        const key = `${plugin.id}:${id}`;
        if (map.has(key)) throw new Error(`Duplicate UI provider ${key}`);
        map.set(key, value); scope.push(() => { map.delete(key); });
      }
      const context: ClientPluginContext = {
        pluginId: plugin.id,
        registerView(id, component) { const provider = declaration(id); if (['aork.ui.theme@1', 'aork.ui.icons@1'].includes(provider.contract)) throw new Error(`${id} requires a theme or icon registration`); register(views, id, component); },
        registerTheme(id, theme) { if (declaration(id).contract !== 'aork.ui.theme@1' || theme.version !== 1) throw new Error(`Incompatible theme ${id}`); register(themes, id, theme); },
        registerIcons(id, value) { if (declaration(id).contract !== 'aork.ui.icons@1' || value.version !== 1) throw new Error(`Incompatible icons ${id}`); register(icons, id, value); },
        effect(setup) { scope.push(setup()); },
      };
      const module = await import(/* @vite-ignore */ url.href) as ClientPlugin;
      if (typeof module.activate !== 'function') throw new Error(`${plugin.id} does not export activate(context)`);
      const cleanup = await module.activate(Object.freeze(context));
      if (cleanup) scope.push(cleanup);
    }
    const theme = themes.get(bootstrap.ui.providers['aork.ui.theme@1']!);
    if (!theme || !icons.has(bootstrap.ui.providers['aork.ui.icons@1']!)) throw new Error('Selected theme or icon provider did not register');
    for (const [token, value] of Object.entries(theme.tokens)) {
      if (!token.startsWith('--aork-')) throw new Error(`Invalid theme token ${token}`);
      const prior = document.documentElement.style.getPropertyValue(token);
      document.documentElement.style.setProperty(token, value);
      scopes.at(-1)!.push(() => { if (prior) document.documentElement.style.setProperty(token, prior); else document.documentElement.style.removeProperty(token); });
    }
    return { runtime, dispose };
  } catch (error) { await dispose(); throw error; }
}
