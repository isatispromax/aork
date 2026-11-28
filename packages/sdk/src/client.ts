import type { ComponentType, ReactNode } from 'react';
import type { AccessState, Bootstrap } from './index.js';
import type { Disposer } from './server.js';
import type { SnapshotEnvelope } from './durable.js';

/** Versioned public surfaces. New business contracts are added by their owning packages. */
export const UI_CONTRACTS = ['aork.tools.selection@1', 'aork.artifacts.registration@1', 'aork.artifacts.list@1', 'aork.artifacts.versions@1', 'aork.artifacts.preview@1', 'aork.artifacts.renderer@1', 'aork.sessions.recovery@1', 'aork.sessions.native-history@1', 'aork.sessions.input-options@1', 'aork.sessions.actions@1', 'aork.sessions.handoff@1', 'aork.workbench.sidebar@1', 'aork.workbench.header-view@1', 'aork.workbench.main@1', 'aork.workbench.inspector@1', 'aork.workbench.menu@1', 'aork.workbench.notifications@1', 'aork.workbench.pending@1', 'aork.workbench.unread@1', 'aork.workbench.read-tracker@1', 'aork.workspace.navigation@1', 'aork.workspace.page@1', 'aork.sessions.header@1', 'aork.interactions.input-cards@1', 'aork.interactions.form@1', 'aork.interactions.cards@1', 'aork.interactions.permission@1', 'aork.sessions.rows@1', 'aork.sessions.create@1', 'aork.sessions.detail@1', 'aork.sessions.composer@1', 'aork.sessions.messages@1', 'aork.sessions.tools@1', 'aork.workspace.files@1', 'aork.workspace.directory-picker@1', 'aork.auth.login@1', 'aork.auth.controls@1', 'aork.workbench.layout@1', 'aork.workbench.home@1', 'aork.ui.theme@1', 'aork.ui.icons@1', 'aork.plugins.diagnostics@1', 'aork.plugins.management@1', 'aork.settings@1'] as const;
/** Contracts selected per media type (renderer views). Providers must declare their media types; a sole candidate resolves automatically, competing candidates require an explicit profile selection. */
export const MEDIA_TYPED_UI_CONTRACTS = ['aork.artifacts.renderer@1'] as const;
export const UI_EXTENSION_TARGETS = ['aork.sessions.input-extensions@1', 'aork.workbench.menu-items@1', 'aork.workbench.notification-sources@1', 'aork.workbench.toolbar@1', 'aork.workbench.navigation@1', 'aork.workbench.header@1', 'aork.workbench.rail-sections@1', 'aork.workbench.inspector-tabs@1', 'aork.workbench.conversation@1', 'aork.settings.sections@1'] as const;
export type UiExtensionTarget = typeof UI_EXTENSION_TARGETS[number];
export interface UiExtension {
  /** Stable qualified ID, in the form `plugin:extension`. */
  readonly id: string;
  readonly label?: string;
  /** Semantic ID resolved by the selected icon provider. */
  readonly icon?: string;
  /** Inspector tab types only: every open creates an independent tab instance. */
  readonly multiple?: boolean;
  /** Inspector tab types only: one line under the type's name on the start page. */
  readonly description?: string;
  /** Inspector tab types only: the workbench selection key whose presence opens this type (e.g. `file`). */
  readonly opensWith?: string;
}
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
  renderView(contract: string, context?: unknown): ReactNode;
  /** Visible extension declarations in profile order, followed by qualified ID for ties. */
  listExtensions(target: UiExtensionTarget): readonly UiExtension[];
  /** Renders one visible contribution to this target with the standard failure boundary. */
  renderExtension(target: UiExtensionTarget, id: string, context?: unknown): ReactNode;
  renderExtensions(target: UiExtensionTarget, context?: unknown): ReactNode;
  /** Media-type-selected renderer view. A missing or failing renderer degrades to the caller's fallback; active-content isolation stays inside the renderer's own restricted frame. */
  renderRenderer(mediaType: string, context?: unknown, options?: { fallback?: ReactNode }): ReactNode;
  icon(semanticId: string): string;
}
export interface ViewProps { runtime: UiRuntime; context?: unknown }
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
