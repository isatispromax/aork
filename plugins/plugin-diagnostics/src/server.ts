import { PLUGIN_DIAGNOSTICS_SERVICE } from '@aork/sdk/server';
import type { PluginDiagnosticsService, ServerPluginContext } from '@aork/sdk/server';
export function activate(context: ServerPluginContext) {
  context.query('plugins.diagnostics', { access: 'authenticated', execute: () => context.service<PluginDiagnosticsService>(PLUGIN_DIAGNOSTICS_SERVICE).inspect() });
}
