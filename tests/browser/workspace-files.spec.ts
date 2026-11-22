import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function launch() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-files-browser-')); const external = join(directory, 'references'); await mkdir(external); await mkdir(join(external, 'sources')); await writeFile(join(external, 'sources', 'notes.md'), 'One\nTwo\n');
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--port', '0', '--insecure-loopback']); const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const accessUrl = await new Promise<string>((resolve, reject) => { let output = ''; child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/"accessUrl":"([^"]+)"/); if (match) resolve(match[1]!); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited: ${code}`))); });
  return { directory, external, accessUrl, async close() { child.kill('SIGTERM'); await done; await rm(directory, { recursive: true, force: true }); } };
}
test('browser file tree, search, upload, download, edit and refresh operate on real external and managed directories', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl); await page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: '新建项目', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('项目名称').fill('Research'); await dialog.getByLabel('工作区名称').fill('References'); await dialog.getByLabel('目录管理').selectOption('external'); await dialog.getByLabel('服务器目录').fill(host.external); await dialog.getByLabel('授权此目录及其子目录').check(); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const files = page.getByRole('region', { name: '工作区文件' }); await files.getByRole('button', { name: 'sources 目录' }).click(); await files.getByRole('button', { name: 'notes.md 8 B' }).click();
    await expect(files.getByText('Two', { exact: true })).toBeVisible(); await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('Edited from browser\n'); await files.getByRole('button', { name: '保存文件' }).click(); await expect(files.getByLabel('文件文本')).toHaveCount(0); await expect(files.getByText('Edited from browser', { exact: true })).toBeVisible(); expect(await readFile(join(host.external, 'sources/notes.md'), 'utf8')).toBe('Edited from browser\n');
    await page.reload(); await expect(files.getByText('Edited from browser', { exact: true })).toBeVisible();
    await files.getByRole('button', { name: '编辑文本', exact: true }).click();
    await files.getByLabel('文件文本').fill('Unsaved changes');
    await files.getByRole('button', { name: '刷新文件', exact: true }).click();
    await expect(files.getByLabel('文件文本')).toHaveValue('Unsaved changes');
    await files.getByRole('button', { name: '取消编辑', exact: true }).click();
    await files.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded actual contents') }); await files.getByRole('button', { name: 'upload.txt 24 B' }).click(); await expect(files.getByText('Uploaded actual contents', { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent('download'); await files.getByRole('button', { name: '下载', exact: true }).click(); const download = await downloadPromise; expect(download.suggestedFilename()).toBe('upload.txt'); expect(await readFile((await download.path())!, 'utf8')).toBe('Uploaded actual contents');
    await files.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('would overwrite') }); await expect(files.getByRole('alert')).toContainText('already exists'); expect(await readFile(join(host.external, 'sources/upload.txt'), 'utf8')).toBe('Uploaded actual contents');
    await files.getByRole('button', { name: '根目录', exact: true }).click(); await files.getByLabel('搜索文件名').fill('notes'); await files.getByRole('button', { name: '搜索', exact: true }).click(); await expect(files.getByRole('button', { name: 'sources/notes.md 20 B' })).toBeVisible();
    await files.getByRole('button', { name: '清除搜索', exact: true }).click();
    await files.getByLabel('新建文本文件名称').fill('1');
    await files.getByRole('button', { name: '新建', exact: true }).click();
    await expect(files.getByRole('button', { name: '1 0 B', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(files.getByRole('button', { name: '1 0 B', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: '添加工作区', exact: true }).click(); await dialog.getByLabel('工作区名称').fill('Managed'); await dialog.getByRole('button', { name: '创建', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Managed', exact: true })).toBeVisible(); await files.getByLabel('新建文本文件名称').fill('draft.md'); await files.getByRole('button', { name: '新建', exact: true }).click(); await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('Managed document'); await files.getByRole('button', { name: '保存文件', exact: true }).click(); await expect(files.getByLabel('文件文本')).toHaveCount(0); await expect(files.getByText('Managed document', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});

test('active HTML is rendered as source and readonly, binary and stale edit failures remain explicit', async ({ page }) => {
  const host = await launch(); await writeFile(join(host.external, 'active.html'), '<script>window.AORK_FILE_EXECUTED=true</script>'); await writeFile(join(host.external, 'binary'), Buffer.from([255, 0])); await symlink(host.directory, join(host.external, 'outside'));
  try {
    await page.goto(host.accessUrl); await page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: '新建项目', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('项目名称').fill('Documents'); await dialog.getByLabel('工作区名称').fill('Files'); await dialog.getByLabel('目录管理').selectOption('external'); await dialog.getByLabel('服务器目录').fill(host.external); await dialog.getByLabel('授权此目录及其子目录').check(); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const files = page.getByRole('region', { name: '工作区文件' }); await files.getByRole('button', { name: 'active.html 47 B' }).click(); await expect(files.getByText('<script>window.AORK_FILE_EXECUTED=true</script>', { exact: true })).toBeVisible(); expect(await page.evaluate(() => 'AORK_FILE_EXECUTED' in window)).toBe(false); await expect(files.getByRole('button', { name: 'outside 链接不可访问' })).toBeDisabled();
    await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('stale edit'); await writeFile(join(host.external, 'active.html'), 'external edit'); await files.getByRole('button', { name: '保存文件' }).click(); await expect(files.getByRole('alert')).toContainText('changed'); expect(await readFile(join(host.external, 'active.html'), 'utf8')).toBe('external edit');
    await files.getByRole('button', { name: 'binary 2 B' }).click(); await expect(files.getByRole('alert')).toContainText('not UTF-8');
    await page.getByRole('button', { name: '编辑工作区', exact: true }).click(); await dialog.getByLabel('访问权限').selectOption('read-only'); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(files.getByLabel('上传文件', { exact: true })).toBeDisabled(); await expect(files.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});
