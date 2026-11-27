// Probe panel types for the right region's own tests. They show exactly what the region handed
// them — the tab's content, whether it floats, a fresh number per mount — and report every abort
// of a tab's signal, so a test can tell a remount from a kept instance and a close from a switch.
import { useEffect, useState } from 'react';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import type { ClientPluginContext, ViewProps } from '@aork/sdk/client';

/** What probe bodies observed, for a test to read through `window`. */
interface Observed { aborted: string[] }
const observed = (): Observed => ((window as unknown as { __aorkInspectorProbes?: Observed }).__aorkInspectorProbes ??= { aborted: [] });
const tabOf = (context: unknown): InspectorTabContext['tab'] | undefined => (context as InspectorTabContext | undefined)?.tab;

let mounts = 0;

/** A multi-instance type: one tab per piece of content, each identity its own. */
function Probe({ context }: ViewProps) {
    const tab = tabOf(context);
    // A fresh number per mount: a test sees whether this instance was kept or replaced.
    const [mount] = useState(() => ++mounts);
    const content = tab?.content ?? '无';
    useEffect(() => {
        if (!tab) return undefined;
        const abort = (): void => { observed().aborted.push(tab.id); };
        tab.signal.addEventListener('abort', abort);
        return () => tab.signal.removeEventListener('abort', abort);
    }, [tab]);
    return <section aria-label={`探针 ${content}`} data-probe-content={content} data-probe-mount={mount} data-probe-floating={tab?.floating === true ? 'true' : 'false'}>
        <p>内容：{content}</p>
        <p>挂载序号：{mount}</p>
        <button type="button" onClick={() => tab?.setTitle(`探针 ${content.slice(0, 8)}`)}>改标题</button>
        <button type="button" onClick={() => tab?.open('probe-doc', `docs/${content.slice(0, 4)}.md`)}>打开查看器</button>
        <button type="button" onClick={() => tab?.open('probe-doc', `docs/${content.slice(0, 4)}.md`, { replace: true })}>换成本标签</button>
        <button type="button" onClick={() => tab?.close()}>关闭自己</button>
        <input aria-label="探针输入" defaultValue="" />
    </section>;
}

/** A multi-instance type a link can open: it shows the content the trigger named and titles itself by it. The trigger is the fixture's own: `tab.open` opens every installed type that declares the one it is given, and the default profile's preview plugin declares `preview`. */
function Viewer({ context }: ViewProps) {
    const tab = tabOf(context);
    const content = tab?.content ?? '无';
    const [mount] = useState(() => ++mounts);
    useEffect(() => { tab?.setTitle(`查看器 ${content}`); }, [tab, content]);
    return <section aria-label={`查看器 ${content}`} data-viewer-content={content} data-viewer-mount={mount}>
        <p>内容：{content}</p>
        {/* Asking for this tab's own content again is a reveal of a tab that is already on screen. */}
        <button type="button" onClick={() => tab?.open('probe-doc', content)}>再打开一次</button>
    </section>;
}

/** A single-instance type: one tab for the whole region. */
function Lone() {
    return <section aria-label="独例"><p>独例内容</p></section>;
}

export function activate(context: ClientPluginContext) {
    context.registerExtension('probe', Probe);
    context.registerExtension('viewer', Viewer);
    context.registerExtension('lone', Lone);
}
