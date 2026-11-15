import { z } from 'zod';
import { distributionProfileSchema } from '@aork/sdk';
import { PLUGIN_MANAGEMENT_SERVICE } from '@aork/sdk/server';
import type { PluginManagementService, ServerPluginContext } from '@aork/sdk/server';
export function activate(context: ServerPluginContext) {
 const service=context.service<PluginManagementService>(PLUGIN_MANAGEMENT_SERVICE);
 const id=z.string().regex(/^[a-z][a-z0-9.-]*$/);
 context.query('plugins.management',{access:'authenticated',execute:()=>service.inspect()});
 context.command('plugins.configure',{access:'authenticated',execute:payload=>{const value=z.object({pluginId:id,config:z.record(z.string(),z.json())}).strict().parse(payload);return service.configure(value.pluginId,value.config);}});
 context.command('plugins.setEnabled',{access:'authenticated',execute:payload=>{const value=z.object({pluginId:id,enabled:z.boolean()}).strict().parse(payload);return service.setEnabled(value.pluginId,value.enabled);}});
 context.command('plugins.compose',{access:'authenticated',execute:payload=>{const value=z.object({ui:distributionProfileSchema.shape.ui}).strict().parse(payload);return service.compose(value.ui);}});
}
