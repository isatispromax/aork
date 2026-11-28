import type { ClientPluginContext } from '@aork/sdk/client';
export function activate(context: ClientPluginContext) { for (const name of ['rows', 'create', 'detail', 'composer', 'messages', 'tools', 'input-options','header','actions','handoff','recovery','native-history'])
    context.registerView(name, () => null); }
