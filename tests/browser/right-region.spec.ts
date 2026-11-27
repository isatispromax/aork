import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from '../fixtures/session-host.js';
import { openWorkbench } from '../fixtures/workbench-host.js';
import { openPanel } from '../fixtures/right-region.js';

/** Selects a Session of the environment in the page, with any extra hash keys. */
function show(page: import('@playwright/test').Page, env: { workspace: { id: string } }, sessionId: string, extra: Record<string, string> = {}) {
    return page.evaluate(({ workspace, session, extra }) => { location.hash = new URLSearchParams({ workspace, session, ...extra }).toString(); }, { workspace: env.workspace.id, session: sessionId, extra });
}
const chipIn = (region: import('@playwright/test').Locator, title: string) => region.getByRole('tablist').getByRole('tab', { name: new RegExp(title) });
const control = (region: import('@playwright/test').Locator, name: string) => region.getByRole('button', { name, exact: true });

type Host = Awaited<ReturnType<typeof import('../fixtures/session-host.js').sessionHost>>;
/** The panel types the installed profile offers the right region, in the order the start page lists them. */
function panelTypes(host: Host) {
    return host.bootstrap.plugins.flatMap(plugin => plugin.manifest.ui.extensions
        .filter(extension => extension.target === 'aork.workbench.inspector-tabs@1')
        .map(extension => ({ id: `${plugin.id}:${extension.id}`, label: extension.label ?? extension.id, order: extension.order ?? 0 })))
        .map(type => ({ ...type, ...host.bootstrap.profile.ui.extensions.find(preference => preference.id === type.id) }))
        .filter(type => !type.hidden)
        .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : 1));
}

test('the right region opens on its start page, where a picked panel type becomes a tab in its place', async ({ page }) => {
    const f = await sessionHost();
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Start page');
        const second = (await (await f.command('sessions.create', { ...env.input, name: 'Other layout' })).json()).result as { id: string };
        await writeFile(join(env.workspace.directory, 'notes.md'), 'Deep linked file\n');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        const strip = right.getByRole('tablist');
        const entries = right.getByRole('group', { name: '打开面板' }).getByRole('button');
        // Several types are installed, so the strip's first tab is the start page, with the region's own controls at its end.
        const types = panelTypes(f);
        expect(types.length).toBeGreaterThan(1);
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'true');
        for (const name of ['全屏右侧栏', '切换右侧栏宽度', '关闭右侧栏']) await expect(control(right, name)).toBeVisible();
        // One capsule per installed panel type, in the profile's order, naming the type and what it is for.
        await expect(entries).toHaveCount(types.length);
        for (const [index, type] of types.entries()) await expect(entries.nth(index)).toContainText(type.label);
        expect(types[0]!.label).toBe('文件');
        // Four types or fewer each get a line under the name; a longer list keeps names only.
        if (types.length <= 4) await expect(entries.first()).toContainText('浏览、搜索、预览与编辑工作区文件');
        // A pane holds one start page, so it draws no add control; showing alone, the start page has no close.
        await expect(control(right, '新建标签页')).toHaveCount(0);
        await expect(control(right, '关闭：开始')).toHaveCount(0);
        // Picking a type opens it as a tab in the start page's place: a doorway, not a page that stays open.
        await entries.first().click();
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(right.getByRole('region', { name: '文件分区', exact: true })).toBeAttached();
        await expect(right.getByRole('group', { name: '打开面板' })).toHaveCount(0);
        await expect(control(right, '新建标签页')).toBeVisible();

        // The add control opens a start page beside the open tab; one per pane, so it then leaves.
        await control(right, '新建标签页').click();
        await expect(strip.getByRole('tab')).toHaveCount(2);
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'true');
        await expect(control(right, '新建标签页')).toHaveCount(0);
        // Chips select on click, and on the keyboard in the tabs pattern.
        await chipIn(right, '文件').click();
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'false');
        await chipIn(right, '文件').focus();
        await page.keyboard.press('ArrowRight');
        await expect(chipIn(right, '开始')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'true');
        // A middle click closes a chip without selecting it.
        await chipIn(right, '文件').click({ button: 'middle' });
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(right.getByRole('group', { name: '打开面板' })).toBeVisible();

        // Closing the last tab returns the region to its start page rather than leaving it empty.
        await entries.first().click();
        await chipIn(right, '文件').hover();
        await control(right, '关闭：文件').click();
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(chipIn(right, '开始')).toBeVisible();
        await expect(right.getByRole('group', { name: '打开面板' })).toBeVisible();

        // Each Session keeps its own layout, across Sessions and across reloads.
        await openPanel(page, '文件');
        await show(page, env, second.id);
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(chipIn(right, '开始')).toBeVisible();
        await expect(right.getByRole('region', { name: '文件分区', exact: true })).toHaveCount(0);
        await show(page, env, session.id);
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await page.reload();
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(strip.getByRole('tab')).toHaveCount(1);

        // A link that names a file opens the panel type declared to open with it, in place of the start page.
        await show(page, env, second.id, { file: 'notes.md' });
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(right.getByRole('region', { name: '工作区文件', exact: true })).toContainText('Deep linked file');
    }
    finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});

