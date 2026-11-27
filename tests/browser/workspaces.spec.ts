import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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

/** 新建工作区 opens the in-app directory picker directly; no name/directory form precedes it. */
async function openPicker(page: import('@playwright/test').Page) {
  await page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '目录选择器' });
  await expect(picker).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新建工作区', exact: true })).toHaveCount(0);
  return picker;
}

/** Navigates directly to a path through 前往文件夹. */
async function gotoFolder(picker: import('@playwright/test').Locator, path: string) {
  await picker.getByLabel('前往文件夹').fill(path);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
}

const row = (picker: import('@playwright/test').Locator, path: string) => picker.locator(`button[data-entry-path="${path}"]`);
const column = (picker: import('@playwright/test').Locator, name: string) => picker.getByRole('list', { name: `目录内容 · ${name}`, exact: true });
const hasFocus = (list: import('@playwright/test').Locator) => list.evaluate(element => element.contains(document.activeElement));

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('新建工作区 opens the directory picker directly; confirming registers the folder under its own name and restores selection after reload', async ({ page }) => {
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

    // Confirming a folder is the whole creation: there is no form to submit, and the folder names the Workspace.
    const picker = await openPicker(page);
    await gotoFolder(picker, host.external);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);

    // A failed overview reload after the command still keeps the new selection and surfaces the error.
    await expect(page.getByRole('complementary', { name: '工作区导航' }).getByRole('alert')).toContainText('Temporary workspace list failure');
    await expect(page).toHaveURL(/#workspace=[\da-f-]+$/);
    const selected = page.url();
    failOverview = false;
    await page.reload(); await expect(page.getByRole('heading', { name: basename(host.external), exact: true })).toBeVisible();
    expect(page.url()).toBe(selected);
    expect(page.url()).not.toContain('project=');
    // The registered path is kept verbatim next to the resolved physical directory.
    await expect(page.getByText(host.external, { exact: true })).toBeVisible();
    await expect(page.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('a directory the server refuses keeps the picker open with the failure in place until another folder is chosen', async ({ page }) => {
  test.skip(isRoot, 'root writes into read-only directories, so the server would accept this one');
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const locked = join(host.directory, 'locked'); await mkdir(locked); await chmod(locked, 0o555);
  try {
    await page.goto(host.accessUrl);
    const picker = await openPicker(page);
    // Readable and browsable but not writable by the server: the listing works and only the registration is refused.
    await gotoFolder(picker, locked);
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText('readable and writable by the server');
    await expect(picker).toBeVisible();
    // The failure belongs to the refused folder: browsing elsewhere clears it, and that folder registers normally.
    await gotoFolder(picker, host.external);
    await expect(picker.getByRole('alert')).toHaveCount(0);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await page.goto(host.accessUrl);
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: basename(host.external) })).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('button', { name: 'locked' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await chmod(locked, 0o700); await host.close(); }
});

test('all-workspaces cards show directory and status, editing renames only, archiving keeps history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const folder = basename(host.external);
    const picker = await openPicker(page);
    await gotoFolder(picker, host.external);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible();

    // Fresh load without a selection lands on the all-workspaces page.
    await page.goto(host.accessUrl);
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    const card = page.getByRole('main').getByRole('button', { name: folder });
    await expect(card).toBeVisible();
    await expect(card).toContainText(await realpath(host.external));
    await expect(card).toContainText('开启');
    await expect(card).toContainText('0 个会话');

    await card.click();
    await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible();
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

test('directory picker recovers from browse errors in place, and archiving keeps the registered workspace history', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const missing = join(host.directory, 'missing');
    const folder = basename(host.external);
    const picker = await openPicker(page);
    // A wrong 前往文件夹 target fails in place; the picker stays open and a corrected path recovers.
    await gotoFolder(picker, missing);
    await expect(picker.getByRole('alert')).toContainText('The directory does not exist');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeDisabled();
    await gotoFolder(picker, host.external);
    await expect(row(picker, host.external)).toHaveCount(0); // the chosen root itself is not listed inside its own listing
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);

    await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible();
    expect(page.url()).toContain('workspace=');
    expect(page.url()).not.toContain('project=');
    expect(page.url()).not.toContain('artifactProject=');
    const selected = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible();
    expect(page.url()).toBe(selected);

    await page.getByRole('button', { name: '归档工作区', exact: true }).click();
    await page.getByRole('dialog', { name: '归档工作区' }).getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('main').getByRole('heading', { name: '所有工作区', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: folder })).toContainText('已归档');
    await page.getByLabel('显示归档', { exact: true }).check();
    await page.getByRole('button', { name: `${folder} · 已归档`, exact: true }).click();
    await expect(page.getByText('工作区已归档，目录与记录保留。')).toBeVisible();
    await expect(page.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('Finder-style columns retain parent directories while opening children and switching branches', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const root = join(host.directory, 'picker-root');
  const alpha = join(root, 'alpha'); const nested = join(alpha, 'nested'); const beta = join(root, 'beta'); const hiddenDir = join(beta, '.concealed');
  const note = join(beta, 'note.txt');
  await mkdir(nested, { recursive: true }); await mkdir(hiddenDir, { recursive: true }); await writeFile(note, 'plain bytes');
  await symlink(alpha, join(beta, 'alpha-link'));
  try {
    await page.goto(host.accessUrl);
    const picker = await openPicker(page);

    // The picker opens on the server home after discovery; the sidebar marks 主目录 current.
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    // The initial home can be revisited without using the sidebar.
    await gotoFolder(picker, root);
    await expect(row(picker, alpha)).toBeVisible();
    await picker.getByRole('button', { name: '后退' }).click();
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');

    // `~` expands to the discovered home and preserves forward history.
    await gotoFolder(picker, '~');
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');
    await picker.getByRole('button', { name: '前进' }).click();
    await expect(row(picker, alpha)).toBeVisible();

    const rootColumn = column(picker, 'picker-root');
    const alphaColumn = column(picker, 'alpha');
    const nestedColumn = column(picker, 'nested');
    const betaColumn = column(picker, 'beta');
    const currentCrumb = picker.getByRole('navigation', { name: '目录位置' }).locator('[aria-current]');

    // A single click adds a column to the right and retains the selected rows in the columns to its left.
    await row(rootColumn, alpha).click();
    await row(alphaColumn, nested).click();
    await expect(nestedColumn).toBeVisible();
    await expect(row(rootColumn, alpha)).toHaveAttribute('aria-current', 'true');
    await expect(row(alphaColumn, nested)).toHaveAttribute('aria-current', 'true');
    await expect(currentCrumb).toHaveText('nested');
    await expect(picker.getByText('0 个项目')).toBeVisible();
    expect(await currentCrumb.evaluate(element => element.getBoundingClientRect().right <= element.closest('nav')!.getBoundingClientRect().right)).toBe(true);
    const rootX = await rootColumn.evaluate(element => element.getBoundingClientRect().left);
    const alphaX = await alphaColumn.evaluate(element => element.getBoundingClientRect().left);
    const nestedX = await nestedColumn.evaluate(element => element.getBoundingClientRect().left);
    expect(alphaX).toBeGreaterThan(rootX);
    expect(nestedX).toBeGreaterThan(alphaX);

    // Changing a selection in an earlier column replaces only the columns to its right.
    await row(rootColumn, beta).click();
    await expect(row(betaColumn, note)).toBeVisible();
    await expect(alphaColumn).toHaveCount(0);
    await expect(nestedColumn).toHaveCount(0);
    await expect(row(rootColumn, beta)).toHaveAttribute('aria-current', 'true');

    // History restores the whole branch and its selected rows.
    await picker.getByRole('button', { name: '后退' }).click();
    await expect(row(rootColumn, alpha)).toHaveAttribute('aria-current', 'true');
    await expect(row(alphaColumn, nested)).toHaveAttribute('aria-current', 'true');
    await expect(nestedColumn).toBeVisible();
    await picker.getByRole('button', { name: '前进' }).click();
    await expect(row(betaColumn, note)).toBeVisible();

    // Vertical arrows select items; horizontal arrows move focus across retained columns.
    await rootColumn.focus();
    await page.keyboard.press('ArrowUp');
    await expect(row(rootColumn, alpha)).toHaveAttribute('aria-current', 'true');
    await expect(row(alphaColumn, nested)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hasFocus(alphaColumn)).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect(row(alphaColumn, nested)).toHaveAttribute('aria-current', 'true');
    await expect(nestedColumn).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hasFocus(nestedColumn)).toBe(true);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => hasFocus(alphaColumn)).toBe(true);
    await expect(nestedColumn).toBeVisible();

    // Dotfiles stay hidden while symlinks are annotated.
    await row(rootColumn, beta).click();
    await expect(row(picker, note)).toBeVisible();
    await expect(row(picker, hiddenDir)).toHaveCount(0);
    await expect(row(picker, join(beta, 'alpha-link'))).toContainText('链接');

    // Search filters the rightmost column without hiding any earlier column's rows.
    await picker.getByLabel('搜索当前目录').fill('not');
    await expect(row(picker, note)).toBeVisible();
    await expect(row(picker, join(beta, 'alpha-link'))).toHaveCount(0);
    await expect(row(rootColumn, alpha)).toBeVisible();
    await expect(picker.getByText('1 个项目')).toBeVisible();
    await picker.getByLabel('搜索当前目录').fill('');
    await expect(row(picker, join(beta, 'alpha-link'))).toBeVisible();

    // A selected file row disables confirmation.
    await row(picker, note).click();
    await expect(row(picker, note)).toHaveAttribute('aria-current', 'true');
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeDisabled();
    await picker.getByLabel('搜索当前目录').fill('alpha');
    await expect(row(picker, note)).toHaveCount(0);
    await expect(picker.getByRole('button', { name: '选择', exact: true })).toBeEnabled();
    await picker.getByLabel('搜索当前目录').fill('');

    // The hidden-files toggle reveals dotfiles; clicking one opens another column.
    await picker.getByLabel('显示隐藏文件').check();
    await expect(row(picker, hiddenDir)).toBeVisible();
    await row(picker, hiddenDir).click();
    await expect(column(picker, '.concealed')).toBeVisible();
    await expect(picker.getByText('此目录为空。', { exact: true })).toBeVisible();
    // The path bar navigates back to beta and the toggle hides dotfiles again.
    await picker.getByRole('navigation', { name: '目录位置' }).getByRole('button', { name: 'beta' }).click();
    await expect(row(picker, hiddenDir)).toBeVisible();
    await picker.getByLabel('显示隐藏文件').uncheck();
    await expect(row(picker, hiddenDir)).toHaveCount(0);

    // Confirming with no selection confirms the currently browsed directory, which registers it under its folder name.
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
    await expect(page.getByText(beta, { exact: true })).toBeVisible();

    // Cancel closes the picker without registering anything.
    const newWorkspace = page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true });
    await newWorkspace.click(); await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).toHaveCount(0);
    // The window close affordance cancels the same way.
    await newWorkspace.click(); await picker.getByRole('button', { name: '关闭' }).click();
    await expect(picker).toHaveCount(0);
    await page.goto(host.accessUrl);
    await expect(page.getByRole('main').getByRole('button', { name: 'beta' })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('Escape closes the directory picker without registering a Workspace', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    const picker = await openPicker(page);
    // Wait for the picker's home discovery so the dialog is fully interactive.
    await expect(picker.getByRole('navigation', { name: '快捷入口' }).getByRole('button', { name: '主目录' })).toHaveAttribute('aria-current', 'true');
    // Escape cancels the picker even while the search field has focus and a value.
    await picker.getByRole('searchbox', { name: '搜索当前目录' }).fill('abc');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    // Nothing was registered: the empty overview stays and focus returns to the control that opened the picker.
    await expect(page.getByRole('dialog', { name: '新建工作区', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '为下一项工作留个空间', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建工作区', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});
