import type { AccessState, JsonValue } from './index.js';

export type Disposer = () => void | Promise<void>;
export interface RequestContext { identity?: string; headers: Readonly<Record<string, string | string[] | undefined>> }
export interface AuthorizationService {
  inspect(request: RequestContext): AccessState | Promise<AccessState>;
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
  readonly state: ScopedState;
  provide<T>(serviceId: string, value: T): void;
  service<T>(serviceId: string): T;
  query<T>(name: string, query: QueryRegistration<T>): void;
  command<T>(name: string, command: CommandRegistration<T>): void;
  effect(setup: () => Disposer): void;
}
export interface ServerPlugin { activate(context: ServerPluginContext): void | Disposer | Promise<void | Disposer> }
export const AUTHORIZATION_SERVICE = 'aork.authorization@1';