test('the right region splits beside itself, floats a dragged tab and goes fullscreen from its strip', async ({ page }) => {
    const f = await sessionHost();
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Split and float');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        const strip = right.getByRole('tablist');
        const panes = right.locator('[data-dock-pane]');
        // The default column is too narrow to halve; the control says so until the region is widened.
        await expect(control(right, '分屏')).toBeDisabled();
        await expect(right.locator('[data-dock-split-control]')).toHaveAttribute('title', '栏宽不足，拖宽后再分屏');
        await control(right, '切换右侧栏宽度').click();
        await expect(control(right, '分屏')).toBeEnabled();
        await control(right, '分屏').click();
        // Two panes side by side, each with its own strip; the new one opens on the start page.
        await expect(panes).toHaveCount(2);
        await expect(strip).toHaveCount(2);
        await expect(panes.last().getByRole('tab', { name: /开始/ })).toBeVisible();
        const [leftEdge, rightEdge] = await panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
        expect(leftEdge!).toBeLessThan(rightEdge!);
        // Two panes is the limit, and the region's own chrome sits only at the end of the top-right pane.
        for (const split of await right.getByRole('button', { name: '分屏', exact: true }).all()) await expect(split).toBeDisabled();
        await expect(panes.first().getByRole('button', { name: '关闭右侧栏', exact: true })).toHaveCount(0);
        await expect(panes.last().getByRole('button', { name: '关闭右侧栏', exact: true })).toBeVisible();
        // Picking a type in a pane opens it there.
        await panes.last().getByRole('group', { name: '打开面板' }).getByRole('button', { name: /文件/ }).click();
        await expect(panes).toHaveCount(2);
        await expect(panes.last().getByRole('tab', { name: /文件/ })).toHaveAttribute('aria-selected', 'true');
        await expect(panes.first().getByRole('tab', { name: /开始/ })).toBeVisible();
        // A type that holds one instance is focused where it already shows rather than opened twice:
        // the start page that offered it closes, and with it the pane that held nothing else.
        await panes.first().getByRole('group', { name: '打开面板' }).getByRole('button', { name: /文件/ }).click();
        await expect(panes).toHaveCount(1);
        await expect(right.getByRole('tab', { name: /文件/ })).toHaveAttribute('aria-selected', 'true');

        // Dragging a chip clear of the region floats it, and the pane it leaves returns to the start page.
        const files = () => panes.first().getByRole('tab', { name: /文件/ });
        const dragOut = async () => {
            await files().click();
            const box = (await files().boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x - 160, box.y + 240, { steps: 6 });
            await page.mouse.move(box.x - 420, box.y + 320, { steps: 6 });
            await page.mouse.up();
            await expect(float).toHaveCount(1);
        };
        const float = page.locator('[data-dock-float]');
        await dragOut();
        await expect(float).toContainText('文件');
        await expect(float.getByRole('region', { name: '文件分区', exact: true })).toBeAttached();
        await expect(panes.first().getByRole('tab', { name: /开始/ })).toBeVisible();
        // A floating panel closes like any other tab, and returns to the dock through its own control.
        await float.getByRole('button', { name: '关闭：文件', exact: true }).click();
        await expect(float).toHaveCount(0);
        await openPanel(page, '文件');
        await dragOut();
        await float.getByRole('button', { name: '收回到停靠栏', exact: true }).click();
        await expect(float).toHaveCount(0);
        await expect(strip.getByRole('tab', { name: /开始/ })).toBeVisible();
        await expect(right.getByRole('tab', { name: /文件/ })).toHaveAttribute('aria-selected', 'true');

        // Fullscreen covers the window and keeps its controls in the strip; the way back is the same control.
        await control(right, '全屏右侧栏').click();
        await expect(control(right, '退出全屏')).toBeVisible();
        // A point over the left rail now hits the region instead of the rail beneath it.
        const overRail = () => page.evaluate(() => {
            const rail = document.querySelector('[data-region="left"]')!.getBoundingClientRect();
            return Boolean(document.elementFromPoint(rail.left + rail.width / 2, rail.top + rail.height / 2)?.closest('[data-region="right"]'));
        });
        expect(await overRail()).toBe(true);
        await expect(control(right, '切换右侧栏宽度')).toBeHidden();
        await control(right, '退出全屏').click();
        expect(await overRail()).toBe(false);
        await expect(control(right, '切换右侧栏宽度')).toBeVisible();
        await expect(control(right, '切换右侧栏宽度')).toBeVisible();
        // Collapsing the region is the strip's last control, and reopening restores the layout.
        await control(right, '关闭右侧栏').click();
        await expect(right).toBeHidden();
        await page.getByRole('button', { name: '切换右侧栏', exact: true }).click();
        await expect(panes).toHaveCount(1);
        await expect(right.getByRole('tab', { name: /文件/ })).toHaveAttribute('aria-selected', 'true');
    }
    finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});

