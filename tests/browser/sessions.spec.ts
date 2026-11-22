import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

test('Session navigation creates a real conversation, restores its identity and archives retained history', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.host.accessUrl!);
    const notesDirectory = join(f.directory, 'notes'); await mkdir(notesDirectory, { recursive: true });
    await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: '新建工作区' });
    await createDialog.getByLabel('工作区名称').fill('Notes');
    await createDialog.getByRole('button', { name: '选择目录…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await picker.getByLabel('前往文件夹').fill(notesDirectory);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await createDialog.getByRole('button', { name: '创建', exact: true }).click();
    let dialog = page.getByRole('dialog');
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
    await page.getByText('会话与运行详情', { exact: true }).click();
    await expect(page.getByText(overview.sessions[0].session.workspace.directory, { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); expect(page.url()).toBe(selectedUrl);
    await page.getByLabel('更多菜单',{exact:true}).click();await page.getByRole('button', { name: '归档会话', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '确认归档', exact: true }).click(); await expect(page.getByText('会话已归档，历史与关联保留。', { exact: true })).toBeVisible();
    await page.getByLabel('显示归档会话').check(); await page.getByRole('button', { name: 'Explore sources · 已归档', exact: true }).click();
    await page.goto('about:blank'); await f.restart(); await page.goto(selectedUrl); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); await expect(page.getByText('会话已归档，历史与关联保留。', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/aork-ticket10-session-mobile.png', fullPage: true }); await page.setViewportSize({ width: 1440, height: 940 }); await page.screenshot({ path: '/tmp/aork-ticket10-session.png', fullPage: true }); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('navigating to another session closes the previous session archive confirmation', async ({ page }) => {
  const f = await sessionHost();
  try {
    const { input } = await sessionEnvironment(f);
    const first = (await (await f.command('sessions.create', input)).json()).result;
    const second = (await (await f.command('sessions.create', { ...input, name: 'Second conversation' })).json()).result;
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ workspaceId, id }) => {
      location.hash = new URLSearchParams({ workspace: workspaceId, session: id }).toString();
    }, second);
    await page.getByRole('region', { name: '会话导航', exact: true }).getByRole('button', { name: first.name, exact: true }).click();
    await page.getByLabel('更多菜单', { exact: true }).click();
    await page.getByRole('button', { name: '归档会话', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '归档会话', exact: true });
    await expect(confirmation).toBeVisible();
    await page.goBack();
    await expect(confirmation).toBeHidden();
    await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
    expect((await (await f.query()).json()).sessions.map((entry: { session: { status: string } }) => entry.session.status)).toEqual(['open', 'open']);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('a late create receipt preserves browser Back navigation', async ({ page }) => {
  const f = await sessionHost();
  let releaseReceipt = () => {};
  const heldReceipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
  try {
    const { input } = await sessionEnvironment(f);
    const original = (await (await f.command('sessions.create', input)).json()).result;
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ workspaceId, id }) => {
      location.hash = new URLSearchParams({ workspace: workspaceId, session: id }).toString();
    }, original);
    await expect(page.getByRole('heading', { name: original.name, exact: true })).toBeVisible();
    const originalUrl = page.url();
    await page.route('**/api/commands/sessions.create', async route => {
      const response = await route.fetch();
      await heldReceipt;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true });
    await dialog.getByLabel('会话名称').fill('Late receipt conversation');
    await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.goBack();
    await expect(dialog).toBeHidden();
    const receipt = page.waitForResponse('**/api/commands/sessions.create');
    releaseReceipt();
    const response = await receipt;
    expect(response.ok()).toBe(true);
    await response.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByRole('region', { name: '会话导航', exact: true }).getByRole('button', { name: 'Late receipt conversation', exact: true })).toBeVisible();
  } finally { releaseReceipt(); await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('browser corrections reject archived references and retry a lost accepted response with the same command identity', async ({ page }) => {
  const f = await sessionHost(); const environment = await sessionEnvironment(f);
  try {
    await page.goto(f.host.accessUrl!); await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId }).toString(); }, environment.input);
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('会话名称').fill('Reliable browser session'); await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await f.command('workspace.archive', { id: environment.workspace.id });
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('archived or unavailable');
    expect(await (await f.query()).json()).toEqual({ sessions: [] });
    const nextDirectory = join(f.directory, 'next-notes'); await mkdir(nextDirectory, { recursive: true });
    const next = (await (await f.command('workspace.create', { workspace: { name: 'Next notes', directory: nextDirectory } })).json()).result;
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
    await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.set('workspace', crypto.randomUUID()); location.hash = values.toString(); }); await expect(page.getByRole('heading', { name: '会话与所选环境不匹配' })).toBeVisible(); await page.getByRole('button', { name: '打开会话所属工作区' }).click(); await expect(page.getByRole('heading', { name: 'Reliable browser session', exact: true })).toBeVisible();
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('an independently installed UI replaces all three Session views while preserving the same public Session identity', async ({ page }) => {
  const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
  const f = await sessionHost(true); const environment = await sessionEnvironment(f);
  try {
    expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
    await page.goto(f.host.accessUrl!); await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId }).toString(); }, environment.input);
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

