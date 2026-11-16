import { z } from 'zod';
import type { ServerPluginContext } from '@aork/sdk/server';
import { TOOLS_SERVICE } from '@aork/contracts/tools';
import type { ToolsService } from '@aork/contracts/tools';
export function activate(context: ServerPluginContext) {
    const tools = context.service<ToolsService>(TOOLS_SERVICE);
    let invoked = 0;
    const define = (id: string, field: string, version = '1') => tools.registerTool({ id: `schema-tools.${id}`, definitionVersion: version, title: `Schema ${id}`, description: 'Independent schema validation conformance', access: 'read', inputSchema: { $id: 'urn:aork:schema-tools:shared', type: 'object', properties: { [field]: { type: 'string' } }, required: [field], additionalProperties: false }, arguments: { parse: value => value } }, args => { invoked++; return { content: [{ type: 'text', text: JSON.stringify(args) }] }; });
    context.effect(() => define('first', 'old'));
    context.effect(() => define('second', context.config.shape === 'changed' ? 'changed' : 'next', context.config.shape === 'changed' ? '2' : '1'));
    context.effect(() => tools.registerTool({ id: 'schema-tools.async_parser', definitionVersion: '1', title: 'Async parser forbidden', description: 'Parser contract is synchronous', access: 'read', inputSchema: { type: 'object', properties: { reject: { type: 'boolean' } }, additionalProperties: false }, arguments: { parse: (value: unknown) => (value as {
                reject?: boolean;
            }).reject ? Promise.reject(new Error('PRIVATE_ASYNC_PARSER_ERROR')) : Promise.resolve(value) } }, () => { invoked++; return { content: [] }; }));
    context.command('schemaTools.asyncRegistration', { access: 'authenticated', execute() { try {
            const dispose = tools.registerTool({ id: 'schema-tools.async', definitionVersion: '1', title: 'Async forbidden', description: 'Unsupported asynchronous schema must be rejected before compilation', access: 'read', inputSchema: { $async: true, type: 'object', required: ['required'] }, arguments: { parse: value => value } }, () => { invoked++; return { content: [] }; });
            context.effect(() => dispose);
            return { accepted: true };
        }
        catch (error) {
            return { accepted: false, code: (error as {
                    code?: string;
                }).code ?? 'OTHER' };
        } } });
    context.query('schemaTools.status', { access: 'authenticated', execute: () => ({ invoked }) });
}