/** Every abort of a tab's signal that a probe body saw, in order. */
const aborted = (page: import('@playwright/test').Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __aorkInspectorProbes?: { aborted: string[] } }).__aorkInspectorProbes?.aborted ?? []);

test('a region with a single panel type opens on that type, and the add control still opens the start page', async ({ page }) => {
    const { inspectorProbes } = await import('../fixtures/workbench-host.js');
    // Every other declared type is hidden, so Files is the region's one type.
    const f = await inspectorProbes('workspace:files-section');
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Single type');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        const strip = right.getByRole('tablist');
        // One type seeds the region itself: there is no start page to walk through first.
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(chipIn(right, '开始')).toHaveCount(0);
        await expect(right.getByRole('region', { name: '文件分区', exact: true })).toBeAttached();
        await expect(right.getByRole('group', { name: '打开面板' })).toHaveCount(0);
        // The add control opens the start page explicitly, and it lists the one type there is.
        await control(right, '新建标签页').click();
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'true');
        await expect(right.getByRole('group', { name: '打开面板' }).getByRole('button')).toHaveCount(1);
        // Beside another tab the start page is an ordinary closable tab.
        await chipIn(right, '开始').hover();
        await control(right, '关闭：开始').click();
        await expect(strip.getByRole('tab')).toHaveCount(1);
        // An emptied region returns to its default page, which here is the type itself.
        await chipIn(right, '文件').hover();
        await control(right, '关闭：文件').click();
        await expect(strip.getByRole('tab')).toHaveCount(1);
        await expect(chipIn(right, '文件')).toHaveAttribute('aria-selected', 'true');
        await expect(right.getByRole('group', { name: '打开面板' })).toHaveCount(0);
    }
    finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});

