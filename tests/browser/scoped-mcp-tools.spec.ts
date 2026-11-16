import { test, expect } from '@playwright/test';
import { mcpHost, waitMcp } from '../fixtures/mcp-host.js';
import { sessionEnvironment } from '../fixtures/session-host.js';
test('browser chooses Host tools, observes real MCP calls and opens their actual file', async ({ page }) => {
    const f = await mcpHost();
    const env = await sessionEnvironment(f);
    try {
        await page.goto(f.host.accessUrl);
        await page.evaluate(input => { location.hash = new URLSearchParams({ project: input.projectId, workspace: input.workspaceId }).toString(); }, env.input);
        await page.getByRole('button', { name: '新建会话', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('会话名称').fill('MCP browser work');
        await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
        await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'MCP browser work', exact: true })).toBeVisible();
        const tools = page.getByRole('group', { name: '工作台工具' });
        await tools.getByText('选择下次运行工具', { exact: true }).click();
        await tools.getByLabel('Read workspace text', { exact: true }).check();
        await tools.getByLabel('Write workspace text', { exact: true }).check();
        await tools.getByRole('button', { name: '保存下次运行工具', exact: true }).click();
        await expect(tools.getByText('已保存 2 项工具', { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByText('已保存 2 项工具', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '启动运行', exact: true }).click();
        await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
        await page.getByLabel('消息输入', { exact: true }).fill(JSON.stringify({ tool: 'Write workspace text', arguments: { path: 'browser-mcp.md', text: 'Visible real MCP result' } }));
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await expect(page.getByRole('region', { name: '工作台实际工具调用' }).getByText('已成功', { exact: true })).toBeVisible();
        const records=page.getByRole('region',{name:'工作台实际工具调用'});await records.locator('details summary').first().click();await records.getByRole('button',{name:'查看完整工具结果',exact:true}).click();await expect(records.locator('pre')).toContainText('browser-mcp.md');
        const files = page.getByRole('region', { name: '工作区文件', exact: true });
        await files.getByRole('button', { name: '刷新文件', exact: true }).click();
        await files.getByRole('button', { name: 'browser-mcp.md 23 B', exact: true }).click();
        await expect(page.getByRole('region', { name: '工作区文件', exact: true }).getByText('Visible real MCP result', { exact: true })).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: '/tmp/aork24-tools-mobile.png', fullPage: true });
        await page.getByText('选择下次运行工具', { exact: true }).click();
        await page.getByRole('button', { name: '撤销本次运行工具', exact: true }).click();
        await expect(page.getByText('运行已结束', { exact: true })).toBeVisible();
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
import { installConformance, startMcp } from '../fixtures/mcp-host.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
test('an independently installed public selector replaces the child without rebuilding the Host', async ({ page }) => {
    const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await mcpHost(options => installConformance(options, true));
    try {
        const { env, session } = await startMcp(f, ['workspace-tools.read_text']);
        await page.goto(f.host.accessUrl);
        await page.evaluate(({ projectId, workspaceId, sessionId }) => { location.hash = new URLSearchParams({ project: projectId, workspace: workspaceId, session: sessionId }).toString(); }, { projectId: env.project.id, workspaceId: env.workspace.id, sessionId: session.id });
        const selector = page.getByRole('region', { name: '独立工具选择' });
        await expect(selector.getByText('已选择 1 项', { exact: true })).toBeVisible();
        await selector.getByRole('button', { name: 'Independent conformance tool', exact: true }).click();
        await expect(selector.getByText('已选择 1 项', { exact: true })).toBeVisible();
        await page.reload();
        await expect(selector).toBeVisible();
        const saved = await (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).json();
        expect(saved.selection.tools[0].id).toBe('tool-conformance.check');
        expect(saved.runs[0].snapshot.tools[0].id).toBe('workspace-tools.read_text');
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
import { installSchemaTools } from '../fixtures/mcp-host.js';
test('the default selector explicitly removes an unavailable saved ref and replaces it with a live tool', async ({ page }) => {
    const f = await mcpHost(installSchemaTools);
    try {
        const env = await sessionEnvironment(f);
        const session = (await (await f.command('sessions.create', { ...env.input, tools: [{ id: 'workspace-tools.read_text', definitionVersion: '1' }] })).json()).result;
        await page.goto(f.host.accessUrl);
        await page.evaluate(({ projectId, workspaceId, sessionId }) => { location.hash = new URLSearchParams({ project: projectId, workspace: workspaceId, session: sessionId }).toString(); }, { projectId: env.project.id, workspaceId: env.workspace.id, sessionId: session.id });
        expect((await f.command('plugins.setEnabled', { pluginId: 'workspace-tools', enabled: false })).status).toBe(200);
        await f.refreshBootstrap();
        await page.reload();
        const selection = page.getByRole('group', { name: '工作台工具' });
        await selection.getByText('选择下次运行工具', { exact: true }).click();
        const remove = selection.getByRole('button', { name: '移除不可用工具 workspace-tools.read_text 1', exact: true });
        await expect(remove).toBeVisible({ timeout: 1500 });
        await remove.click();
        await selection.getByLabel('Schema first', { exact: true }).check();
        await selection.getByRole('button', { name: '保存下次运行工具', exact: true }).click();
        await expect(selection.getByText('已保存 1 项工具', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '启动运行', exact: true }).click();
        await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
        await page.getByLabel('消息输入', { exact: true }).fill(JSON.stringify({ tool: 'Schema first', arguments: { old: 'repaired through UI' } }));
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await expect(page.getByRole('region', { name: '工作台实际工具调用' }).getByText('已成功', { exact: true })).toBeVisible();
        await selection.getByRole('button', { name: '清空工具选择', exact: true }).click();
        await selection.getByRole('button', { name: '保存下次运行工具', exact: true }).click();
        await expect(selection.getByText('已保存 0 项工具', { exact: true })).toBeVisible();
        const state = await (await fetch(`${f.host.url}/api/resources/tools.session?sessionId=${session.id}`, { headers: { Cookie: f.cookie } })).json();
        expect(state.selection.tools).toEqual([]);
        expect(state.runs[0].snapshot.tools[0].id).toBe('schema-tools.first');
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
