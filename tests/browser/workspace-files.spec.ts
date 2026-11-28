import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openPanel } from '../fixtures/right-region.js';
async function launch() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-files-browser-')); const external = join(directory, 'references'); await mkdir(external); await mkdir(join(external, 'sources')); await writeFile(join(external, 'sources', 'notes.md'), 'One\nTwo\n');
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--port', '0', '--insecure-loopback']); const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const accessUrl = await new Promise<string>((resolve, reject) => { let output = ''; child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/"accessUrl":"([^"]+)"/); if (match) resolve(match[1]!); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited: ${code}`))); });
  return { directory, external, accessUrl, async close() { child.kill('SIGTERM'); await done; await rm(directory, { recursive: true, force: true }); } };
}

/** Registers a workspace through the directory picker that 添加工作区 opens; the Workspace takes the folder's name. */
async function createWorkspaceViaPicker(page: Page, directory: string) {
  await page.getByRole('region', { name: '工作区', exact: true }).getByRole('button', { name: '添加工作区', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '目录选择器' });
  await picker.getByLabel('前往文件夹').fill(directory);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await picker.getByRole('button', { name: '选择', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('region', { name: '工作区', exact: true }).getByRole('treeitem', { name: basename(directory), exact: true })).toBeVisible();
}

/** The row of a Workspace file or directory, by its path from the root. */
const row = (files: Locator, path: string): Locator => files.locator(`button[data-file-path="${path}"]`);
/** A row's menu is at the row's end, where a pointer or a touch reaches it; this chooses from it. */
async function choose(page: Page, files: Locator, path: string, item: string): Promise<void> {
  await files.getByRole('button', { name: `更多操作：${basename(path)}`, exact: true }).click();
  await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: item, exact: true }).click();
}
/** Offers a file to the control a menu item opened, and waits for the menu to be gone. */
async function offer(page: Page, click: () => Promise<void>, file: { name: string; contents: string }): Promise<void> {
  const choosing = page.waitForEvent('filechooser');
  await click();
  await (await choosing).setFiles({ name: file.name, mimeType: 'text/plain', buffer: Buffer.from(file.contents) });
}