test('Session Workspace changes clear old Files selection while same-Workspace creation retains Files and unrelated plugin state', async ({ page }) => {
  const f = await sessionHost(); const environment = await sessionEnvironment(f);
  const secondDirectory = join(f.directory, 'second-notes'); await mkdir(secondDirectory, { recursive: true });
  const secondResponse = await f.command('workspace.create', { workspace: { name: 'Second notes', directory: secondDirectory } }); expect(secondResponse.status).toBe(200); const second = (await secondResponse.json()).result;
  for (const [workspace, text] of [[environment.workspace, 'AAA_WORKSPACE_SELECTED'], [second, 'BBB_WORKSPACE_SELECTED']] as const) {
    await mkdir(join(workspace.directory, 'sources')); await writeFile(join(workspace.directory, 'sources/shared.md'), `First line\n${text}\n`);
  }
  const files = page.getByRole('region', { name: '工作区文件', exact: true });
  async function create(name: string, workspaceId?: string) {
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('会话名称').fill(name); await dialog.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    if (workspaceId) await dialog.getByLabel('工作区').selectOption(workspaceId);
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  function selection() { return new URLSearchParams(new URL(page.url()).hash.slice(1)); }
  function expectClearedFiles() { const values = selection(); expect(values.get('workspace')).toBe(second.id); for (const key of ['directory', 'file', 'line']) expect(values.has(key)).toBe(false); expect(values.get('research.view')).toBe('keep-me'); }
  try {
    await page.goto(f.host.accessUrl); await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId, directory: 'sources', file: 'sources/shared.md', line: '2', 'research.view': 'keep-me' }).toString(); }, environment.input);
    await expect(files.getByText('AAA_WORKSPACE_SELECTED', { exact: true })).toBeVisible();
    await create('Second workspace session', second.id); expectClearedFiles();
    await expect(files.getByText('BBB_WORKSPACE_SELECTED', { exact: true })).toHaveCount(0); await expect(files.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    await files.getByRole('button', { name: /sources/ }).click(); await files.getByRole('button', { name: /shared\.md/ }).click();
    await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.set('line', '2'); location.hash = values.toString(); });
    await expect(files.getByText('BBB_WORKSPACE_SELECTED', { exact: true })).toBeVisible();
    await create('Same workspace session'); const same = selection(); expect(same.get('directory')).toBe('sources'); expect(same.get('file')).toBe('sources/shared.md'); expect(same.get('line')).toBe('2'); expect(same.get('research.view')).toBe('keep-me');
    await expect(files.getByText('BBB_WORKSPACE_SELECTED', { exact: true })).toBeVisible(); const sessionId = same.get('session');
    await page.getByRole('button', { name: 'Second notes', exact: true }).click(); const sameWorkspace = selection(); expect(sameWorkspace.get('file')).toBe('sources/shared.md'); expect(sameWorkspace.get('directory')).toBe('sources'); expect(sameWorkspace.get('line')).toBe('2'); expect(sameWorkspace.get('research.view')).toBe('keep-me');
    await page.getByRole('button', { name: 'Same workspace session', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Same workspace session', exact: true })).toBeVisible();
    await page.evaluate(workspaceId => { const values = new URLSearchParams(location.hash.slice(1)); values.set('workspace', workspaceId); location.hash = values.toString(); }, environment.workspace.id);
    await expect(page.getByRole('heading', { name: '会话与所选环境不匹配', exact: true })).toBeVisible(); await page.getByRole('button', { name: '打开会话所属工作区', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Same workspace session', exact: true })).toBeVisible(); expectClearedFiles(); expect(selection().get('session')).toBe(sessionId); await expect(files.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Notes', exact: true }).click(); const firstWorkspace = selection(); expect(firstWorkspace.get('workspace')).toBe(environment.workspace.id); expect(firstWorkspace.get('research.view')).toBe('keep-me'); for (const key of ['session', 'directory', 'file', 'line']) expect(firstWorkspace.has(key)).toBe(false);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
