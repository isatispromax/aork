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

/** Opens the new-workspace dialog and the in-app directory picker; the caller drives the picker itself. */
async function openCreateDialog(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作区' });
  await dialog.getByLabel('工作区名称').fill(name);
  await dialog.getByRole('button', { name: '选择目录…', exact: true }).click();
  return { dialog, picker: page.getByRole('dialog', { name: '目录选择器' }) };
}

/** Points the picker at an absolute path through 前往文件夹 (also the only route into hidden directories). */
async function gotoFolder(picker: import('@playwright/test').Locator, path: string) {
  await picker.getByLabel('前往文件夹').fill(path);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
}

const row = (picker: import('@playwright/test').Locator, path: string) => picker.locator(`button[data-entry-path="${path}"]`);

test('new workspace dialog registers a real directory through the directory picker and restores selection after reload', async ({ page }) => {
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
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();

    // Submitting without a directory stays in the dialog with a correctable error.
    const dialog = page.getByRole('dialog', { name: '新建工作区' });
    await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
    await dialog.getByLabel('工作区名称').fill('External notes');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请先选择工作区目录');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: '选择目录…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await expect(picker).toBeVisible();
    await gotoFolder(picker, host.external);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(host.external, { exact: true })).toBeVisible();
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
    const { dialog, picker } = await openCreateDialog(page, 'Notes');
    await gotoFolder(picker, host.external);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
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
    const editDialog = page.getByRole('dialog', { name: '编辑工作区' });
    await editDialog.getByLabel('工作区名称').fill('Reference');
    await editDialog.getByRole('button', { name: '保存', exact: true }).click();
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
    await gotoFolder(picker, missing);
    await expect(picker.getByRole('alert')).toContainText('The directory does not exist');
    await expect(picker).toBeVisible();
    await gotoFolder(picker, host.external);
    await expect(row(picker, host.external)).toHaveCount(0); // the chosen root itself is not listed inside its own listing
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByText(host.external, { exact: true })).toBeVisible();
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

test('the directory picker follows mac conventions: selection, keyboard, history, search, hidden toggle and go-to-folder', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const root = join(host.directory, 'picker-root');
  const alpha = join(root, 'alpha'); const nested = join(alpha, 'nested'); const beta = join(root, 'beta'); const hiddenDir = join(beta, '.concealed');
  const note = join(beta, 'note.txt');
  await mkdir(nested, { recursive: true }); await mkdir(hiddenDir, { recursive: true }); await writeFile(note, 'plain bytes');
  await symlink(alpha, join(beta, 'alpha-link'));
  try {
    await page.goto(host.accessUrl);
    const { dialog, picker } = await openCreateDialog(page, 'Picked');

    // The picker opens on the server home after discovery; the sidebar marks 主目录 current.
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    // `~` expands to the discovered home and lands on the same directory.
    await gotoFolder(picker, '~');
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    await gotoFolder(picker, root);
    await expect(row(picker, alpha)).toBeVisible();

    // Keyboard: ↓ selects the first row, → enters the selected directory, the path bar shows the location.
    await picker.getByRole('list', { name: '目录内容' }).focus();
    await picker.getByRole('list', { name: '目录内容' }).press('ArrowDown');
    await expect(row(picker, alpha)).toHaveAttribute('aria-current', 'true');
    await picker.getByRole('list', { name: '目录内容' }).press('ArrowRight');
    await expect(picker.getByRole('navigation', { name: '目录位置' })).toContainText('alpha');
    await expect(row(picker, nested)).toBeVisible();

    // Finder-style history: 后退 returns and clears the selection, 前进 walks forward again.
    await picker.getByRole('button', { name: '后退' }).click();
    await expect(row(picker, alpha)).toBeVisible();
    await expect(row(picker, alpha)).not.toHaveAttribute('aria-current', 'true');
    await picker.getByRole('button', { name: '前进' }).click();
    await expect(row(picker, nested)).toBeVisible();
    // ArrowLeft goes up one level, matching the path bar.
    await picker.getByRole('list', { name: '目录内容' }).press('ArrowLeft');
    await expect(row(picker, alpha)).toBeVisible();

    // Double click enters beta; dotfiles stay hidden while symlinks are annotated.
    await row(picker, beta).dblclick();
    await expect(row(picker, note)).toBeVisible();
    await expect(row(picker, hiddenDir)).toHaveCount(0);
    await expect(row(picker, join(beta, 'alpha-link'))).toContainText('链接');

    // The toolbar search filters the current listing client-side and clears back to the full list.
    await picker.getByLabel('搜索当前目录').fill('not');
    await expect(row(picker, note)).toBeVisible();
    await expect(row(picker, join(beta, 'alpha-link'))).toHaveCount(0);
    await expect(picker.getByText('1 个项目')).toBeVisible();
    await picker.getByLabel('搜索当前目录').fill('');
    await expect(row(picker, join(beta, 'alpha-link'))).toBeVisible();

    // A selected file row disables confirmation.
    await row(picker, note).click();
    await expect(row(picker, note)).toHaveAttribute('aria-current', 'true');
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeDisabled();

    // The hidden-files toggle reveals dotfiles; double click enters the hidden directory.
    await picker.getByLabel('显示隐藏文件').check();
    await expect(row(picker, hiddenDir)).toBeVisible();
    await row(picker, hiddenDir).dblclick();
    await expect(picker.getByText('此目录为空。', { exact: true })).toBeVisible();
    // The path bar navigates back to beta and the toggle hides dotfiles again.
    await picker.getByRole('navigation', { name: '目录位置' }).getByRole('button', { name: 'beta' }).click();
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
    // The window close affordance cancels the same way.
    await dialog.getByRole('button', { name: '换个目录', exact: true }).click();
    await picker.getByRole('button', { name: '关闭' }).click();
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
    await picker.getByText('选择文件夹', { exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    // The create dialog stays open on its manual-path state: nothing was selected.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('尚未选择目录', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '选择目录…', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});
