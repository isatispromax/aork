import { Component, createElement } from 'react';
import type { ErrorInfo, ReactNode, ComponentType } from 'react';
import type { AccessState, Bootstrap, Diagnostic } from '@aork/sdk';
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
  const extensions = new Map<string, ComponentType<ViewProps>>();
  const themes = new Map<string, ThemeProvider>();
  const icons = new Map<string, IconProvider>();
  const scopes: Disposer[][] = [];
  const dispose = async () => {
    const errors: unknown[] = [];
    for (const scope of scopes.splice(0).reverse()) for (const cleanup of scope.reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'UI cleanup failed');
  };
  const cache = new Map<string, unknown>();
  const requests = new Set<AbortController>();
  const subscriptions = new Set<Disposer>();
  const listeners = new Set<(access: AccessState) => void>();
  let generation = 0;
  let disposed = false;
  let accessRequest = 0;
  let accessRevision = 0;
  const isPublic = (name: string) => name === 'auth.status';
  class RequestFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
  const isAccessFailure = (error: unknown): error is RequestFailure => error instanceof RequestFailure && ['AUTHENTICATION_REQUIRED', 'AUTH_UNAVAILABLE'].includes(error.code);
  function setAccess(access: AccessState) {
    accessRevision++;
    if (access.state !== 'authenticated' || access.identity !== bootstrap.access.identity || access.csrfToken !== bootstrap.access.csrfToken) {
      generation++;
      cache.clear();
      for (const request of requests) request.abort();
      requests.clear();
      for (const stop of [...subscriptions]) void stop();
    }
    const changed = JSON.stringify(access) !== JSON.stringify(bootstrap.access);
    bootstrap.access = access;
    if (changed) for (const listener of listeners) try { void Promise.resolve(listener(access)).catch(() => { console.error('AORK_ACCESS_LISTENER_FAILED'); }); } catch { console.error('AORK_ACCESS_LISTENER_FAILED'); }
  }
  async function result<T>(response: Response): Promise<T> {
    const value = await response.json();
    if (!response.ok) {
      throw new RequestFailure(value.error?.code ?? 'REQUEST_FAILED', value.error?.message ?? 'Request failed');
    }
    return value as T;
  }
  const runtime: UiRuntime = {
    bootstrap,
    async query<T>(name: string, options?: { cache?: 'prefer-cache' | 'reload' }): Promise<T> {
      const protectedQuery = !isPublic(name);
      if (disposed || (protectedQuery && bootstrap.access.state !== 'authenticated')) throw new Error('Open the local Host access URL to continue');
      if (options?.cache === 'prefer-cache' && cache.has(name)) return cache.get(name) as T;
      const controller = new AbortController();
      const started = generation;
      if (protectedQuery) requests.add(controller);
      try {
        const response = await fetch(`/api/queries/${encodeURIComponent(name)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'X-Aork-Graph': bootstrap.pluginGraphHash } });
        const value = await result<T>(response);
        if (protectedQuery && (started !== generation || bootstrap.access.state !== 'authenticated')) throw new Error('Authentication changed; query discarded');
        if (protectedQuery) cache.set(name, value);
        return value;
      } catch (error) {
        if (protectedQuery && started === generation && isAccessFailure(error)) setAccess({ state: error.code === 'AUTHENTICATION_REQUIRED' ? 'unauthenticated' : 'unavailable' });
        throw error;
      } finally { requests.delete(controller); }
    },
    async command<T>(name: string, payload: unknown, commandId: string, options?: { version?: number }): Promise<T> {
      if (disposed || bootstrap.access.state !== 'authenticated') throw new Error('Open the local Host access URL to continue');
      if (name === 'auth.logout') accessRevision++;
      const started = generation;
      try {
        const response = await fetch(`/api/commands/${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Aork-CSRF': bootstrap.access.csrfToken ?? '' }, body: JSON.stringify({ apiVersion: 1, commandVersion: options?.version ?? 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) });
        const value = await result<T>(response);
        if (name === 'auth.logout') {
          if (started === generation) setAccess({ state: 'unauthenticated' });
          await runtime.refreshAccess();
        } else if (started !== generation) throw new Error('Authentication changed; command result discarded');
        return value;
      } catch (error) {
        if (started === generation && isAccessFailure(error)) setAccess({ state: error.code === 'AUTHENTICATION_REQUIRED' ? 'unauthenticated' : 'unavailable' });
        throw error;
      }
    },
    async resource(name, parameters, bytes) {
      if (disposed || bootstrap.access.state !== 'authenticated') throw new Error('Open the local Host access URL to continue');
      const controller = new AbortController(); const started = generation; requests.add(controller);
      try {
        const response = await fetch(`/api/resources/${encodeURIComponent(name)}?${new URLSearchParams(parameters)}`, {
          method: bytes === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'X-Aork-Graph': bootstrap.pluginGraphHash, ...(bytes === undefined ? {} : { 'Content-Type': 'application/octet-stream', 'X-Aork-CSRF': bootstrap.access.csrfToken ?? '' }) },
          ...(bytes === undefined ? {} : { body: new Uint8Array(bytes) }),
        });
        if (!response.ok) await result(response);
        const value = { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get('content-type') ?? 'application/octet-stream' };
        if (started !== generation || bootstrap.access.state !== 'authenticated') throw new Error('Authentication changed; resource discarded');
        return value;
      } catch (error) {
        if (started === generation && isAccessFailure(error)) setAccess({ state: error.code === 'AUTHENTICATION_REQUIRED' ? 'unauthenticated' : 'unavailable' });
        throw error;
      } finally { requests.delete(controller); }
    },
    async refreshAccess() {
      const request = ++accessRequest;
      const revision = accessRevision;
      try {
        const access = await runtime.query<AccessState>('auth.status');
        if (!disposed && request === accessRequest && revision === accessRevision) setAccess(access);
        return bootstrap.access;
      } catch (error) { if (!disposed && request === accessRequest && revision === accessRevision) setAccess({ state: 'unavailable' }); throw error; }
    },
    onAccessChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribe<T>(name: string, observer: { next(value: T): void; error?(error: Error): void }, options?: { intervalMs?: number }) {
      if (!isPublic(name) && bootstrap.access.state !== 'authenticated') throw new Error('Open the local Host access URL to continue');
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { stopped = true; clearTimeout(timer); subscriptions.delete(stop); };
      const poll = async () => {
        try { const value = await runtime.query<T>(name); if (!stopped) await observer.next(value); }
        catch (error) { if (!stopped) try { await observer.error?.(error instanceof Error ? error : new Error('Query failed')); } catch { console.error('AORK_QUERY_OBSERVER_FAILED'); } }
        finally { if (!stopped) timer = setTimeout(() => { void poll(); }, Math.max(250, options?.intervalMs ?? 5000)); }
      };
      subscriptions.add(stop); void poll(); return stop;
    },
    icon(semanticId) { return icons.get(bootstrap.ui.providers['aork.ui.icons@1']!)?.icons[semanticId] ?? '◇'; },
    renderView(contract) {
      const provider = bootstrap.ui.providers[contract];
      const View = provider && views.get(provider);
      if (!View) return <BootstrapFailure diagnostics={[{ code: 'UI_PROVIDER_NOT_REGISTERED', message: `Selected provider ${provider ?? '(missing)'} did not register a view`, location: contract }]} maintenance={bootstrap.maintenance.command} />;
      return <ViewBoundary key={`${bootstrap.pluginGraphHash}:${contract}`} contract={contract} provider={provider!} maintenance={bootstrap.maintenance.command}>{createElement(View, { runtime })}</ViewBoundary>;
    },
    renderExtensions(target) {
      return bootstrap.plugins.flatMap(plugin => plugin.manifest.ui.extensions.filter(extension => extension.target === target).map(extension => ({ ...extension, id: `${plugin.id}:${extension.id}` })))
        .map(extension => ({ ...extension, ...bootstrap.ui.extensions.find(preference => preference.id === extension.id) }))
        .filter(extension => !extension.hidden)
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(extension => {
          const View = extensions.get(extension.id);
          return View ? <ViewBoundary key={extension.id} contract={target} provider={extension.id} maintenance={bootstrap.maintenance.command}>{createElement(View, { runtime })}</ViewBoundary> : <BootstrapFailure key={extension.id} diagnostics={[{ code: 'UI_EXTENSION_NOT_REGISTERED', message: `Extension ${extension.id} did not register`, location: target }]} maintenance={bootstrap.maintenance.command} />;
        });
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
        if (styleUrl.origin !== location.origin || !styleUrl.pathname.startsWith(url.pathname.match(/^\/plugins\/[a-f0-9]{64}\//)![0])) throw new Error(`Unsafe style for ${plugin.id}`);
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
        registerExtension(id, component) { if (!plugin.manifest.ui.extensions.some(extension => extension.id === id)) throw new Error(`Undeclared extension ${plugin.id}:${id}`); register(extensions, id, component); },
        registerTheme(id, theme) { if (declaration(id).contract !== 'aork.ui.theme@1' || theme.version !== 1) throw new Error(`Incompatible theme ${id}`); register(themes, id, theme); },
        registerIcons(id, value) { if (declaration(id).contract !== 'aork.ui.icons@1' || value.version !== 1) throw new Error(`Incompatible icons ${id}`); register(icons, id, value); },
        effect(setup) { scope.push(setup()); },
      };
      try {
        const module = await import(/* @vite-ignore */ url.href) as ClientPlugin;
        if (typeof module.activate !== 'function') throw new Error('Client activation failed');
        const cleanup = await module.activate(Object.freeze(context));
        if (cleanup) scope.push(cleanup);
      } catch {
        for (const cleanup of scope.splice(0).reverse()) try { await cleanup(); } catch { /* Local failure remains contained. */ }
        // Missing views show their selected provider in a local boundary. No auth service is revoked.
      }
    }
    const theme = themes.get(bootstrap.ui.providers['aork.ui.theme@1']!);
    if (!theme || !icons.has(bootstrap.ui.providers['aork.ui.icons@1']!)) throw new Error('Selected theme or icon provider did not register');
    for (const [token, value] of Object.entries(theme.tokens)) {
      if (!token.startsWith('--aork-')) throw new Error(`Invalid theme token ${token}`);
      const prior = document.documentElement.style.getPropertyValue(token);
      document.documentElement.style.setProperty(token, value);
      scopes.at(-1)!.push(() => { if (prior) document.documentElement.style.setProperty(token, prior); else document.documentElement.style.removeProperty(token); });
    }
    const refresh = () => { if (!disposed) void runtime.refreshAccess().catch(() => { /* Visible access gate reports unavailable authentication. */ }); };
    const statusTimer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    scopes.push([() => { disposed = true; clearInterval(statusTimer); window.removeEventListener('focus', refresh); setAccess({ state: 'unavailable' }); listeners.clear(); }]);
    return { runtime, dispose };
  } catch (error) { await dispose(); throw error; }
}