test('a multi-instance panel type keeps one identity per tab, closes through one route, reveals open content and survives fullscreen', async ({ page }) => {
    const { inspectorProbes } = await import('../fixtures/workbench-host.js');
    const f = await inspectorProbes();
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Probes');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        const chips = right.getByRole('tablist').getByRole('tab');
        const entries = right.getByRole('group', { name: '打开面板' }).getByRole('button');
        const pick = async (title: string): Promise<void> => { await entries.filter({ hasText: title }).first().click(); };
        await expect(chipIn(right, '开始')).toHaveAttribute('aria-selected', 'true');

        // Picking the type twice makes two tabs, each with an identity of its own; only the active one is mounted.
        await pick('探针');
        const content1 = await right.locator('[data-probe-content]').getAttribute('data-probe-content');
        const id1 = await chips.first().getAttribute('data-dock-chip');
        await control(right, '新建标签页').click();
        await pick('探针');
        await expect(chips).toHaveCount(2);
        const content2 = await right.locator('[data-probe-content]').getAttribute('data-probe-content');
        const id2 = await chips.nth(1).getAttribute('data-dock-chip');
        expect(content1).toBeTruthy();
        expect(content2).not.toBe(content1);
        // Switching between them changes which identity is mounted and removes nothing.
        await chips.first().click();
        await expect(right.locator(`[data-probe-content="${content1}"]`)).toBeVisible();
        await chips.nth(1).click();
        await expect(right.locator(`[data-probe-content="${content2}"]`)).toBeVisible();
        expect(await aborted(page)).toEqual([]);
        // A body names its own tab; the chip follows.
        await right.getByRole('button', { name: '改标题', exact: true }).click();
        await expect(chips.nth(1)).toHaveAccessibleName(new RegExp(`探针 ${content2!.slice(0, 8)}`));

        // A secondary press opens the tab's menu. Escape closes it and hands focus back to the chip.
        const menu = page.getByRole('menu', { name: '标签页操作' });
        await chips.nth(1).click({ button: 'right' });
        await expect(menu.getByRole('menuitem')).toHaveText(['关闭', '关闭其他']);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await expect(chips.nth(1)).toBeFocused();
        // The last tab has nothing to its right, so that item is not offered; the first tab has.
        await chips.first().click({ button: 'right' });
        await expect(menu.getByRole('menuitem')).toHaveText(['关闭', '关闭其他', '关闭右侧']);
        await menu.getByRole('menuitem', { name: '关闭右侧', exact: true }).click();
        await expect(chips).toHaveCount(1);
        // Closing is the one thing that aborts a tab's signal.
        expect(await aborted(page)).toEqual([id2]);

        // Content that is already open is revealed where it is rather than opened a second time.
        await right.getByRole('button', { name: '打开查看器', exact: true }).click();
        await expect(chips).toHaveCount(2);
        const viewId = await chips.nth(1).getAttribute('data-dock-chip');
        await expect(chips.nth(1)).toHaveAccessibleName(new RegExp(`查看器 docs/${content1!.slice(0, 4)}`));
        // That reveal switched tabs, which is its own visible change. Asking again for what is already
        // the selected tab on screen switches nothing, so its pane glows once, then the mark goes.
        await right.getByRole('button', { name: '再打开一次', exact: true }).click();
        await expect(chips).toHaveCount(2);
        const glow = right.locator('[data-dock-pane][data-dock-flash]');
        await expect(glow).toHaveCount(1);
        await expect(glow).toHaveCount(0);
        expect(await aborted(page)).toEqual([id2]);
        // A tab lending its place keeps it when the content was already open: only new content takes it.
        await chips.first().click();
        await right.getByRole('button', { name: '换成本标签', exact: true }).click();
        await expect(chips).toHaveCount(2);
        await expect(chips.nth(0)).toHaveAttribute('data-dock-chip', id1!);
        await expect(chips.nth(1)).toHaveAttribute('data-dock-chip', viewId!);
        await expect(chips.nth(1)).toHaveAttribute('aria-selected', 'true');
        expect(await aborted(page)).toEqual([id2]);

        // Fullscreen is the same tree in another place: the mounted body keeps its instance.
        const viewer = right.locator('[data-viewer-mount]');
        const mount = await viewer.getAttribute('data-viewer-mount');
        await control(right, '全屏右侧栏').click();
        await expect(right.locator('[data-inspector-fullscreen]')).toHaveCount(1);
        await expect(viewer).toHaveAttribute('data-viewer-mount', mount!);
        await control(right, '退出全屏').click();
        await expect(right.locator('[data-inspector-fullscreen]')).toHaveCount(0);
        await expect(viewer).toHaveAttribute('data-viewer-mount', mount!);

        // Dragged clear of the region a tab floats, and its body learns that it floats.
        await chips.nth(0).click();
        const box = (await chips.nth(0).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x - 160, box.y + 240, { steps: 6 });
        await page.mouse.move(box.x - 420, box.y + 320, { steps: 6 });
        await page.mouse.up();
        const float = page.locator('[data-dock-float]');
        await expect(float).toHaveCount(1);
        await expect(float.locator('[data-probe-floating]')).toHaveAttribute('data-probe-floating', 'true');
        await float.getByRole('button', { name: '收回到停靠栏', exact: true }).click();
        await expect(float).toHaveCount(0);
        await expect(right.locator('[data-probe-floating]')).toHaveAttribute('data-probe-floating', 'false');

        // A body can close its own tab through the same route as the chip's control.
        await right.getByRole('button', { name: '关闭自己', exact: true }).click();
        await expect(chips).toHaveCount(1);
        expect(await aborted(page)).toEqual([id2, id1]);
        await expect(chips.first()).toHaveAttribute('data-dock-chip', viewId!);
        // What each tab shows, and what it is called, is part of the Session's saved layout.
        await page.reload();
        await expect(chips).toHaveCount(1);
        await expect(chips.first()).toHaveAttribute('data-dock-chip', viewId!);
        await expect(chips.first()).toHaveAccessibleName(new RegExp(`查看器 docs/${content1!.slice(0, 4)}`));
    }
    finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});

