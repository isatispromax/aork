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

test('new workspace dialog registers a real directory through the directory picker and restores selection after reload', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await expect(page.getByRole('complementary', { name: '工作区导航' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '工作区导航' }).getByRole('heading', { name: '工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { name: '为下一项工作留个空间' })).toBeVisible();

    await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建工作区' });
    await dialog.getByLabel('工作区名称').fill('External notes');
    await dialog.getByLabel('授权此目录及其子目录').check();
    // Submitting without a directory stays in the dialog with a correctable error.
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请先通过目录选择器选择工作区目录');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: '选择目录…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await expect(picker).toBeVisible();
    await picker.getByLabel('前往文件夹').fill(host.external);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(host.external, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '创建', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'External notes', exact: true })).toBeVisible();
    expect(page.url()).toContain('workspace=');
    expect(page.url()).not.toContain('project=');
    const selected = page.url();
    // The registered path is kept verbatim next to the resolved physical directory.
    await expect(page.getByText(host.external, { exact: true })).toBeVisible();
    await expect(page.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'External notes', exact: true })).toBeVisible();
    expect(page.url()).toBe(selected);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('all-workspaces cards show directory and status, editing renames only, archiving keeps history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建工作区' });
    await create.getByLabel('工作区名称').fill('Notes');
    await create.getByRole('button', { name: '选择目录…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await picker.getByLabel('前往文件夹').fill(host.external);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await create.getByLabel('授权此目录及其子目录').check();
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
    await expect(dialog.getByLabel('访问权限')).toHaveCount(0); // Editing only renames; access stays as registered.
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
