import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launch() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-workspace-browser-'));
  const external = await mkdtemp(join(directory, 'plain-'));
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--port', '0', '--insecure-loopback']);
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const accessUrl = await new Promise<string>((resolve, reject) => {
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/"accessUrl":"([^"]+)"/); if (match) resolve(match[1]!); });
    child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited: ${code}`)));
  });
  return { directory, external, accessUrl, async close() { child.kill('SIGTERM'); await done; await rm(directory, { recursive: true, force: true }); } };
}

/** Opens the new-workspace dialog with the name (and optionally the directory path) filled in. */
async function openCreateDialog(page: import('@playwright/test').Page, name: string, directory = '') {
  await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作区' });
  await dialog.getByLabel('工作区名称').fill(name);
  if (directory) await dialog.getByLabel('目录', { exact: true }).fill(directory);
  return dialog;
}

test('new workspace dialog registers a typed directory and restores selection after reload', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    let failOverview = false;
    await page.route('**/api/queries/workspace.overview', route => failOverview ? route.fulfill({
      status: 503,
      json: { error: { code: 'WORKSPACE_OVERVIEW_UNAVAILABLE', message: 'Temporary workspace list failure' } },
    }) : route.continue());
    await page.route('**/api/commands/workspace.create', async route => {
      const response = await route.fetch();
      failOverview = response.ok();
      await route.fulfill({ response });
    });
    await page.goto(host.accessUrl);
    await expect(page.getByRole('complementary', { name: '工作区导航' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '工作区导航' }).getByRole('heading', { name: '工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { name: '为下一项工作留个空间' })).toBeVisible();

    // Submitting without a directory stays in the dialog with a correctable error.
    const dialog = await openCreateDialog(page, 'External notes');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请填写工作区目录');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('目录', { exact: true }).fill(host.external);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();

    await expect(dialog).toBeHidden();
    // A failed overview reload after the command still keeps the new selection and surfaces the error.
    await expect(page.getByRole('complementary', { name: '工作区导航' }).getByRole('alert')).toContainText('Temporary workspace list failure');
    await expect(page).toHaveURL(/#workspace=[\da-f-]+$/);
    const selected = page.url();
    failOverview = false;
    await page.reload(); await expect(page.getByRole('heading', { name: 'External notes', exact: true })).toBeVisible();
    expect(page.url()).toBe(selected);
    expect(page.url()).not.toContain('project=');
    // The registered path is kept verbatim next to the resolved physical directory.
    await expect(page.getByText(host.external, { exact: true })).toBeVisible();
    await expect(page.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('all-workspaces cards show directory and status, editing renames only, archiving keeps history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const create = await openCreateDialog(page, 'Notes', host.external);
    await create.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();

    // Fresh load without a selection lands on the all-workspaces page.
    await page.goto(host.accessUrl);
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    const card = page.getByRole('main').getByRole('button', { name: /Notes/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText(await realpath(host.external));
    await expect(card).toContainText('开启');
    await expect(card).toContainText('0 个会话');

    await card.click();
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑工作区', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑工作区' });
    await dialog.getByLabel('工作区名称').fill('Reference');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '归档工作区', exact: true }).click();
    await page.getByRole('dialog', { name: '归档工作区' }).getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    const archivedCard = page.getByRole('main').getByRole('button', { name: /Reference/ });
    await expect(archivedCard).toContainText('已归档');
    await expect(page.getByRole('button', { name: 'Reference · 已归档', exact: true })).toHaveCount(0);
    await page.getByLabel('显示归档', { exact: true }).check();
    await page.getByRole('button', { name: 'Reference · 已归档', exact: true }).click();
    await expect(page.getByText('工作区已归档，目录与记录保留。')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('new-workspace dialog recovers from directory errors in place and archiving keeps the registered workspace history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const missing = join(host.directory, 'missing');
    // A wrong typed path fails in place; the dialog stays open and a corrected path recovers.
    const dialog = await openCreateDialog(page, 'Reference', missing);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose an existing absolute server directory');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('目录', { exact: true }).fill(host.external);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible();
    expect(page.url()).toContain('workspace=');
    expect(page.url()).not.toContain('project=');
    expect(page.url()).not.toContain('artifactProject=');
    const selected = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible();
    expect(page.url()).toBe(selected);

    await page.getByRole('button', { name: '归档工作区', exact: true }).click();
    await page.getByRole('dialog', { name: '归档工作区' }).getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: /Reference/ })).toContainText('已归档');
    await page.getByLabel('显示归档', { exact: true }).check();
    await page.getByRole('button', { name: 'Reference · 已归档', exact: true }).click();
    await expect(page.getByText('工作区已归档，目录与记录保留。')).toBeVisible();
    await expect(page.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('the native picker button fills the directory and name, while cancel and failure keep manual entry', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const external = await realpath(host.external);
    const suggested = external.split('/').filter(Boolean).at(-1)!;
    let outcome: 'chosen' | 'canceled' | 'error' = 'chosen';
    await page.route('**/api/resources/workspace.pickDirectory*', async route => {
      if (outcome === 'chosen') await route.fulfill({ json: { status: 'chosen', directory: external } });
      else if (outcome === 'canceled') await route.fulfill({ json: { status: 'canceled' } });
      else await route.fulfill({ status: 503, json: { error: { code: 'WORKSPACE_PICKER_UNAVAILABLE', message: 'The native directory picker is unavailable on this server; type the directory path instead' } } });
    });
    await page.goto(host.accessUrl);
    const dialog = await openCreateDialog(page, '');
    const directory = dialog.getByLabel('目录', { exact: true });

    // A chosen directory fills the path and suggests the directory's basename as the name.
    await dialog.getByRole('button', { name: '选择…', exact: true }).click();
    await expect(directory).toHaveValue(external);
    await expect(dialog.getByLabel('工作区名称')).toHaveValue(suggested);

    // Canceling the native dialog leaves the current value untouched.
    outcome = 'canceled';
    await dialog.getByRole('button', { name: '选择…', exact: true }).click();
    await expect(directory).toHaveValue(external);

    // An unavailable picker surfaces a hint; typing a path manually still works.
    outcome = 'error';
    await dialog.getByRole('button', { name: '选择…', exact: true }).click();
    await expect(dialog.getByText('type the directory path instead')).toBeVisible();
    await directory.fill(external);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: suggested, exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});
