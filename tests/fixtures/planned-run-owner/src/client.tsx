import type { ClientPluginContext } from '@aork/sdk/client';
export function activate(context: ClientPluginContext) { for (const name of ['navigation', 'create', 'detail', 'composer', 'messages', 'tools', 'input-options','header','actions'])
    context.registerView(name, () => null); }
