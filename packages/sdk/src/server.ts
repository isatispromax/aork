import type { AccessState, JsonValue } from './index.js';

export type Disposer = () => void | Promise<void>;
export interface RequestContext {
  identity?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  clientAddress: string;
  session: {
    token?: string;
    audience: string;
    issue(token: string, expiresAt: number): void;
  };
}
export interface AuthorizationService {
  inspect(request: RequestContext): AccessState | Promise<AccessState>;
  accessUrl(origin: string): string;
  exchangeToken(request: RequestContext, token: string): void | Promise<void>;
  verifyCsrf(request: RequestContext): void | Promise<void>;
}
export interface ScopedState {
  get<T extends JsonValue>(key: string): T | undefined;
  set(key: string, value: JsonValue): void;
}
export interface QueryRegistration<T = unknown> {
  access: 'public' | 'authenticated';
  execute(request: RequestContext): T | Promise<T>;
}
export interface CommandRegistration<T = unknown> {
  access: 'public' | 'authenticated';
  execute(payload: unknown, request: RequestContext): T | Promise<T>;
}
export interface ServerPluginContext {
  readonly pluginId: string;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly state: ScopedState;
  provide<T>(serviceId: string, value: T): void;
  service<T>(serviceId: string): T;
  query<T>(name: string, query: QueryRegistration<T>): void;
  command<T>(name: string, command: CommandRegistration<T>): void;
  effect(setup: () => Disposer): void;
}
export interface ServerPlugin { activate(context: ServerPluginContext): void | Disposer | Promise<void | Disposer> }
export const AUTHORIZATION_SERVICE = 'aork.authorization@1';

/** Explicit local entry loaded under the same exclusive data lock, without server activation. */
export interface LocalMaintenancePlugin {
  maintain(context: Readonly<{ pluginId: string; state: ScopedState }>, action: string): JsonValue | Promise<JsonValue>;
}

/** Read-only Host mechanism; normal diagnostics presentation and HTTP query belong to a plugin. */
export const PLUGIN_DIAGNOSTICS_SERVICE = 'aork.plugins.diagnostics@1';
export interface PluginDiagnosticsSnapshot {
  profile: import('./index.js').DistributionProfile;
  pluginGraphHash: string;
  plugins: Array<{ id: string; version: string; requires: string[]; provides: string[]; capabilities: string[]; configured: boolean }>;
  diagnostics: import('./index.js').Diagnostic[];
  rejected?: import('./index.js').Diagnostic;
}
export interface PluginDiagnosticsService { inspect(): Promise<PluginDiagnosticsSnapshot> }
