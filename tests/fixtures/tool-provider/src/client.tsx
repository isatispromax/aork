import { useEffect, useState } from 'react';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';
import { readWorkbenchSelection } from '@aork/contracts/workspace';
import type { ToolCatalogEntry, ToolRef } from '@aork/contracts/tools';
function Independent({ runtime }: ViewProps) { const id = readWorkbenchSelection(location.hash).sessionId; const [tools, setTools] = useState<ToolCatalogEntry[]>([]); const [selection, setSelection] = useState<{
    revision: number;
    tools: ToolRef[];
}>(); const [error, setError] = useState(''); useEffect(() => { void runtime.query<{
    tools: ToolCatalogEntry[];
}>('tools.catalog').then(value => setTools(value.tools)); if (!id)
    return; return runtime.observeSnapshot<{
    selection: {
        revision: number;
        tools: ToolRef[];
    };
}>('tools.session', { sessionId: id }, { next: value => setSelection(value.selection), error: failure => setError(failure.message) }, { owners: ['tools'] }); }, [runtime, id]); return <section aria-label="独立工具选择"><h3>独立工具选择</h3><p>已选择 {selection?.tools.length ?? 0} 项</p>{tools.map(tool => <button key={tool.id} onClick={() => { void runtime.command('tools.replaceSessionSelection', { sessionId: id, expectedRevision: selection?.revision, tools: [{ id: tool.id, definitionVersion: tool.definitionVersion }] }, crypto.randomUUID(), { version: 1 }).catch(failure => setError(failure.message)); }}>{tool.title}</button>)}{error && <p role="alert">{error}</p>}</section>; }
export function activate(context: ClientPluginContext) { context.registerView('selection', Independent); }
