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

/** Registers a workspace through the real new-workspace dialog and its directory picker. */
async function createWorkspaceViaDialog(page: import('@playwright/test').Page, name: string, directory: string, access: 'read-write' | 'read-only' = 'read-write') {
  await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作区' });
  await dialog.getByLabel('工作区名称').fill(name);
  await dialog.getByLabel('访问权限').selectOption(access);
  await dialog.getByRole('button', { name: '选择目录…', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '目录选择器' });
  await picker.getByLabel('前往文件夹').fill(directory);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await picker.getByRole('button', { name: '选择', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await dialog.getByLabel('授权此目录及其子目录').check();
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
test('browser file tree, search, upload, download, edit and refresh operate on real external and managed directories', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl); await createWorkspaceViaDialog(page, 'References', host.external);
    const files = page.getByRole('region', { name: '工作区文件' }); await files.getByRole('button', { name: 'sources 目录' }).click(); await files.getByRole('button', { name: 'notes.md 8 B' }).click();
    await expect(files.getByText('Two', { exact: true })).toBeVisible(); await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('Edited from browser\n'); await files.getByRole('button', { name: '保存文件' }).click(); await expect(files.getByLabel('文件文本')).toHaveCount(0); await expect(files.getByText('Edited from browser', { exact: true })).toBeVisible(); expect(await readFile(join(host.external, 'sources/notes.md'), 'utf8')).toBe('Edited from browser\n');
    await page.reload(); await expect(files.getByText('Edited from browser', { exact: true })).toBeVisible();
    await files.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded actual contents') }); await files.getByRole('button', { name: 'upload.txt 24 B' }).click(); await expect(files.getByText('Uploaded actual contents', { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent('download'); await files.getByRole('button', { name: '下载', exact: true }).click(); const download = await downloadPromise; expect(download.suggestedFilename()).toBe('upload.txt'); expect(await readFile((await download.path())!, 'utf8')).toBe('Uploaded actual contents');
    await files.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('would overwrite') }); await expect(files.getByRole('alert')).toContainText('already exists'); expect(await readFile(join(host.external, 'sources/upload.txt'), 'utf8')).toBe('Uploaded actual contents');
    await files.getByRole('button', { name: '根目录', exact: true }).click(); await files.getByLabel('搜索文件名').fill('notes'); await files.getByRole('button', { name: '搜索', exact: true }).click(); await expect(files.getByRole('button', { name: 'sources/notes.md 20 B' })).toBeVisible();
    const managedDirectory = join(host.directory, 'managed-docs'); await mkdir(managedDirectory, { recursive: true });
    await createWorkspaceViaDialog(page, 'Managed', managedDirectory);
    await files.getByLabel('新建文本文件名称').fill('draft.md'); await files.getByRole('button', { name: '新建', exact: true }).click(); await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('Managed document'); await files.getByRole('button', { name: '保存文件', exact: true }).click(); await expect(files.getByLabel('文件文本')).toHaveCount(0); await expect(files.getByText('Managed document', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});

test('active HTML is rendered as source and readonly, binary and stale edit failures remain explicit', async ({ page }) => {
  const host = await launch(); await writeFile(join(host.external, 'active.html'), '<script>window.AORK_FILE_EXECUTED=true</script>'); await writeFile(join(host.external, 'binary'), Buffer.from([255, 0])); await symlink(host.directory, join(host.external, 'outside'));
  try {
    await page.goto(host.accessUrl); await createWorkspaceViaDialog(page, 'Files', host.external);
    const files = page.getByRole('region', { name: '工作区文件' }); await files.getByRole('button', { name: 'active.html 47 B' }).click(); await expect(files.getByText('<script>window.AORK_FILE_EXECUTED=true</script>', { exact: true })).toBeVisible(); expect(await page.evaluate(() => 'AORK_FILE_EXECUTED' in window)).toBe(false); await expect(files.getByRole('button', { name: 'outside 链接不可访问' })).toBeDisabled();
    await files.getByRole('button', { name: '编辑文本', exact: true }).click(); await files.getByLabel('文件文本').fill('stale edit'); await writeFile(join(host.external, 'active.html'), 'external edit'); await files.getByRole('button', { name: '保存文件' }).click(); await expect(files.getByRole('alert')).toContainText('changed'); expect(await readFile(join(host.external, 'active.html'), 'utf8')).toBe('external edit');
    await files.getByRole('button', { name: 'binary 2 B' }).click(); await expect(files.getByRole('alert')).toContainText('not UTF-8');
    const lockedDirectory = join(host.directory, 'locked-archive'); await mkdir(lockedDirectory, { recursive: true });
    await createWorkspaceViaDialog(page, 'Locked', lockedDirectory, 'read-only'); const lockedFiles = page.getByRole('region', { name: '工作区文件' });
    await expect(lockedFiles.getByLabel('上传文件', { exact: true })).toBeDisabled(); await expect(lockedFiles.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});
