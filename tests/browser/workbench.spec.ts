import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from '../fixtures/session-host.js';
import { startStructured } from '../fixtures/structured-host.js';
test('cross-project pending jump renders the public form and persisted themes keep the Session draft', async ({ page }) => {
    const f = await sessionHost();
    try {
        const { session } = await startStructured(f);
        await page.goto(f.host.accessUrl);
        await page.getByRole('button', { name: '待处理 · 1', exact: true }).click();
        await expect(page.getByRole('heading', { name: '待处理请求', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '打开请求：Plan the research', exact: true }).click();
        await expect(page.getByRole('form', { name: '结构化输入表单', exact: true })).toBeVisible();
        expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('session')).toBe(session.id);
        await page.getByLabel('消息输入', { exact: true }).fill('Draft remains');
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByLabel('主题', { exact: true }).selectOption('dark');
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('Draft remains');
        await expect(page.locator('html')).toHaveAttribute('data-aork-theme', 'dark');
        await page.reload();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('Draft remains');
        await expect(page.locator('html')).toHaveAttribute('data-aork-theme', 'dark');
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('only the opened reply advances read state across tabs, refresh and later unseen completion', async ({ browser }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const one = await openWorkbench(f, 'First reply');
        const two = await openWorkbench(f, 'Other project reply');
        const page = await context.newPage();
        const other = await context.newPage();
        await page.goto(f.host.accessUrl);
        await other.goto(f.host.accessUrl);
        await page.bringToFront();
        await expect(page.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '未读 · 2', exact: true }).click();
        await page.getByRole('region', { name: '未读回复列表' }).getByRole('article').filter({ hasText: 'First reply' }).getByRole('button', { name: '打开回复', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Completed ordinary question: First reply?');
        await expect(page.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await expect(other.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await f.command('sessions.sendText', { sessionId: one.session.id, text: 'Unseen future' });
        await expect(other.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).not.toContainText('Unseen future');
        await page.reload();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('First reply');
        await expect(page.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        const unread = await (await f.query('workbench.unread')).json();
        expect(unread.items.some((item: any) => item.sessionId === two.session.id)).toBe(true);
        await page.screenshot({ path: '/tmp/aork18-session-light.png', fullPage: true });
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('opening a long reply keeps unread until every requested page has actually been expanded', async ({ page }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    try {
        await openWorkbench(f, 'long');
        await page.goto(f.host.accessUrl);
        await page.getByRole('button', { name: '未读 · 1', exact: true }).click();
        await page.getByRole('button', { name: '打开回复', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Reply page 49');
        await expect(page.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '展开后续回复内容', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Reply page 54');
        await expect(page.getByRole('button', { name: '未读 · 0', exact: true })).toBeVisible();
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('independently installed complete layout and message child preserve services, stable extensions and local failure without reading unseen content', async ({ page }) => {
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { independentWorkbench, openWorkbench } = await import('../fixtures/workbench-host.js');
    const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await independentWorkbench();
    try {
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
        const { session } = await openWorkbench(f, 'Independent first');
        await page.goto(f.host.accessUrl);
        await expect(page.getByText('独立完整布局', { exact: true })).toBeVisible();
        await expect(page.getByRole('navigation', { name: '独立菜单' }).getByRole('button',{name:/^扩展/})).toHaveText(['扩展 Beta', '扩展 Alpha']);
        await expect(page.getByText('扩展通知', { exact: true })).toHaveCount(0);
        await page.evaluate(session => { location.hash = new URLSearchParams({ project: session.projectId, workspace: session.workspaceId, session: session.id, broken: '1' }).toString(); }, session);
        await expect(page.getByRole('alert').filter({ hasText: 'aork.sessions.messages@1' })).toBeVisible();
        await expect(page.getByLabel('消息输入', { exact: true })).toBeVisible();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 1');
        expect((await (await f.query('workbench.unread')).json()).count).toBe(1);
        await page.reload();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 1');
        await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.delete('broken'); location.hash = values.toString(); });
        await page.reload();
        await expect(page.getByRole('heading', { name: '独立可替换消息', exact: true })).toBeVisible();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 0');
        await page.screenshot({ path: '/tmp/aork18-independent-layout.png', fullPage: true });
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('hidden pending navigation keeps cross-project native requests actionable and both tabs observe actual responses', async ({ browser }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost(false, async ({ profile }) => { profile.ui.extensions.push({ id: 'workbench:pending-link', order: 10, hidden: true }); });
    const context = await browser.newContext();
    try {
        const permission = await openWorkbench(f, 'permission');
        const form = await openWorkbench(f, 'form');
        await openWorkbench(f, 'ordinary completed question');
        const first = await context.newPage();
        const other = await context.newPage();
        await first.goto(f.host.accessUrl);
        await other.goto(f.host.accessUrl);
        await first.bringToFront();
        await expect(first.getByRole('button', { name: /^待处理 ·/ })).toHaveCount(0);
        for (const page of [first, other])
            await page.evaluate(() => { location.hash = 'page=pending'; });
        await expect(first.getByRole('region', { name: '跨项目待处理' })).toContainText('2 个有效请求');
        await expect(other.getByRole('region', { name: '跨项目待处理' })).toContainText('2 个有效请求');
        await first.getByRole('button', { name: '打开请求：Read notes 0', exact: true }).click();
        await first.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(other.getByRole('region', { name: '跨项目待处理' })).toContainText('1 个有效请求');
        await other.getByRole('button', { name: '打开请求：Plan the research', exact: true }).click();
        await other.bringToFront();
        await other.getByRole('form', { name: '结构化输入表单', exact: true }).getByRole('button', { name: '拒绝提供', exact: true }).click();
        await expect(other.getByText('已发送响应', { exact: true })).toBeVisible();
        await expect.poll(async () => (await (await f.query('interactions.pending')).json()).pending.length).toBe(0);
        expect((await (await f.query('interactions.inputPending')).json()).pending).toEqual([]);
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('compact mobile drawers return focus and light dark system changes retain draft and Files selection', async ({ page }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    try {
        await page.setViewportSize({width:1440,height:940});const { env, session } = await openWorkbench(f, 'mobile');
        await writeFile(join(env.workspace.directory, 'notes.md'), 'Selected real file\n');
        await page.goto(f.host.accessUrl);
        await page.evaluate(session => { location.hash = new URLSearchParams({ project: session.projectId, workspace: session.workspaceId, session: session.id, file: 'notes.md' }).toString(); }, session);
        await page.getByLabel('消息输入', { exact: true }).fill('保留输入草稿');
        await expect(page.getByRole('region', { name: '工作区文件', exact: true })).toContainText('Selected real file');
        await page.getByRole('button', { name: '设置', exact: true }).click();
        for (const theme of ['dark', 'light', 'system']) {
            await page.getByLabel('主题', { exact: true }).selectOption(theme);
            await expect(page.getByLabel('主题', { exact: true })).toHaveValue(theme);
        }
        await page.getByLabel('主题', { exact: true }).selectOption('dark');
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('保留输入草稿');
        await expect(page.getByRole('region', { name: '工作区文件', exact: true })).toContainText('Selected real file');
        await page.screenshot({ path: '/tmp/aork18-session-dark.png', fullPage: true });
        await page.getByRole('button',{name:'切换文件面板宽度',exact:true}).click();
        await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();await page.reload();
        await expect(page.getByRole('region',{name:'工作区文件',exact:true})).toBeHidden();await expect(page.getByLabel('消息输入',{exact:true})).toHaveValue('保留输入草稿');
        await page.getByRole('button',{name:'切换文件面板',exact:true}).click();await expect(page.getByRole('region',{name:'工作区文件',exact:true})).toContainText('Selected real file');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '切换导航', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '工作台侧栏', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: '切换导航', exact: true })).toBeFocused();
        await page.getByRole('button', { name: '切换文件面板', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '会话文件', exact: true })).toContainText('Selected real file');await page.getByRole('button',{name:'返回文件树',exact:true}).click();await page.getByRole('button',{name:/notes\.md/}).click();await expect(page.getByRole('dialog',{name:'会话文件',exact:true})).toContainText('Selected real file');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: '切换文件面板', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('保留输入草稿');
        await page.screenshot({ path: '/tmp/aork18-session-mobile.png', fullPage: true });
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
