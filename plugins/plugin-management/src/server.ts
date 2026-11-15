import { z } from 'zod';
import { AorkError, distributionProfileSchema } from '@aork/sdk';
import { PLUGIN_MANAGEMENT_SERVICE } from '@aork/sdk/server';
import type { PluginManagementService, ServerPluginContext } from '@aork/sdk/server';
export function activate(context: ServerPluginContext) {
 const service=context.service<PluginManagementService>(PLUGIN_MANAGEMENT_SERVICE);
 function parse<T>(schema:z.ZodType<T>,payload:unknown):T{const result=schema.safeParse(payload);if(!result.success)throw new AorkError('INVALID_PLUGIN_COMMAND','Plugin management payload must match the declared fields');return result.data;}
 const id=z.string().regex(/^[a-z][a-z0-9.-]*$/);
 context.query('plugins.management',{access:'authenticated',execute:()=>service.inspect()});
 context.command('plugins.configure',{access:'authenticated',execute:payload=>{const value=parse(z.object({pluginId:id,config:z.record(z.string(),z.json()),version:z.string().optional()}).strict(),payload);return service.configure(value.pluginId,value.config,value.version);}});
 context.command('plugins.setEnabled',{access:'authenticated',execute:payload=>{const value=parse(z.object({pluginId:id,enabled:z.boolean(),version:z.string().optional()}).strict(),payload);return service.setEnabled(value.pluginId,value.enabled,value.version);}});
 context.command('plugins.compose',{access:'authenticated',execute:payload=>{const value=parse(z.object({ui:distributionProfileSchema.shape.ui}).strict(),payload);return service.compose(value.ui);}});
}