test('the Files tree lists lazily, opens files in the Preview, searches as typed, and uploads, downloads, edits and re-reads real directories', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    await page.goto(host.accessUrl); await createWorkspaceViaPicker(page, host.external); await openPanel(page, '文件');
    const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
    const files = right.getByRole('region', { name: '工作区文件', exact: true });
    const preview = right.getByRole('region', { name: '文档预览', exact: true });
    // A chip's name carries its close control's: 「文件 关闭：文件」.
    const back = async () => { await openPanel(page, '文件'); await right.getByRole('tab', { name: /^文件/ }).click(); };
    const notes = 'sources/notes.md';

    // The header names the Workspace's root. A directory is listed when it is first opened, and not before.
    await expect(files.locator('[data-overflowed]')).toHaveAttribute('title', await realpath(host.external));
    await expect(row(files, 'sources')).toBeVisible();
    await expect(row(files, notes)).toHaveCount(0);
    await row(files, 'sources').click();
    await expect(row(files, 'sources')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(files, notes)).toBeVisible();

    // A file is opened where it is read: the Preview panel, in a tab of its own, and its row stays the current one.
    await row(files, notes).click();
    await expect(preview).toHaveAttribute('data-preview-path', notes);
    // Back in the Files tab the tree is as it was left: switching tabs lists nothing anew.
    await back();
    await expect(row(files, notes)).toHaveAttribute('aria-current', 'page');
    await expect(row(files, 'sources')).toHaveAttribute('aria-expanded', 'true');

    // 编辑 on a row opens the editor with the edit begun; the draft is written over what was read.
    await choose(page, files, notes, '编辑');
    await expect(files.getByLabel('文件文本')).toHaveValue('One\nTwo\n');
    await files.getByLabel('文件文本').fill('Edited from browser\n');
    await files.getByRole('button', { name: '保存文件', exact: true }).click();
    await expect(files.getByLabel('文件文本')).toHaveCount(0);
    await expect(files.locator(`[data-file-source="${notes}"]`)).toContainText('Edited from browser');
    expect(await readFile(join(host.external, 'sources/notes.md'), 'utf8')).toBe('Edited from browser\n');

    // The address names the file across a reload: the tree opens its directories to it and marks its row.
    await page.reload(); await back();
    await expect(row(files, notes)).toHaveAttribute('aria-current', 'page');

    // Reading everything again leaves what is being typed alone.
    await choose(page, files, notes, '编辑');
    await files.getByLabel('文件文本').fill('Unsaved changes');
    await files.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(files.getByLabel('文件文本')).toHaveValue('Unsaved changes');
    await files.getByRole('button', { name: '取消编辑', exact: true }).click();
    await expect(files.getByLabel('文件文本')).toHaveCount(0);

    // A directory's menu takes an upload into that directory; an upload never overwrites.
    await files.getByRole('button', { name: '更多操作：sources', exact: true }).click();
    await offer(page, () => page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '上传文件到这里', exact: true }).click(), { name: 'upload.txt', contents: 'Uploaded actual contents' });
    await expect(files.getByText('文件已上传', { exact: true })).toBeVisible();
    await expect(row(files, 'sources/upload.txt')).toBeVisible();
    await offer(page, () => choose(page, files, 'sources', '上传文件到这里'), { name: 'upload.txt', contents: 'would overwrite' });
    await expect(files.getByRole('alert')).toContainText('already exists');
    expect(await readFile(join(host.external, 'sources/upload.txt'), 'utf8')).toBe('Uploaded actual contents');
    // The file is handed over as it is.
    const downloading = page.waitForEvent('download');
    await choose(page, files, 'sources/upload.txt', '下载');
    const download = await downloading; expect(download.suggestedFilename()).toBe('upload.txt'); expect(await readFile((await download.path())!, 'utf8')).toBe('Uploaded actual contents');
    // A secondary press opens the same menu without acting on the row, and Escape hands focus back to the row.
    await row(files, 'sources/upload.txt').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '文件操作' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(row(files, 'sources/upload.txt')).toBeFocused();
    // 复制路径 copies the file's path on the server.
    await choose(page, files, 'sources/upload.txt', '复制路径');
    await expect(files.getByText('已复制路径', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(await realpath(host.external), 'sources/upload.txt'));

    // A search is sent as text is typed, and walks the whole Workspace — directories the tree never opened.
    await mkdir(join(host.external, 'elsewhere')); await writeFile(join(host.external, 'elsewhere', 'notes-deep.md'), 'Deep');
    await mkdir(join(host.external, '.config')); await writeFile(join(host.external, '.config', 'notes.md'), 'Hidden');
    await files.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(row(files, 'elsewhere')).toBeVisible();
    await expect(row(files, '.config')).toHaveCount(0);
    // A word is searched once, at its end — here too, after a file was saved, which re-reads what lists it.
    const searches: string[] = []; const counted = (request: Request) => { if (request.url().includes('/api/resources/workspace.search')) searches.push(request.url()); };
    page.on('request', counted);
    await files.getByRole('searchbox', { name: '搜索文件' }).fill('notes');
    await expect(files.getByText('2 个结果', { exact: true })).toBeVisible();
    // Past the search box's own delay, by which a second request would have been sent.
    await page.waitForTimeout(400);
    expect(searches).toHaveLength(1);
    page.off('request', counted);
    await expect(row(files, 'elsewhere/notes-deep.md')).toBeVisible();
    await expect(row(files, notes).locator('mark')).toHaveText('notes');
    // Every level of the result tree is open, and a directory with matches under it says so.
    await expect(row(files, 'sources')).toHaveAttribute('aria-expanded', 'true');
    // Dot entries are searched, and drawn, only while the reader asks for them.
    await expect(row(files, '.config/notes.md')).toHaveCount(0);
    await files.getByRole('button', { name: '显示隐藏项', exact: true }).click();
    await expect(files.getByText('3 个结果', { exact: true })).toBeVisible();
    await expect(row(files, '.config/notes.md')).toBeVisible();
    // The keyboard walks the rows: down from the search box into the first, on between them, and up from the first back to the box.
    const box = files.getByRole('searchbox', { name: '搜索文件' });
    await box.focus(); await box.press('ArrowDown');
    await expect(row(files, '.config')).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(row(files, '.config/notes.md')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(row(files, '.config')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(box).toBeFocused();
    await files.getByRole('button', { name: '清空搜索', exact: true }).click();
    await expect(files.getByText('3 个结果', { exact: true })).toHaveCount(0);
    await expect(row(files, '.config')).toBeVisible();

    // A new file is listed and marked current, and opens ready to be written. The header keeps two
    // controls; its 更多操作 menu is where 新建文件 lives, as it is in a directory row's menu.
    await files.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '新建文件', exact: true }).click();
    await files.getByLabel('新建文本文件名称').fill('1');
    await files.getByRole('button', { name: '新建', exact: true }).click();
    await expect(row(files, '1')).toHaveAttribute('aria-current', 'page');
    await expect(files.getByLabel('文件文本')).toHaveValue('');
    expect(await readFile(join(host.external, '1'), 'utf8')).toBe('');
    // The choice to see hidden entries is the Workspace's, kept across a reload; the search text is not.
    await page.reload(); await back();
    await expect(row(files, '1')).toHaveAttribute('aria-current', 'page');
    await expect(files.getByRole('searchbox', { name: '搜索文件' })).toHaveValue('');
    await expect(files.getByRole('button', { name: '显示隐藏项', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Another Workspace is another tree.
    const managedDirectory = join(host.directory, 'managed-docs'); await mkdir(managedDirectory, { recursive: true });
    await createWorkspaceViaPicker(page, managedDirectory);
    await expect(row(files, '1')).toHaveCount(0);
    await files.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '新建文件', exact: true }).click();
    await files.getByLabel('新建文本文件名称').fill('draft.md'); await files.getByRole('button', { name: '新建', exact: true }).click();
    await files.getByLabel('文件文本').fill('Managed document'); await files.getByRole('button', { name: '保存文件', exact: true }).click();
    await expect(files.getByLabel('文件文本')).toHaveCount(0); await expect(files.locator('[data-file-source="draft.md"]')).toContainText('Managed document');
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});

