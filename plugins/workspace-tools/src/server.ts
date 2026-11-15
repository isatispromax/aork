import { z } from 'zod';
import type { ServerPluginContext } from '@aork/sdk/server';
import { TOOLS_SERVICE } from '@aork/contracts/tools';
import type { ToolsService } from '@aork/contracts/tools';
export function activate(context: ServerPluginContext) {
    const tools = context.service<ToolsService>(TOOLS_SERVICE);
    const path = z.string().min(1).max(4096);
    const read = z.object({ path, startLine: z.number().int().positive().optional(), lines: z.number().int().min(1).max(500).optional() }).strict();
    const write = z.object({ path, text: z.string().max(262144), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
    context.effect(() => tools.registerTool({ id: 'workspace-tools.read_text', definitionVersion: '1', title: 'Read workspace text', description: 'Read UTF-8 text within this Run’s Workspace. Returns text, revision and explicit truncation.', access: 'read', inputSchema: z.toJSONSchema(read), arguments: read }, async (args, call) => ({ content: [{ type: 'text', text: JSON.stringify(await call.files.preview(args.path, args.startLine, args.lines)) }] })));
    context.effect(() => tools.registerTool({ id: 'workspace-tools.write_text', definitionVersion: '1', title: 'Write workspace text', description: 'Atomically write UTF-8 text within this Run’s claimed Workspace. Optional revision prevents overwriting changed text.', access: 'write', inputSchema: z.toJSONSchema(write), arguments: write }, async (args, call) => ({ content: [{ type: 'text', text: JSON.stringify(await call.files.writeText(args.path, args.text, args.expectedRevision)) }] })));
}
