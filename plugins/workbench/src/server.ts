import type { ServerPluginContext } from '@aork/sdk/server';

export function activate(context: ServerPluginContext) {
  const workbench = { version: 1, status: 'bootstrap' };
  context.provide('aork.workbench@1', workbench);
  context.query('workbench.overview', { access: 'authenticated', execute: () => workbench });
}