test('the editor shows active content as source, leaves symlinks unopenable, and names binary files and stale edits', async ({ page }) => {
  const host = await launch(); await writeFile(join(host.external, 'active.html'), '<script>window.AORK_FILE_EXECUTED=true</script>'); await writeFile(join(host.external, 'binary'), Buffer.from([255, 0])); await symlink(host.directory, join(host.external, 'outside'));
  try {
    await page.goto(host.accessUrl); await createWorkspaceViaPicker(page, host.external); await openPanel(page, '文件');
    const files = page.getByRole('region', { name: '工作区文件', exact: true });
    // What the editor shows is text, never a page: the script is on screen and has not run.
    await choose(page, files, 'active.html', '编辑');
    await expect(files.getByLabel('文件文本')).toHaveValue('<script>window.AORK_FILE_EXECUTED=true</script>');
    expect(await page.evaluate(() => 'AORK_FILE_EXECUTED' in window)).toBe(false);
    // A symlink is listed, greyed, with the reason, and offers nothing to act on.
    const link = files.locator('[data-file-path="outside"]');
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await expect(files.getByText('链接不可访问', { exact: true })).toBeVisible();
    await expect(files.getByRole('button', { name: '更多操作：outside', exact: true })).toHaveCount(0);
    // A file changed since it was read is not written over.
    await files.getByLabel('文件文本').fill('stale edit'); await writeFile(join(host.external, 'active.html'), 'external edit'); await files.getByRole('button', { name: '保存文件', exact: true }).click();
    await expect(files.getByRole('alert')).toContainText('changed'); expect(await readFile(join(host.external, 'active.html'), 'utf8')).toBe('external edit');
    // Bytes that are not text are not passed off as a source file.
    await choose(page, files, 'binary', '编辑');
    await expect(files.getByRole('alert')).toContainText('not UTF-8');
  } finally { await page.goto('about:blank').catch(() => {}); await host.close(); }
});
