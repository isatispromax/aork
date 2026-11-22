import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

/** Opens the new-workspace dialog; the caller drives the picker interaction itself. */
async function openCreateDialog(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作区' });
  await dialog.getByLabel('工作区名称').fill(name);
  await dialog.getByRole('button', { name: '选择目录…', exact: true }).click();
  return { dialog, picker: page.getByRole('dialog', { name: '目录选择器' }) };
}

const row = (picker: import('@playwright/test').Locator, path: string) => picker.locator(`button[data-entry-path="${path}"]`);

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

test('new-workspace dialog recovers from directory errors in place and archiving keeps the registered workspace history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const missing = join(host.directory, 'missing');
    const { dialog, picker } = await openCreateDialog(page, 'Reference');
    // A wrong 前往文件夹 target fails in place; the picker stays open and a corrected path recovers.
    await picker.getByLabel('前往文件夹').fill(missing);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText('The directory does not exist');
    await expect(picker).toBeVisible();
    await picker.getByLabel('前往文件夹').fill(host.external);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await expect(row(picker, host.external)).toHaveCount(0); // the chosen root itself is not listed inside its own listing
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(host.external, { exact: true })).toBeVisible();
    await dialog.getByLabel('授权此目录及其子目录').check();
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

test('the directory picker follows mac conventions: select, enter, hidden toggle, go-to-folder and no-selection confirm', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const root = join(host.directory, 'picker-root');
  const alpha = join(root, 'alpha'); const nested = join(alpha, 'nested'); const beta = join(root, 'beta'); const hiddenDir = join(beta, '.concealed');
  const note = join(beta, 'note.txt');
  await mkdir(nested, { recursive: true }); await mkdir(hiddenDir, { recursive: true }); await writeFile(note, 'plain bytes');
  await symlink(alpha, join(beta, 'alpha-link'));
  try {
    await page.goto(host.accessUrl);
    const { dialog, picker } = await openCreateDialog(page, 'Picked');

    // The picker opens on the server home after discovery; quick access marks 主目录 current.
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    // `~` expands to the discovered home and lands on the same directory.
    await picker.getByLabel('前往文件夹').fill('~');
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    await picker.getByLabel('前往文件夹').fill(root);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await expect(row(picker, alpha)).toBeVisible();

    // Single click selects without entering.
    await row(picker, alpha).click();
    await expect(row(picker, alpha)).toHaveAttribute('aria-current', 'true');
    // Enter on the selected row enters the directory (double-click equivalence).
    await row(picker, alpha).press('Enter');
    await expect(picker.getByRole('navigation', { name: '目录位置' })).toContainText('alpha');
    await expect(row(picker, nested)).toBeVisible();
    // 上一级 returns and clears the selection.
    await picker.getByRole('button', { name: '上一级', exact: true }).click();
    await expect(row(picker, alpha)).toBeVisible();

    // Double click enters beta; dotfiles are hidden by default while files gray out and symlinks are annotated.
    await row(picker, beta).dblclick();
    await expect(row(picker, note)).toBeVisible();
    await expect(row(picker, hiddenDir)).toHaveCount(0);
    await expect(row(picker, join(beta, 'alpha-link'))).toContainText('链接');
    // A selected file row disables confirmation.
    await row(picker, note).click();
    await expect(row(picker, note)).toHaveAttribute('aria-current', 'true');
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeDisabled();
    // The hidden-files toggle reveals dotfiles; a selected file stays selected while showing hidden entries.
    await picker.getByLabel('显示隐藏文件').check();
    await expect(row(picker, hiddenDir)).toBeVisible();
    await expect(row(picker, note)).toHaveAttribute('aria-current', 'true');
    // Double click enters the hidden directory.
    await row(picker, hiddenDir).dblclick();
    await expect(picker.getByText('此目录为空。', { exact: true })).toBeVisible();
    // Toggling hidden off again conceals nothing here, and 上一级 returns to beta.
    await picker.getByRole('button', { name: '上一级', exact: true }).click();
    await expect(row(picker, hiddenDir)).toBeVisible();
    await picker.getByLabel('显示隐藏文件').uncheck();
    await expect(row(picker, hiddenDir)).toHaveCount(0);

    // Confirming with no selection confirms the currently browsed directory.
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(beta, { exact: true })).toBeVisible();

    // Cancel closes the picker without keeping a selection.
    await dialog.getByRole('button', { name: '换个目录', exact: true }).click();
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(beta, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('Escape closes the directory picker without selecting a directory', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const { dialog, picker } = await openCreateDialog(page, 'Escaped');
    // Wait for the picker's home discovery so the dialog is fully interactive.
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toBeVisible();
    // A real keyboard Escape inside the dialog cancels the picker only.
    await picker.getByRole('heading', { name: '选择目录' }).click();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    // The create dialog stays open on its manual-path state: nothing was selected.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('尚未选择目录', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '选择目录…', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});
