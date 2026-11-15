import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

test('Session navigation creates a real conversation, restores its identity and archives retained history', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.host.accessUrl!);
    await page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: '新建项目', exact: true }).click();
    let dialog = page.getByRole('dialog'); await dialog.getByLabel('项目名称').fill('Research'); await dialog.getByLabel('工作区名称').fill('Notes'); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); await expect(page.getByText('尚无 Agent Profile，请先在设置的 Agent 页面保存配置。', { exact: true })).toBeVisible(); await expect(page.getByRole('dialog').getByRole('button', { name: '创建会话', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('配置名称').fill('Research Agent'); await page.getByLabel('版本要求').fill('^1.0.0'); await page.getByLabel('Model', { exact: true }).fill('controlled-model'); await page.getByRole('button', { name: '保存 Agent Profile' }).click();
    await expect(page.getByText('Agent Profile 已保存', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByLabel('会话名称').fill('Explore sources'); await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await expect(dialog.getByText('Controlled Agent', { exact: true })).toBeVisible(); await expect(dialog.getByText('创建后尚未启动', { exact: true })).toBeVisible();
    await dialog.getByLabel('会话名称').focus(); await dialog.getByLabel('会话名称').dispatchEvent('compositionstart'); await dialog.getByLabel('会话名称').press('Enter'); await expect(dialog).toBeVisible(); expect((await (await f.query()).json()).sessions).toHaveLength(0); await dialog.getByLabel('会话名称').dispatchEvent('compositionend');
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); await expect(page.getByText('尚未启动', { exact: true })).toBeVisible(); await expect(page.getByText('尚无原生历史，不能原生恢复。', { exact: true })).toBeVisible();
    const selectedUrl = page.url(); const sessionId = new URLSearchParams(new URL(selectedUrl).hash.slice(1)).get('session'); expect(sessionId).toBeTruthy();
    const overview = await (await page.request.get(`${f.host.url}/api/queries/sessions.overview`)).json(); expect(overview.sessions[0].session.id).toBe(sessionId);
    await expect(page.getByText(overview.sessions[0].session.workspace.directory, { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); expect(page.url()).toBe(selectedUrl);
    await page.getByRole('button', { name: '归档会话', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '确认归档', exact: true }).click(); await expect(page.getByText('会话已归档，历史与关联保留。', { exact: true })).toBeVisible();
    await page.getByLabel('显示归档会话').check(); await page.getByRole('button', { name: 'Explore sources · 已归档', exact: true }).click();
    await page.goto('about:blank'); await f.restart(); await page.goto(selectedUrl); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); await expect(page.getByText('会话已归档，历史与关联保留。', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/aork-ticket10-session-mobile.png', fullPage: true }); await page.setViewportSize({ width: 1440, height: 940 }); await page.screenshot({ path: '/tmp/aork-ticket10-session.png', fullPage: true }); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('browser corrections reject archived references and retry a lost accepted response with the same command identity', async ({ page }) => {
  const f = await sessionHost(); const environment = await sessionEnvironment(f);
  try {
    await page.goto(f.host.accessUrl!); await page.evaluate(({ projectId, workspaceId }) => { location.hash = new URLSearchParams({ project: projectId, workspace: workspaceId }).toString(); }, environment.input);
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('会话名称').fill('Reliable browser session'); await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await f.command('workspace.archive', { id: environment.workspace.id });
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('archived or unavailable');
    expect(await (await f.query()).json()).toEqual({ sessions: [] });
    const next = (await (await f.command('workspace.create', { projectId: environment.project.id, workspace: { name: 'Next notes', management: 'managed' } })).json()).result;
    await expect(dialog.getByLabel('工作区').getByRole('option', { name: 'Next notes' })).toHaveCount(1, { timeout: 10_000 }); await dialog.getByLabel('工作区').selectOption(next.id);
    const commandIds: string[] = []; let savedReceipt: unknown;
    await page.route('**/api/commands/sessions.create', async route => {
      commandIds.push(route.request().postDataJSON().commandId); const response = await route.fetch();
      if (commandIds.length === 1) { savedReceipt = await response.json(); await route.abort('failed'); } else await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible();
    expect((await (await f.query()).json()).sessions).toHaveLength(1);
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Reliable browser session', exact: true })).toBeVisible();
    expect(commandIds).toHaveLength(2); expect(commandIds[1]).toBe(commandIds[0]);
    const lookup = await page.request.get(`${f.host.url}/api/receipts/${commandIds[0]}`); expect(await lookup.json()).toEqual(savedReceipt);
    const overview = await (await f.query()).json(); expect(overview.sessions).toHaveLength(1);
    await rm(next.directory, { recursive: true }); await expect(page.getByText('目录不可用；历史仍保留，启动前须重新验证工作区。', { exact: true })).toBeVisible();
    await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.set('project', crypto.randomUUID()); location.hash = values.toString(); }); await expect(page.getByRole('heading', { name: '会话与所选环境不匹配' })).toBeVisible(); await page.getByRole('button', { name: '打开会话所属工作区' }).click(); await expect(page.getByRole('heading', { name: 'Reliable browser session', exact: true })).toBeVisible();
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('an independently installed UI replaces all three Session views while preserving the same public Session identity', async ({ page }) => {
  const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
  const f = await sessionHost(true); const environment = await sessionEnvironment(f);
  try {
    expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
    await page.goto(f.host.accessUrl!); await page.evaluate(({ projectId, workspaceId }) => { location.hash = new URLSearchParams({ project: projectId, workspace: workspaceId }).toString(); }, environment.input);
    await page.getByRole('button', { name: '独立新建会话', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '独立创建会话' });
    await dialog.getByLabel('独立会话名称').fill('Independent identity'); await dialog.getByLabel('独立 Profile').selectOption({ label: 'Research Agent' }); await dialog.getByRole('button', { name: '独立保存会话' }).click();
    await expect(page.getByRole('heading', { name: '独立历史视图', exact: true })).toBeVisible();
    const overview = await (await f.query()).json(); expect(overview.sessions).toHaveLength(1); const session = overview.sessions[0].session;
    await expect(page.getByRole('region', { name: '独立会话详情' }).getByText(session.id, { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '独立会话索引' }).getByRole('button', { name: 'Independent identity', exact: true })).toBeVisible();
    const selectedUrl = page.url(); await page.reload(); await expect(page.getByRole('region', { name: '独立会话详情' }).getByText(session.id, { exact: true })).toBeVisible();
    expect((await f.bootstrap).ui.providers['aork.sessions.detail@1']).toBe('independent-session-view:detail');
    await page.goto('about:blank'); await f.restart(); await page.goto(selectedUrl); await expect(page.getByRole('region', { name: '独立会话详情' }).getByText(session.id, { exact: true })).toBeVisible();
    expect((await (await f.query()).json()).sessions[0].session).toEqual(session);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
