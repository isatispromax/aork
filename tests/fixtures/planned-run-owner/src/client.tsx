import type { ClientPluginContext } from '@aork/sdk/client';
export function activate(context: ClientPluginContext) { for (const name of ['navigation', 'create', 'detail', 'composer', 'messages', 'tools'])
    context.registerView(name, () => null); }
