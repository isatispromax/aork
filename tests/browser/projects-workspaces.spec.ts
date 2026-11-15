import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('real project navigation creates, edits and archives actual Workspaces and restores selection after reload', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await expect(page.getByRole('heading', { name: '项目与工作区', exact: true })).toBeVisible();
    await page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: '新建项目', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('项目名称').fill('Writing'); await dialog.getByLabel('工作区名称').fill('External notes');
    await dialog.getByLabel('目录管理').selectOption('external'); await dialog.getByLabel('服务器目录').fill(host.external);
    await dialog.getByLabel('授权此目录及其子目录').check(); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'External notes', exact: true })).toBeVisible();
    await expect(page.getByText(host.external, { exact: true })).toBeVisible(); const selected = page.url();
    await page.reload(); await expect(page.getByRole('heading', { name: 'External notes', exact: true })).toBeVisible(); expect(page.url()).toBe(selected);
    await page.getByRole('button', { name: '添加工作区', exact: true }).click(); await dialog.getByLabel('工作区名称').fill('Managed drafts'); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Managed drafts', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'External notes', exact: true }).click();
    await page.getByRole('button', { name: '编辑工作区', exact: true }).click(); await dialog.getByLabel('工作区名称').fill('Reference'); await dialog.getByLabel('访问权限').selectOption('read-only'); await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible(); await expect(page.getByText('只读', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '归档工作区', exact: true }).click(); await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reference', exact: true })).toHaveCount(0);
    await page.getByLabel('显示归档').check(); await page.getByRole('button', { name: 'Reference · 已归档', exact: true }).click(); await expect(page.getByText('工作区已归档', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('directory errors are correctable in the browser and Project edits and archive retain the visible registered history', async ({ page }) => {
  const host = await launch();
  try {
    await page.goto(host.accessUrl); await page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: '新建项目', exact: true }).first().click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('项目名称').fill('Research'); await dialog.getByLabel('工作区名称').fill('Notes'); await dialog.getByLabel('目录管理').selectOption('external'); await dialog.getByLabel('服务器目录').fill(join(host.directory, 'missing')); await dialog.getByLabel('授权此目录及其子目录').check();
    await dialog.getByRole('button', { name: '创建', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByLabel('服务器目录').fill(host.external); await dialog.getByRole('button', { name: '创建', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: '编辑项目', exact: true }).click(); await dialog.getByLabel('项目名称').fill('Writing'); await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Writing', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '归档项目', exact: true }).click(); await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Writing', exact: true })).toHaveCount(0); await page.getByLabel('显示归档').check();
    await page.getByRole('button', { name: 'Writing · 已归档', exact: true }).click(); await expect(page.getByText('项目已归档，目录与工作区记录保留。')).toBeVisible();
    await page.getByRole('button', { name: 'Notes', exact: true }).click(); await expect(page.getByText(host.external, { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '添加工作区', exact: true })).toHaveCount(0);
  } finally { await page.goto('about:blank'); await host.close(); }
});
