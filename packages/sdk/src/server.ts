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
  readonly repository: OwnerRepository;
  readonly directories: Readonly<{ managedWorkspaces: string; pluginState: string }>;
  provide<T>(serviceId: string, value: T): void;
  service<T>(serviceId: string): T;
  query<T>(name: string, query: QueryRegistration<T>): void;
  command<T>(name: string, command: CommandRegistration<T>): void;
  durableCommand<P, F, R>(name: string, command: DurableCommandRegistration<P, F, R>): void;
  effect(setup: () => Disposer): void;
  /** Runtime authorities report actual managed work; never infer idleness from timeouts. */
  lifecycleGuard(authority: LifecycleAuthority): void;
}
export interface ServerPlugin { persistence?: RepositoryDeclaration; activate(context: ServerPluginContext): void | Disposer | Promise<void | Disposer> }
export const AUTHORIZATION_SERVICE = 'aork.authorization@1';

/** Explicit local entry loaded under the same exclusive data lock, without server activation. */
export interface LocalMaintenancePlugin {
  maintain(context: Readonly<{ pluginId: string; state: ScopedState }>, action: string): JsonValue | Promise<JsonValue>;
}

/** Read-only Host mechanism; normal diagnostics presentation and HTTP query belong to a plugin. */
export const HOST_CAPABILITIES: readonly string[] = ['diagnostics.read', 'plugins.manage', 'filesystem.read', 'filesystem.write'];
export const PLUGIN_DIAGNOSTICS_SERVICE = 'aork.plugins.diagnostics@1';
export interface PluginDiagnosticsSnapshot {
  profile: import('./index.js').DistributionProfile;
  pluginGraphHash: string;
  plugins: Array<{ id: string; version: string; requires: string[]; provides: string[]; capabilities: string[]; configured: boolean }>;
  diagnostics: import('./index.js').Diagnostic[];
  rejected?: import('./index.js').Diagnostic;
}
export interface PluginDiagnosticsService { inspect(): Promise<PluginDiagnosticsSnapshot> }
/** Only the owning storage adapter can create a live synchronous transaction. */
declare const transactionBrand: unique symbol;
export interface SyncTransaction { readonly [transactionBrand]: true }
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface RepositoryDeclaration {
  /** Use repositoryNamespace(pluginId); declarations may reference only this owner. */
  namespace: string;
  migrations: readonly { version: number; statements: readonly string[] }[];
  statements: Readonly<Record<string, { sql: string; mode: 'read' | 'write' }>>;
}
export interface OwnerRepository {
  all<Row>(name: string, values?: readonly SqlValue[], transaction?: SyncTransaction): Row[];
  run(transaction: SyncTransaction, name: string, values?: readonly SqlValue[]): { changes: number };
}
export interface RuntimeSchema<T> { parse(value: unknown): T }
export interface BrowserEventDraft { type: string; version: number; entityId: string; payload: unknown }
export interface DurableCommandRegistration<Payload = unknown, Prepared = unknown, Result = unknown> {
  version: number;
  payload: RuntimeSchema<Payload>;
  result: RuntimeSchema<Result>;
  events: Readonly<Record<string, { version: number; payload: RuntimeSchema<unknown> }>>;
  /** Filesystem / other external I/O belongs here, before the synchronous transaction. */
  prepare?(payload: Payload, request: RequestContext): Prepared | Promise<Prepared>;
  execute(payload: Payload, prepared: Prepared, transaction: SyncTransaction, request: RequestContext): { result: Result; events: readonly BrowserEventDraft[] };
}

/** Injective, prefix-free identifier: `_` escapes IDs and `__` terminates the owner. */
export function repositoryNamespace(pluginId: string): string {
  if (!/^[a-z][a-z0-9.-]*$/.test(pluginId)) throw new TypeError('Invalid Plugin ID');
  return `plugin_${pluginId.replaceAll('.', '_d').replaceAll('-', '_h')}__`;
}

/** Reserved Host mechanism. Presentation remains replaceable Plugin UI. */
export const PLUGIN_MANAGEMENT_SERVICE = 'aork.plugins.management@1';
export interface LifecycleAuthority {
  /** Hold the runtime admission barrier until release, including rollback. No heartbeat or expiry implies idle. */
  acquireChange(affectedPluginIds: readonly string[]): { state: 'idle' | 'busy' | 'unknown'; release: Disposer } | Promise<{ state: 'idle' | 'busy' | 'unknown'; release: Disposer }>;
}
export interface PluginManagementSnapshot {
  pluginGraphHash: string;
  profile: import('./index.js').DistributionProfile;
  plugins: Array<{ id: string; version: string; enabled: boolean; selected: boolean; status: 'active' | 'disabled' | 'available'; requires: string[]; provides: string[]; dependencies: import('./index.js').PluginManifest['dependencies']; config: Record<string, import('./index.js').JsonValue>; configSchema?: import('./index.js').PluginManifest['configSchema']; ui: import('./index.js').PluginManifest['ui'] }>;
}
export interface PluginManagementService {
  inspect(): Promise<PluginManagementSnapshot>;
  configure(pluginId: string, config: Record<string, import('./index.js').JsonValue>, version?:string): Promise<{pluginGraphHash: string; reloadRequired: true}>;
  setEnabled(pluginId: string, enabled: boolean, version?:string): Promise<{pluginGraphHash: string; reloadRequired: true}>;
  compose(ui: import('./index.js').DistributionProfile['ui']): Promise<{pluginGraphHash: string; reloadRequired: true}>;
}