test('a strip holding more tabs than fit keeps its controls in place, fades the chips it hides and scrolls the active one into view', async ({ page }) => {
    const { inspectorProbes } = await import('../fixtures/workbench-host.js');
    const f = await inspectorProbes();
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Overflow');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        const chips = right.getByRole('tablist').getByRole('tab');
        const entries = right.getByRole('group', { name: '打开面板' }).getByRole('button');
        const box = right.locator('[data-dock-chips]');
        // Seven tabs of the multi-instance type overflow the default column.
        await entries.filter({ hasText: '探针' }).first().click();
        for (let n = 1; n < 7; n++) { await control(right, '新建标签页').click(); await entries.filter({ hasText: '探针' }).first().click(); await expect(chips).toHaveCount(n + 1); }
        // The controls after the chips never yield: chips go instead. Each tab as it opens is
        // scrolled into view, so the strip sits at its end with its start faded out.
        for (const name of ['新建标签页', '分屏', '全屏右侧栏', '关闭右侧栏']) await expect(control(right, name)).toBeInViewport();
        await expect(chips.last()).toHaveAttribute('aria-selected', 'true');
        await expect(box).toHaveAttribute('data-dock-strip-scroll', /start/);
        expect(await box.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
        // Activating the first chip, now out of view, brings it back clear of the fade; the end fades instead.
        await chips.first().click();
        await expect(chips.first()).toHaveAttribute('aria-selected', 'true');
        await expect(box).toHaveAttribute('data-dock-strip-scroll', 'end');
        await expect.poll(() => box.evaluate(node => node.scrollLeft)).toBe(0);
        // A vertical wheel over the chips scrolls the strip sideways.
        await box.hover();
        await page.mouse.wheel(0, 300);
        await expect.poll(() => box.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});
