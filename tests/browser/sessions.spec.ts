import { openPanel } from '../fixtures/right-region.js';
import { openSettings } from '../fixtures/settings.js';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

/** The Workspace browser: one region whose Workspace rows head groups with the Session rows under them. */
const browser = (page: Page) => page.getByRole('region', { name: '工作区', exact: true });
const browserRow = (page: Page, name: string) => browser(page).getByRole('treeitem', { name, exact: true });
const createForm = (page: Page) => page.getByRole('main').getByRole('region', { name: '新建会话', exact: true });

test('Session navigation creates a real conversation, restores its identity and exposes no archive entry', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.goto(f.host.accessUrl!);
    // The Workspace is named after the confirmed folder, so the folder itself carries the name this test expects.
    const notesDirectory = join(f.directory, 'Notes'); await mkdir(notesDirectory, { recursive: true });
    const browser = page.getByRole('region', { name: '工作区', exact: true });
    await browser.getByRole('button', { name: '添加工作区', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await picker.getByLabel('前往文件夹').fill(notesDirectory);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    // The folder names the Workspace, its row joins the browser, and adding opens a new Session in it.
    await expect(browser.getByRole('treeitem', { name: 'Notes', exact: true })).toBeVisible();
    const rail = page.getByRole('complementary', { name: '工作台侧栏', exact: true });
    const newSession = rail.getByRole('button', { name: '新建会话', exact: true });
    const create = page.getByRole('main').getByRole('region', { name: '新建会话', exact: true });
    const inspector = page.getByRole('complementary', { name: '右侧栏', exact: true });
    await expect(create.getByText('尚无 Agent Profile，请先在设置的 Agent 页面保存配置。', { exact: true })).toBeVisible();
    await expect(create.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
    // The Workspace's own region is there beside the new-Session surface, open on its start page.
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole('tablist').getByRole('tab', { name: /开始/ })).toBeVisible();
    await openSettings(page, 'Agent 配置'); await page.getByLabel('配置名称').fill('Research Agent'); await page.getByLabel('版本要求').fill('^1.0.0'); await page.getByLabel('Model', { exact: true }).fill('controlled-model'); await page.getByRole('button', { name: '保存 Agent Profile' }).click();
    await expect(page.getByText('Agent Profile 已保存', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '返回工作台', exact: true }).click();
    await newSession.click();
    await create.getByLabel('会话名称').fill('Explore sources'); await create.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await expect(create.getByText('Controlled Agent', { exact: true })).toBeVisible(); await expect(create.getByText('创建后尚未启动', { exact: true })).toBeVisible();
    await create.getByLabel('会话名称').focus(); await create.getByLabel('会话名称').dispatchEvent('compositionstart'); await create.getByLabel('会话名称').press('Enter'); await expect(create).toBeVisible(); expect((await (await f.query()).json()).sessions).toHaveLength(0); await create.getByLabel('会话名称').dispatchEvent('compositionend');
    await create.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); await expect(page.getByText('尚未启动', { exact: true })).toBeVisible(); await expect(page.getByText('尚无原生历史，不能原生恢复。', { exact: true })).toBeVisible();
    const selectedUrl = page.url(); const sessionId = new URLSearchParams(new URL(selectedUrl).hash.slice(1)).get('session'); expect(sessionId).toBeTruthy();
    const overview = await (await page.request.get(`${f.host.url}/api/queries/sessions.overview`)).json(); expect(overview.sessions[0].session.id).toBe(sessionId);
    await page.getByText('会话与运行详情', { exact: true }).click();
    await expect(page.getByText(overview.sessions[0].session.workspace.directory, { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible(); expect(page.url()).toBe(selectedUrl);
    await page.getByLabel('更多菜单',{exact:true}).click(); await expect(page.getByRole('button', { name: '归档会话', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '交接到新会话…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByLabel('更多菜单', { exact: true })).toBeFocused();
    await page.goto('about:blank'); await f.restart(); await page.goto(selectedUrl); await expect(page.getByRole('heading', { name: 'Explore sources', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const navigationToggle = page.getByRole('button', { name: '切换导航', exact: true });
    const drawer = page.getByRole('dialog', { name: '工作台侧栏', exact: true });
    await navigationToggle.click();
    await drawer.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(create.getByLabel('会话名称')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(create).toBeHidden();
    await expect(navigationToggle).toBeFocused();
    await page.screenshot({ path: '/tmp/aork-ticket10-session-mobile.png', fullPage: true }); await page.setViewportSize({ width: 1440, height: 940 }); await page.screenshot({ path: '/tmp/aork-ticket10-session.png', fullPage: true }); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('the session menu exposes run and handoff controls but no archive entry', async ({ page }) => {
  const f = await sessionHost();
  try {
    const { input } = await sessionEnvironment(f);
    const first = (await (await f.command('sessions.create', input)).json()).result;
    const second = (await (await f.command('sessions.create', { ...input, name: 'Second conversation' })).json()).result;
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ workspaceId, id }) => {
      location.hash = new URLSearchParams({ workspace: workspaceId, session: id }).toString();
    }, second);
    await page.getByRole('region', { name: '工作区', exact: true }).getByRole('treeitem', { name: first.name, exact: true }).click();
    await page.getByLabel('更多菜单', { exact: true }).click();
    await expect(page.getByRole('button', { name: '归档会话', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '交接到新会话…', exact: true })).toBeVisible();
    await expect(page.getByText('显示归档会话', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: '工作区', exact: true }).getByRole('treeitem', { name: second.name, exact: true }).click();
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
    const create = page.getByRole('region', { name: '新建会话', exact: true });
    await page.getByLabel('更多菜单', { exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '待处理请求', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '归档会话', exact: true })).toHaveCount(0);
    await page.getByLabel('更多菜单', { exact: true }).press('Escape');
    await create.getByLabel('会话名称').fill('Late receipt conversation');
    await create.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await create.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.goBack();
    await expect(create).toBeHidden();
    const receipt = page.waitForResponse('**/api/commands/sessions.create');
    releaseReceipt();
    const response = await receipt;
    expect(response.ok()).toBe(true);
    await response.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByRole('region', { name: '工作区', exact: true }).getByRole('treeitem', { name: 'Late receipt conversation', exact: true })).toBeVisible();
  } finally { releaseReceipt(); await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('browser corrections reject a removed registration and retry a lost accepted response with the same command identity', async ({ page }) => {
  const f = await sessionHost(); const environment = await sessionEnvironment(f);
  try {
    await page.goto(f.host.accessUrl!); await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId }).toString(); }, environment.input);
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const create = page.getByRole('region', { name: '新建会话', exact: true });
    await create.getByLabel('会话名称').fill('Reliable browser session'); await create.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await f.command('workspace.delete', { id: environment.workspace.id });
    await create.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(create.getByRole('alert')).toContainText('Workspace is unavailable');
    expect(await (await f.query()).json()).toEqual({ sessions: [] });
    const nextDirectory = join(f.directory, 'next-notes'); await mkdir(nextDirectory, { recursive: true });
    const next = (await (await f.command('workspace.create', { workspace: { name: 'Next notes', directory: nextDirectory } })).json()).result;
    // The searchable picker lists the new Workspace as soon as the overview reaches the form.
    await create.getByRole('button', { name: '选择工作区' }).click();
    const workspaceMenu = page.getByRole('listbox', { name: '选择工作区' });
    await expect(workspaceMenu.getByRole('option', { name: 'Next notes' })).toHaveCount(1, { timeout: 10_000 });
    await workspaceMenu.getByRole('option', { name: 'Next notes' }).click();
    await expect(workspaceMenu).toHaveCount(0); void next.id;
    const commandIds: string[] = []; let savedReceipt: unknown;
    await page.route('**/api/commands/sessions.create', async route => {
      commandIds.push(route.request().postDataJSON().commandId); const response = await route.fetch();
      if (commandIds.length === 1) { savedReceipt = await response.json(); await route.abort('failed'); } else await route.fulfill({ response });
    });
    await create.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(create.getByRole('alert')).toBeVisible();
    expect((await (await f.query()).json()).sessions).toHaveLength(1);
    await create.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Reliable browser session', exact: true })).toBeVisible();
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
    // Without a Session the centre is the new-Session surface: the independent dialog is already up.
    const dialog = page.getByRole('dialog', { name: '独立创建会话' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('独立会话名称').fill('Independent identity'); await dialog.getByLabel('独立 Profile').selectOption({ label: 'Research Agent' }); await dialog.getByRole('button', { name: '独立保存会话' }).click();
    await expect(page.getByRole('heading', { name: '独立历史视图', exact: true })).toBeVisible();
    const overview = await (await f.query()).json(); expect(overview.sessions).toHaveLength(1); const session = overview.sessions[0].session;
    await expect(page.getByRole('region', { name: '独立会话详情' }).getByText(session.id, { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '独立会话索引' }).getByRole('button', { name: 'Independent identity', exact: true })).toBeVisible();
    const selectedUrl = page.url(); await page.reload(); await expect(page.getByRole('region', { name: '独立会话详情' }).getByText(session.id, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '独立新建会话', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('region', { name: '独立会话详情' })).toBeVisible();
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
  // A file is read in the Preview panel, which the Files tree opens it in; the address still names it.
  const preview = page.getByRole('region', { name: '文档预览', exact: true });
  // A row is named by its file alone, so a file's row is found by its path.
  const current = (path: string) => files.locator(`button[data-file-path="${path}"]`);
  async function create(name: string, workspaceName?: string) {
    await page.getByRole('button', { name: '新建会话', exact: true }).click(); const form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称').fill(name); await form.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    if (workspaceName) {
      await form.getByRole('button', { name: '选择工作区' }).click();
      await page.getByRole('listbox', { name: '选择工作区' }).getByRole('option', { name: workspaceName }).click();
    }
    await form.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  function selection() { return new URLSearchParams(new URL(page.url()).hash.slice(1)); }
  function expectClearedFiles() { const values = selection(); expect(values.get('workspace')).toBe(second.id); for (const key of ['directory', 'file', 'line']) expect(values.has(key)).toBe(false); expect(values.get('research.view')).toBe('keep-me'); }
  try {
    await page.goto(f.host.accessUrl); await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId, directory: 'sources', file: 'sources/shared.md', line: '2', 'research.view': 'keep-me' }).toString(); }, environment.input);
    await expect(files.getByText('AAA_WORKSPACE_SELECTED', { exact: true })).toHaveCount(0);
    // The address names a file. The right region belongs to a Session, so the first Session created here
    // keeps that link, and its tree opens the directories to it and marks its row.
    await create('First workspace session');
    await expect(current('sources/shared.md')).toHaveAttribute('aria-current', 'page');
    await create('Second workspace session', 'Second notes'); expectClearedFiles();
    // The new Session's right region is its own and opens on the start page; the link no longer names a file to open.
    await openPanel(page, '文件');
    await expect(files.getByText('BBB_WORKSPACE_SELECTED', { exact: true })).toHaveCount(0); await expect(files.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    await current('sources').click(); await current('sources/shared.md').click();
    await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.set('line', '2'); location.hash = values.toString(); });
    await expect(preview).toHaveAttribute('data-preview-path', 'sources/shared.md');
    await create('Same workspace session'); const same = selection(); expect(same.get('directory')).toBe('sources'); expect(same.get('file')).toBe('sources/shared.md'); expect(same.get('line')).toBe('2'); expect(same.get('research.view')).toBe('keep-me');
    // The new Session's region opens the Files tab on the file the address still names.
    await expect(current('sources/shared.md')).toHaveAttribute('aria-current', 'page'); const sessionId = same.get('session');
    // A Workspace chosen on its own keeps the Files selection that belongs to it.
    await page.evaluate(workspaceId => { const values = new URLSearchParams(location.hash.slice(1)); values.set('workspace', workspaceId); values.delete('session'); values.set('createSession', '1'); location.hash = values.toString(); }, second.id);
    await expect(createForm(page)).toBeVisible(); const sameWorkspace = selection(); expect(sameWorkspace.get('file')).toBe('sources/shared.md'); expect(sameWorkspace.get('directory')).toBe('sources'); expect(sameWorkspace.get('line')).toBe('2'); expect(sameWorkspace.get('research.view')).toBe('keep-me');
    await browserRow(page, 'Same workspace session').click(); await expect(page.getByRole('heading', { name: 'Same workspace session', exact: true })).toBeVisible();
    await page.evaluate(workspaceId => { const values = new URLSearchParams(location.hash.slice(1)); values.set('workspace', workspaceId); location.hash = values.toString(); }, environment.workspace.id);
    await expect(page.getByRole('heading', { name: '会话与所选环境不匹配', exact: true })).toBeVisible(); await page.getByRole('button', { name: '打开会话所属工作区', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Same workspace session', exact: true })).toBeVisible(); expectClearedFiles(); expect(selection().get('session')).toBe(sessionId); await expect(files.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    // Another Workspace drops the Files selection with the Session that named it.
    await page.evaluate(workspaceId => { const values = new URLSearchParams(location.hash.slice(1)); values.set('workspace', workspaceId); values.set('createSession', '1'); for (const key of ['session', 'directory', 'file', 'line']) values.delete(key); location.hash = values.toString(); }, environment.workspace.id);
    await expect(createForm(page)).toBeVisible(); const firstWorkspace = selection(); expect(firstWorkspace.get('workspace')).toBe(environment.workspace.id); expect(firstWorkspace.get('research.view')).toBe('keep-me'); for (const key of ['session', 'directory', 'file', 'line']) expect(firstWorkspace.has(key)).toBe(false);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('deleting a Workspace registration leaves its Session in the 未分组 group with history intact', async ({ page }) => {
  const f = await sessionHost();
  try {
    const { input } = await sessionEnvironment(f);
    await f.command('sessions.create', input);
    await page.goto(f.host.accessUrl);
    // The Workspace row heads its group, with the Session under it.
    const row = browserRow(page, 'Notes');
    await expect(row).toBeVisible();
    await expect(browserRow(page, 'Research conversation')).toBeVisible();
    await expect(browser(page).getByText('未分组', { exact: true })).toHaveCount(0);

    await row.hover();
    await browser(page).getByRole('button', { name: '工作区“Notes”的操作' }).click();
    const menu = page.getByRole('menu', { name: '工作区操作' });
    await menu.getByRole('menuitem', { name: '删除工作区…' }).click();
    const dialog = page.getByRole('dialog', { name: '删除工作区' });
    // The confirmation names the Workspace and states the retention boundary; its button is the destructive one.
    await expect(dialog).toContainText('将把“Notes”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。');
    await dialog.getByRole('button', { name: '删除工作区', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);

    // The Session trails in the 未分组 group: visible and openable, with no way to start a Session there.
    const ungrouped = browser(page).locator('[data-workspace-group="ungrouped"]');
    await expect(ungrouped.getByRole('treeitem', { name: '未分组', exact: true })).toBeVisible();
    await expect(ungrouped.getByRole('treeitem', { name: 'Research conversation', exact: true })).toBeVisible();
    await expect(ungrouped.getByRole('button', { name: /新建会话/ })).toHaveCount(0);
    const overview = await (await f.query()).json();
    expect(overview.sessions).toHaveLength(1);
    expect(overview.sessions[0].session.workspace.name).toBe('Notes');
    expect(overview.sessions[0].session.status).toBe('open');
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('the row ··· menu pins and copies the session id, and the watermark expands stepwise', async ({ page }) => {
  const f = await sessionHost();
  try {
    const { workspace, profile } = await sessionEnvironment(f);
    for (let index = 0; index < 12; index++) await f.command('sessions.create', { name: `Conversation ${String(index + 1).padStart(2, '0')}`, workspaceId: workspace.id, profileId: profile.id });
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ workspaceId }) => { location.hash = new URLSearchParams({ workspace: workspaceId, createSession: '1' }).toString(); }, { workspaceId: workspace.id });
    const rows = browser(page);
    const rowOf = (name: string) => rows.locator(`[data-session-row]`, { hasText: name }).first();

    // Watermark: five rows at first; +5 per press, and the last press reveals the remainder.
    await expect(rows.locator('[data-session-row]')).toHaveCount(5);
    await rows.getByRole('button', { name: '展开其余 7 个会话', exact: true }).click();
    await expect(rows.locator('[data-session-row]')).toHaveCount(10);
    await rows.getByRole('button', { name: '展开其余 2 个会话', exact: true }).click();
    await expect(rows.locator('[data-session-row]')).toHaveCount(12);
    await rows.getByRole('button', { name: '收起', exact: true }).click();
    await expect(rows.locator('[data-session-row]')).toHaveCount(5);

    // The row actions collapsed into one ··· menu: pin, rename, copy id, handoff.
    // Rows run newest first, so the visible top row is Conversation 12.
    const first = rowOf('Conversation 12');
    await first.hover();
    await first.getByRole('button', { name: '会话“Conversation 12”的操作' }).click();
    const menu = page.getByRole('menu', { name: '会话操作' });
    await expect(menu.getByRole('menuitem', { name: '置顶' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '重命名…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '复制会话 ID' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '交接到新会话…' })).toBeVisible();
    await menu.getByRole('menuitem', { name: '置顶' }).click();
    await expect(rowOf('Conversation 12').getByRole('img', { name: '已置顶' })).toBeVisible();
    expect((await (await f.query()).json()).sessions.find((entry: { session: { name: string; pinned?: boolean } }) => entry.session.name === 'Conversation 12').session.pinned).toBe(true);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('the create form picks a Workspace through a searchable menu', async ({ page }) => {
  const f = await sessionHost();
  try {
    const { workspace } = await sessionEnvironment(f);
    const other = join(f.directory, 'Other');
    await mkdir(other, { recursive: true });
    await f.command('workspace.create', { workspace: { name: 'Other', directory: other } });
    await page.goto(f.host.accessUrl);
    const rail = page.getByRole('complementary', { name: '工作台侧栏', exact: true });
    await rail.getByRole('button', { name: '新建会话', exact: true }).click();
    const create = page.getByRole('main').getByRole('region', { name: '新建会话', exact: true });
    await create.getByLabel('会话名称').fill('Picked');
    const trigger = create.getByRole('button', { name: '选择工作区' });
    await trigger.click();
    // Two Workspaces open: the card carries a search field above both rows and 添加工作区… pinned below them.
    const listbox = page.getByRole('listbox', { name: '选择工作区' });
    const search = page.getByRole('textbox', { name: '搜索工作区' });
    await expect(search).toBeVisible();
    await expect(listbox.getByRole('option', { name: /Notes/ })).toBeVisible();
    await expect(listbox.getByRole('option', { name: /Other/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加工作区…', exact: true })).toBeVisible();
    await search.fill('oth');
    await expect(listbox.getByRole('option', { name: /Notes/ })).toHaveCount(0);
    // Enter picks the first result; the field shows the choice and the path below the form.
    await page.keyboard.press('Enter');
    await expect(listbox).toHaveCount(0);
    await expect(trigger).toContainText('Other');
    await expect(create.getByText(await realpath(other), { exact: true })).toBeVisible();
    await create.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await create.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Picked', exact: true })).toBeVisible();
    expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('workspace')).toBeTruthy();
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
