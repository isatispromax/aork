import type { ComponentType, ReactNode } from 'react';
import type { Bootstrap } from './index.js';
import type { Disposer } from './server.js';

/** Versioned public surfaces. New business contracts are added by their owning packages. */
export const UI_CONTRACTS = ['aork.auth.login@1', 'aork.workbench.layout@1', 'aork.workbench.home@1', 'aork.ui.theme@1', 'aork.ui.icons@1'] as const;
export interface UiRuntime {
  readonly bootstrap: Bootstrap;
  query<T>(name: string): Promise<T>;
  command<T>(name: string, payload: unknown, commandId: string): Promise<T>;
  renderView(contract: string): ReactNode;
  icon(semanticId: string): string;
}
export interface ViewProps { runtime: UiRuntime }
export interface ThemeProvider { version: 1; tokens: Readonly<Record<`--aork-${string}`, string>> }
export interface IconProvider { version: 1; icons: Readonly<Record<string, string>> }
export interface ClientPluginContext {
  readonly pluginId: string;
  registerView(providerId: string, component: ComponentType<ViewProps>): void;
  registerTheme(providerId: string, theme: ThemeProvider): void;
  registerIcons(providerId: string, icons: IconProvider): void;
  effect(setup: () => Disposer): void;
}
export interface ClientPlugin { activate(context: ClientPluginContext): void | Disposer | Promise<void | Disposer> }
