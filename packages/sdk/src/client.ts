import type { ComponentType, ReactNode } from 'react';
import type { AccessState, Bootstrap } from './index.js';
import type { Disposer } from './server.js';
import type { SnapshotEnvelope } from './durable.js';

/** Versioned public surfaces. New business contracts are added by their owning packages. */
export const UI_CONTRACTS = ['aork.sessions.navigation@1', 'aork.sessions.create@1', 'aork.sessions.detail@1', 'aork.sessions.composer@1', 'aork.sessions.messages@1', 'aork.sessions.tools@1', 'aork.workspace.files@1', 'aork.workspace.browser@1', 'aork.auth.login@1', 'aork.auth.controls@1', 'aork.workbench.layout@1', 'aork.workbench.home@1', 'aork.ui.theme@1', 'aork.ui.icons@1', 'aork.plugins.diagnostics@1', 'aork.plugins.management@1', 'aork.settings@1'] as const;
export const UI_EXTENSION_TARGETS = ['aork.workbench.navigation@1', 'aork.workbench.header@1', 'aork.settings.sections@1'] as const;
export interface UiRuntime {
  readonly bootstrap: Bootstrap;
  query<T>(name: string, options?: { cache?: 'prefer-cache' | 'reload' }): Promise<T>;
  snapshot<T>(name: string, parameters: Readonly<Record<string, string>>): Promise<SnapshotEnvelope<T>>;
  /** Durable invalidation is acknowledged only after a consistent replacement is applied. */
  observeSnapshot<T>(name: string, parameters: Readonly<Record<string, string>>, observer: { next(value: T): void | Promise<void>; error?(error: Error): void }, options?: { owners?: readonly string[]; eventTypes?: readonly string[] }): Disposer;
  command<T>(name: string, payload: unknown, commandId: string, options?: { version?: number }): Promise<T>;
  /** Authenticated bounded bytes. A supplied body is an explicit write; failures are never retried. */
  resource(name: string, parameters: Readonly<Record<string, string>>, bytes?: Uint8Array): Promise<{ bytes: Uint8Array; mediaType: string }>;
  refreshAccess(): Promise<AccessState>;
  onReloadRequired(listener: () => void): Disposer;
  onAccessChange(listener: (access: AccessState) => void): Disposer;
  /** Scoped polling until durable event transport is available; stopped on authentication loss. */
  subscribe<T>(name: string, observer: { next(value: T): void; error?(error: Error): void }, options?: { intervalMs?: number }): Disposer;
  renderView(contract: string): ReactNode;
  renderExtensions(target: typeof UI_EXTENSION_TARGETS[number]): ReactNode;
  icon(semanticId: string): string;
}
export interface ViewProps { runtime: UiRuntime }
export interface ThemeProvider { version: 1; tokens: Readonly<Record<`--aork-${string}`, string>> }
export interface IconProvider { version: 1; icons: Readonly<Record<string, string>> }
export interface ClientPluginContext {
  readonly pluginId: string;
  registerView(providerId: string, component: ComponentType<ViewProps>): void;
  registerExtension(extensionId: string, component: ComponentType<ViewProps>): void;
  registerTheme(providerId: string, theme: ThemeProvider): void;
  registerIcons(providerId: string, icons: IconProvider): void;
  effect(setup: () => Disposer): void;
}
export interface ClientPlugin { activate(context: ClientPluginContext): void | Disposer | Promise<void | Disposer> }
