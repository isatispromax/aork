import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sessionHost } from '../fixtures/session-host.js';
import { openWorkbench } from '../fixtures/workbench-host.js';
import { openPanel } from '../fixtures/right-region.js';

/** The frame policy the panel embeds pages under (plugins/browser/src/page.ts). */
const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** A small site on its own loopback origin: what the panel embeds. */
async function startSite(): Promise<{ url: string; close(): Promise<void> }> {
    const pages: Record<string, string> = {
        '/one': '<!doctype html><html><head><title>One</title></head><body><h1>Page one</h1><a href="/two">to two</a></body></html>',
        '/two': '<!doctype html><html><head><title>Two</title></head><body><h1>Page two</h1></body></html>',
    };
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://aork.test').pathname;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(pages[path] ?? '<!doctype html><html><body><h1>Not found</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

/** Selects a Session of the environment in the page. */
function show(page: Page, env: { workspace: { id: string } }, sessionId: string) {
    return page.evaluate(({ workspace, session }) => { location.hash = new URLSearchParams({ workspace, session }).toString(); }, { workspace: env.workspace.id, session: sessionId });
}

test('the browser panel embeds HTTP(S) pages under its own history, refuses what it must not embed, and restores a saved page only when asked', async ({ page }) => {
    const f = await sessionHost();
    const site = await startSite();
    try {
        await page.setViewportSize({ width: 1440, height: 940 });
        const { env, session } = await openWorkbench(f, 'Browser');
        await page.goto(f.host.accessUrl);
        await show(page, env, session.id);
        const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
        await openPanel(page, '浏览器');
        const panel = right.getByRole('region', { name: '浏览器面板', exact: true });
        const address = panel.getByRole('textbox', { name: '输入 HTTP(S) 地址' });
        const control = (name: string) => panel.getByRole('button', { name, exact: true });
        const frame = page.locator('[data-browser-frame]');
        const shown = page.frameLocator('[data-browser-frame]');
        const chipFor = (title: string | RegExp) => right.getByRole('tablist').getByRole('tab', { name: title });

        // Nothing is loaded until an address is asked for.
        await expect(panel.getByText('输入 HTTP(S) 地址开始浏览', { exact: true })).toBeVisible();
        await expect(frame).toHaveCount(0);
        for (const name of ['后退', '前进', '刷新', '在系统浏览器中打开']) await expect(control(name)).toBeDisabled();

        // What the panel will not embed is refused with its reason, and loads nothing.
        const refuse = async (value: string, message: string): Promise<void> => {
            await address.fill(value);
            await address.press('Enter');
            await expect(panel.getByRole('alert')).toHaveText(message);
            await expect(frame).toHaveCount(0);
        };
        await refuse('', '请输入地址。');
        await refuse('http://', '这个地址无效或过长。');
        for (const value of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,hi']) await refuse(value, '只支持 HTTP 和 HTTPS 地址。');
        await refuse('https://user:secret@example.com/', '地址不能包含用户名或密码。');
        // The workbench's own origin carries the signed-in session: never embedded.
        await refuse(f.host.url, '不能在嵌入浏览器中打开 Aork 自身。');

        // An address loads in an embedded frame under the fixed policy, and the chip names its host.
        await address.fill(`${site.url}/one`);
        await address.press('Enter');
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        await expect(panel.getByRole('alert')).toHaveCount(0);
        await expect(frame).toHaveAttribute('sandbox', WEB_BROWSER_SANDBOX);
        await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
        await expect(address).toHaveValue(`${site.url}/one`);
        await expect(chipFor(/127\.0\.0\.1/)).toHaveAttribute('aria-selected', 'true');
        for (const name of ['后退', '前进']) await expect(control(name)).toBeDisabled();

        // The panel keeps its own history: back and forward across what was asked for.
        await address.fill(`${site.url}/two`);
        await address.press('Enter');
        await expect(shown.getByRole('heading', { name: 'Page two' })).toBeVisible();
        await expect(control('后退')).toBeEnabled();
        await control('后退').click();
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        await expect(address).toHaveValue(`${site.url}/one`);
        await control('前进').click();
        await expect(shown.getByRole('heading', { name: 'Page two' })).toBeVisible();
        await expect(control('前进')).toBeDisabled();

        // A page that navigated itself went where the panel cannot read: it says so rather than guess,
        // and offers Reload back to the last address it asked for.
        await control('后退').click();
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        await shown.getByRole('link', { name: 'to two' }).click();
        await expect(panel.getByText('URL 已变化', { exact: true })).toBeVisible();
        await expect(address).toHaveValue(`${site.url}/one`);
        for (const name of ['后退', '前进', '在系统浏览器中打开']) await expect(control(name)).toBeDisabled();
        await expect(panel.getByText('页面已跳转；当前载体无法读取新的 URL。')).toBeVisible();
        await control('刷新').click();
        await expect(panel.getByText('URL 已变化', { exact: true })).toHaveCount(0);
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        // The address is known again, so the history can be walked: this is its first entry.
        await expect(control('后退')).toBeDisabled();
        await expect(control('前进')).toBeEnabled();

        // The frame policy can be lifted for a page that needs it, with a warning saying what that allows.
        await control('关闭沙箱限制').click();
        await expect(panel.getByRole('status')).toHaveText('沙箱限制已关闭；页面可以导航顶层应用，并使用下载、模态对话框与输入锁定。');
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        expect(await frame.getAttribute('sandbox')).toBeNull();
        await expect(control('恢复沙箱限制')).toHaveAttribute('aria-pressed', 'true');
        await control('恢复沙箱限制').click();
        await expect(panel.getByRole('status')).toHaveCount(0);
        await expect(frame).toHaveAttribute('sandbox', WEB_BROWSER_SANDBOX);
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();

        // Switching away from the tab and back reloads the page; the history is where it was left.
        await right.getByRole('button', { name: '新建标签页', exact: true }).click();
        await expect(panel).toHaveCount(0);
        await chipFor(/127\.0\.0\.1/).click();
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        await expect(control('前进')).toBeEnabled();

        // After a reload the saved address is offered back, and nothing loads until it is asked for.
        await page.reload();
        const restore = panel.getByRole('region', { name: '上次打开', exact: true });
        await expect(restore).toContainText('127.0.0.1');
        await expect(restore).toContainText(`${site.url}/one`);
        await expect(frame).toHaveCount(0);
        await panel.getByRole('button', { name: '恢复页面', exact: true }).click();
        await expect(shown.getByRole('heading', { name: 'Page one' })).toBeVisible();
        await expect(restore).toHaveCount(0);
        // The history was saved with the address.
        await expect(control('前进')).toBeEnabled();

        // Another tab of the type is another page: it starts empty while the first keeps its place.
        // The start page was saved beside the first, so one pane does not offer the add control.
        await expect(right.getByRole('button', { name: '新建标签页', exact: true })).toHaveCount(0);
        await chipFor(/开始/).click();
        await openPanel(page, '浏览器');
        await expect(panel.getByText('输入 HTTP(S) 地址开始浏览', { exact: true })).toBeVisible();
        await expect(frame).toHaveCount(0);
        // The first tab's chip reads its host; only the new one still reads the type's label.
        await expect(chipFor(/浏览器/)).toHaveCount(1);
        await expect(chipFor(/127\.0\.0\.1/)).toHaveCount(1);

        // Dragged out of the region, the panel fills its floating window.
        const box = (await chipFor(/127\.0\.0\.1/).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x - 160, box.y + 240, { steps: 6 });
        await page.mouse.move(box.x - 420, box.y + 320, { steps: 6 });
        await page.mouse.up();
        const float = page.locator('[data-dock-float]');
        await expect(float).toHaveCount(1);
        await expect(float.locator('[data-browser-frame]')).toBeVisible();
        expect((await float.locator('[data-browser-frame]').boundingBox())!.height).toBeGreaterThan(200);

        // Closing a tab drops the navigation it saved.
        await float.getByRole('button', { name: '关闭：127.0.0.1', exact: true }).click();
        await expect(float).toHaveCount(0);
        const saved = await page.evaluate((key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{"byTab":{}}').byTab), `aork.browser.v1.${session.id}`);
        expect(saved).toEqual([]);
    }
    finally { await page.goto('about:blank').catch(() => { }); await site.close(); await f.close(); }
});
