import { z } from 'zod';
import type { ServerPluginContext } from '@aork/sdk/server';
import { TOOLS_SERVICE } from '@aork/contracts/tools';
import type { ToolResult, ToolsService } from '@aork/contracts/tools';
export function activate(context: ServerPluginContext) {
    const tools = context.service<ToolsService>(TOOLS_SERVICE);
    let late = 'not-requested';
    let completed = 0;
    const input = z.object({ mode: z.enum(['normal', 'throw', 'invalid', 'oversize', 'unawaited', 'late', 'cancel']), path: z.string().optional(), text: z.string().optional() }).strict();
    context.effect(() => tools.registerTool({ id: 'tool-conformance.check', definitionVersion: '1', title: 'Independent conformance tool', description: 'Public independently packaged tool provider.', access: 'write',writerCoverage:'invocation', inputSchema: z.toJSONSchema(input), arguments: input }, async (args, call) => {
        if (args.mode === 'throw')
            throw Error('PRIVATE_HANDLER_DETAIL_MUST_NOT_LEAK');
        if (args.mode === 'invalid')
            return { content: [{ type: 'unknown', secret: 'PRIVATE_INVALID_SHAPE' }] } as unknown as ToolResult;
        if (args.mode === 'oversize')
            return { content: [{ type: 'text', text: 'x'.repeat(1048576) }] };
        if (args.mode === 'cancel') {
            await new Promise<void>(resolve => { if (call.signal.aborted)
                resolve();
            else
                call.signal.addEventListener('abort', () => resolve(), { once: true }); });
            throw Error('cancelled');
        }
        if (args.mode === 'late') {
            setTimeout(() => { void call.files.writeText('late-should-not-exist.txt', 'late').then(() => { late = 'unexpected-write'; }, () => { late = 'rejected'; }); }, 50);
            return { content: [{ type: 'text', text: 'completed before late use' }] };
        }
        if (args.mode === 'unawaited') {
            void call.files.writeText(args.path ?? 'unawaited.txt', args.text ?? 'tracked unawaited IO').finally(() => { completed++; }).catch(() => { });
            return { content: [{ type: 'text', text: 'handler returned before IO delivery' }] };
        }
        return { content: [{ type: 'text', text: 'independent real handler' }] };
    }));
    context.query('conformance.status', { access: 'authenticated', execute: () => ({ late, completed }) });
}
