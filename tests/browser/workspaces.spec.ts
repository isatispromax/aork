import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

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

/** The Workspace browser: one region whose Workspace rows head groups with the Session rows under them. */
const browser = (page: Page) => page.getByRole('region', { name: '工作区', exact: true });
const workspaceRow = (page: Page, name: string) => browser(page).getByRole('treeitem', { name, exact: true });
const createForm = (page: Page) => page.getByRole('main').getByRole('region', { name: '新建会话', exact: true });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** 添加工作区 opens the in-app directory picker directly; no name/directory form precedes it. */
async function openPicker(page: Page) {
  await browser(page).getByRole('button', { name: '添加工作区', exact: true }).click();
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

/** Registers a directory through the in-app picker (the only creation route). */
async function register(page: Page, path: string) {
  const picker = await openPicker(page);
  await gotoFolder(picker, path);
  await picker.getByRole('button', { name: '选择', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

/** Opens the view-options menu and picks one of its radio choices. */
async function chooseView(page: Page, name: string) {
  await browser(page).getByRole('button', { name: '视图选项', exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

type Overview = { workspaces: Array<{ id: string; name: string; directory: string; order?: number }> };
const overview = async (page: Page, accessUrl: string) => await (await page.request.get(new URL('api/queries/workspace.overview', accessUrl).toString())).json() as Overview;
/** The Workspace names in display order: the browser's rows, or the server's sequence when the tree is folded away. */
const rowNames = (page: Page) => browser(page).locator('[data-workspace-group]').evaluateAll(groups => groups.map(group => group.querySelector('[role="treeitem"]')?.getAttribute('aria-label')));
const orderedNames = async (page: Page, accessUrl: string) => (await overview(page, accessUrl)).workspaces.slice().sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)).map(item => item.name);
const selection = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));

test('添加工作区 opens the directory picker directly; confirming registers the folder under its own name and opens a new Session in it', async ({ page }) => {
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
    await expect(browser(page)).toBeVisible();
    // Without a Workspace the browser says so, and the centre is the new-Session surface.
    await expect(browser(page).getByText('暂无工作区', { exact: true })).toBeVisible();
    await expect(createForm(page)).toBeVisible();

    // Confirming a folder is the whole creation: there is no form to submit, and the folder names the Workspace.
    const picker = await openPicker(page);
    await gotoFolder(picker, host.external);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);

    // A failed overview reload after the command still keeps the new selection and surfaces the error.
    await expect(browser(page).getByRole('alert')).toContainText('Temporary workspace list failure');
    expect(selection(page).get('workspace')).toMatch(/^[\da-f-]{36}$/);
    expect(selection(page).get('createSession')).toBe('1');
    const selected = page.url();
    failOverview = false;
    await page.reload(); await expect(createForm(page)).toBeVisible(); await expect(workspaceRow(page, basename(host.external))).toBeVisible();
    expect(page.url()).toBe(selected);
    // Adding opens a new Session in the Workspace, the way dsh's startSession does.
    await expect(createForm(page).getByRole('button', { name: '选择工作区' })).toContainText(basename(host.external));
    expect(page.url()).not.toContain('project=');
    // Dwelling on the row shows its card: the canonical directory, verbatim, and when it was registered.
    await workspaceRow(page, basename(host.external)).hover();
    const card = page.locator(`[aria-label="工作区“${basename(host.external)}”"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText(await realpath(host.external), { exact: true })).toBeVisible();
    await expect(card).toContainText('创建于');
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
    await expect(workspaceRow(page, basename(host.external))).toHaveCount(1);
    await expect(browser(page).getByRole('treeitem', { name: 'locked', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await chmod(locked, 0o700); await host.close(); }
});

test('adding a directory that is already registered returns that Workspace instead of a second one', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await register(page, host.external);
    await register(page, host.external);
    await expect(browser(page).locator('[data-workspace-group]')).toHaveCount(1);
    expect((await overview(page, host.accessUrl)).workspaces).toHaveLength(1);
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
    // Confirming registers the Workspace under the folder's name and opens a new Session in it.
    await expect(workspaceRow(page, 'beta')).toBeVisible();
    await expect(createForm(page).getByRole('button', { name: '选择工作区' })).toContainText('beta');
    await expect(createForm(page).getByText(await realpath(beta), { exact: true })).toBeVisible();

    // Cancel closes the picker without registering anything.
    const newWorkspace = browser(page).getByRole('button', { name: '添加工作区', exact: true });
    await newWorkspace.click(); await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).toHaveCount(0);
    // The window close affordance cancels the same way.
    await newWorkspace.click(); await picker.getByRole('button', { name: '关闭' }).click();
    await expect(picker).toHaveCount(0);
    await page.goto(host.accessUrl);
    await expect(workspaceRow(page, 'beta')).toHaveCount(1);
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
    // Nothing was registered: the empty browser stays and focus returns to the control that opened the picker.
    await expect(page.getByRole('dialog', { name: '新建工作区', exact: true })).toHaveCount(0);
    await expect(browser(page).getByText('暂无工作区', { exact: true })).toBeVisible();
    await expect(browser(page).getByRole('button', { name: '添加工作区', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('the row menu renames to a unique name: the input opens selected, an unchanged or taken name blocks, and a taken name is named in place', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await register(page, host.external);
    const drafts = join(host.directory, 'drafts'); await mkdir(drafts, { recursive: true });
    await register(page, drafts);
    const folder = basename(host.external);
    // ··· offers rename and delete, and nothing to archive.
    await workspaceRow(page, folder).hover();
    await browser(page).getByRole('button', { name: `工作区“${folder}”的操作` }).click();
    const menu = page.getByRole('menu', { name: '工作区操作' });
    await expect(menu.getByRole('menuitem', { name: '重命名…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '删除工作区…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /归档/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // The right-click raises the same menu.
    await workspaceRow(page, folder).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '重命名…' }).click();
    const dialog = page.getByRole('dialog', { name: '重命名工作区' });
    const input = dialog.getByLabel('工作区名称');
    const confirm = dialog.getByRole('button', { name: '重命名', exact: true });
    // The shown name opens selected; confirming it unchanged does nothing and is therefore disabled.
    expect(await input.inputValue()).toBe(folder);
    expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, folder.length]);
    await expect(confirm).toBeDisabled();
    // A name another Workspace holds is refused in place, before anything reaches the server.
    await input.fill('drafts');
    await expect(dialog.getByRole('alert')).toHaveText('已存在名为“drafts”的工作区。');
    await expect(confirm).toBeDisabled();
    await input.fill('Reference');
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(workspaceRow(page, 'Reference')).toBeVisible();
    await expect(workspaceRow(page, folder)).toHaveCount(0);
    expect((await overview(page, host.accessUrl)).workspaces.map(item => item.name).sort()).toEqual(['Reference', 'drafts']);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('deleting the Workspace a new Session was being started in clears that choice', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.accessUrl);
    await register(page, host.external);
    const folder = basename(host.external);
    await expect(createForm(page).getByRole('button', { name: '选择工作区' })).toContainText(folder);
    await workspaceRow(page, folder).hover();
    await browser(page).getByRole('button', { name: `工作区“${folder}”的操作` }).click();
    await page.getByRole('menu', { name: '工作区操作' }).getByRole('menuitem', { name: '删除工作区…' }).click();
    const dialog = page.getByRole('dialog', { name: '删除工作区' });
    await expect(dialog).toContainText('文件夹与会话记录会保留');
    await dialog.getByRole('button', { name: '删除工作区', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(workspaceRow(page, folder)).toHaveCount(0);
    await expect(browser(page).getByText('暂无工作区', { exact: true })).toBeVisible();
    // The new-Session surface stays; it no longer names the removed Workspace.
    await expect(createForm(page)).toBeVisible();
    await expect(createForm(page).getByRole('button', { name: '选择工作区' })).toContainText('选择工作区');
    expect(selection(page).has('workspace')).toBe(false);
    expect((await overview(page, host.accessUrl)).workspaces).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('clicking a Workspace row folds and unfolds its group, and the fold survives reloads', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await f.command('sessions.create', (await sessionEnvironment(f)).input);
    await page.goto(f.host.accessUrl!);
    const row = workspaceRow(page, 'Notes');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toBeVisible();
    // The whole row is the click target, and the address does not change: the selection is not the fold.
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    // Hovering swaps the folder for the disclosure triangle without moving the title.
    await row.hover();
    await expect(row.locator('[class*="chevron"]')).toBeVisible();
    await expect(row.locator('[class*="_folder"]')).toBeHidden();
    await row.click();
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('tree mode nests a Workspace under its registered ancestor; a selection under a fold reveals its chain, while a fold otherwise stands', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const parent = join(host.directory, 'tree-parent');
  const child = join(parent, 'tree-child');
  const cousin = join(host.directory, 'tree-cousin');
  await mkdir(child, { recursive: true }); await mkdir(cousin, { recursive: true });
  try {
    await page.goto(host.accessUrl);
    for (const directory of [parent, child, cousin]) await register(page, directory);
    // List mode: three flat rows at one level.
    await expect.poll(() => rowNames(page)).toEqual(['tree-parent', 'tree-child', 'tree-cousin']);
    expect(await workspaceRow(page, 'tree-child').evaluate(node => (node.closest('[data-workspace-group]') as HTMLElement).style.getPropertyValue('--workspace-indent'))).toBe('0px');
    await chooseView(page, '按工作区树');

    // Tree mode: the child nests under the parent, one 12px level in.
    await expect(workspaceRow(page, 'tree-child')).toBeVisible();
    expect(await workspaceRow(page, 'tree-child').evaluate(node => (node.closest('[data-workspace-group]') as HTMLElement).style.getPropertyValue('--workspace-indent'))).toBe('12px');
    expect(await workspaceRow(page, 'tree-parent').evaluate(node => (node.closest('[data-workspace-group]') as HTMLElement).style.getPropertyValue('--workspace-indent'))).toBe('0px');
    await workspaceRow(page, 'tree-parent').click();
    await expect(workspaceRow(page, 'tree-child')).toHaveCount(0);
    await expect(workspaceRow(page, 'tree-parent')).toHaveAttribute('aria-expanded', 'false');

    // Choosing the folded child through the address — a new Session in it — expands its chain, durably.
    const childId = (await overview(page, host.accessUrl)).workspaces.find(item => item.name === 'tree-child')!.id;
    await page.evaluate(workspaceId => { location.hash = new URLSearchParams({ workspace: workspaceId, createSession: '1' }).toString(); }, childId);
    await expect(workspaceRow(page, 'tree-child')).toBeVisible();
    await expect(workspaceRow(page, 'tree-parent')).toHaveAttribute('aria-expanded', 'true');
    await expect(createForm(page).getByRole('button', { name: '选择工作区' })).toContainText('tree-child');
    await page.reload();
    await expect(workspaceRow(page, 'tree-child')).toBeVisible();

    // A fold made after that stands on the next load, whatever is selected.
    await workspaceRow(page, 'tree-parent').click();
    await expect(workspaceRow(page, 'tree-child')).toHaveCount(0);
    await page.reload();
    await expect(workspaceRow(page, 'tree-parent')).toHaveAttribute('aria-expanded', 'false');
    await expect(workspaceRow(page, 'tree-child')).toHaveCount(0);
    // Switching the grouping keeps each Workspace's fold; the list shows every Workspace flat again.
    await chooseView(page, '按工作区');
    await expect(workspaceRow(page, 'tree-child')).toBeVisible();
    await chooseView(page, '按工作区树');
    await expect(workspaceRow(page, 'tree-child')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('dragging a Workspace row reorders the sequence with an insertion marker and survives a reload', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const first = join(host.directory, 'drag-first');
  const second = join(host.directory, 'drag-second');
  await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
  try {
    await page.goto(host.accessUrl);
    await register(page, first);
    await register(page, second);
    await expect.poll(() => rowNames(page)).toEqual(['drag-first', 'drag-second']);
    const rowBox = async (name: string) => (await workspaceRow(page, name).boundingBox())!;

    // Drag drag-second onto the upper half of drag-first: a 6px move arms the drag and the marker names the gap.
    const source = await rowBox('drag-second');
    const target = await rowBox('drag-first');
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 10, { steps: 4 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 4, { steps: 6 });
    await expect(browser(page).locator('[data-workspace-group][data-drop="before"]')).toHaveCount(1);
    await page.mouse.up();

    // The server sequence records the new order and a reload keeps it in the display order.
    await expect.poll(() => orderedNames(page, host.accessUrl)).toEqual(['drag-second', 'drag-first']);
    await page.reload();
    await expect.poll(() => rowNames(page)).toEqual(['drag-second', 'drag-first']);
    // The lower half of a row is the gap below it: dragging drag-first back there lands it after drag-second.
    const again = await rowBox('drag-first');
    const below = await rowBox('drag-second');
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2 + 10, { steps: 4 });
    await page.mouse.move(below.x + below.width / 2, below.y + below.height * 3 / 4, { steps: 6 });
    await expect(browser(page).locator('[data-workspace-group][data-drop="after"]')).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(() => orderedNames(page, host.accessUrl)).toEqual(['drag-second', 'drag-first']);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('in tree mode a Workspace dropped over a descendant\'s rows lands beside the ancestor that is its sibling', async ({ page }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const parent = join(host.directory, 'tree-parent');
  const child = join(parent, 'tree-child');
  const cousin = join(host.directory, 'tree-cousin');
  await mkdir(child, { recursive: true }); await mkdir(cousin, { recursive: true });
  try {
    await page.goto(host.accessUrl);
    // The cousin registers first, so it precedes the parent in the roots' order.
    for (const directory of [cousin, parent, child]) await register(page, directory);
    await chooseView(page, '按工作区树');
    await expect(workspaceRow(page, 'tree-child')).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(['tree-cousin', 'tree-parent', 'tree-child']);
    // The cousin is not the child's sibling: its drop over the child's row resolves to the parent, the nearest
    // ancestor that is one, and the half is read on the parent's whole section.
    const cousinBox = (await workspaceRow(page, 'tree-cousin').boundingBox())!;
    const childBox = (await workspaceRow(page, 'tree-child').boundingBox())!;
    await page.mouse.move(cousinBox.x + cousinBox.width / 2, cousinBox.y + cousinBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cousinBox.x + cousinBox.width / 2, cousinBox.y + cousinBox.height / 2 - 10, { steps: 4 });
    await page.mouse.move(childBox.x + childBox.width / 2, childBox.y + childBox.height / 2, { steps: 6 });
    const parentId = (await overview(page, host.accessUrl)).workspaces.find(item => item.name === 'tree-parent')!.id;
    await expect(browser(page).locator(`[data-workspace-group="${parentId}"][data-drop]`)).toHaveCount(1);
    await page.mouse.up();
    // The sibling set keeps its two slots in the stored sequence; the tree then reads roots parent, cousin.
    await expect.poll(() => orderedNames(page, host.accessUrl)).toEqual(['tree-parent', 'tree-cousin', 'tree-child']);
    await expect.poll(() => rowNames(page)).toEqual(['tree-parent', 'tree-child', 'tree-cousin']);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host.close(); }
});

test('search replaces the tree with flat results and a chosen result is revealed under its Workspace; 单列表 shows every Session in one run', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { workspace, profile, input } = await sessionEnvironment(f);
    const other = join(f.directory, 'Other'); await mkdir(other, { recursive: true });
    const otherWorkspace = (await (await f.command('workspace.create', { workspace: { name: 'Other', directory: other } })).json()).result;
    await f.command('sessions.create', input);
    await f.command('sessions.create', { name: 'Other conversation', workspaceId: otherWorkspace.id, profileId: profile.id });
    await page.goto(f.host.accessUrl!);
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toBeVisible();

    // 单列表: no Workspace rows, every Session in one run.
    await chooseView(page, '单列表');
    await expect(browser(page).locator('[data-workspace-group]')).toHaveCount(0);
    await expect(browser(page).locator('[data-session-rows="flat"]')).toBeVisible();
    await expect(browser(page).getByRole('treeitem', { name: 'Other conversation', exact: true })).toBeVisible();

    // A fold is kept across groupings: back in groups, Notes is still open and shows its Session.
    await chooseView(page, '按工作区');
    await workspaceRow(page, 'Notes').click();
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toHaveCount(0);

    // Search takes the header's width and replaces the tree with flat results, each under its Workspace's name.
    await browser(page).getByRole('button', { name: '搜索会话', exact: true }).click();
    const search = browser(page).getByRole('textbox', { name: '搜索会话', exact: true });
    await expect(search).toBeFocused();
    await search.fill('Research');
    await expect(browser(page).locator('[data-session-rows="search"]')).toBeVisible();
    await expect(browser(page).locator('[data-workspace-group]')).toHaveCount(0);
    const result = browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true });
    await expect(result).toBeVisible();
    await expect(result).toContainText('Notes');

    // Choosing it clears and closes the search, opens the Session and unfolds the Workspace it was hidden under.
    await result.click();
    await expect(browser(page).getByRole('button', { name: '搜索会话', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { name: 'Research conversation', exact: true })).toBeVisible();
    await expect(workspaceRow(page, 'Notes')).toHaveAttribute('aria-expanded', 'true');
    await expect(browser(page).getByRole('treeitem', { name: 'Research conversation', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('the new-Session picker lists the Workspaces, and its 添加工作区… registers a directory and selects it', async ({ page }) => {
  const f = await sessionHost(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sessionEnvironment(f);
    const extra = join(f.directory, 'extra'); await mkdir(extra, { recursive: true });
    await page.goto(f.host.accessUrl!);
    await expect(createForm(page)).toBeVisible();
    const trigger = createForm(page).getByRole('button', { name: '选择工作区' });
    await trigger.click();
    const listbox = page.getByRole('listbox', { name: '选择工作区' });
    // The chosen Workspace carries the check; the add entry sits below the list.
    await expect(listbox.getByRole('option', { name: 'Notes' })).toHaveAttribute('aria-selected', 'false');
    await page.getByRole('button', { name: '添加工作区…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '目录选择器' });
    await gotoFolder(picker, extra);
    await picker.getByRole('button', { name: '选择', exact: true }).click();
    await expect(picker).toHaveCount(0);
    // The picker menu closed with the choice and the field names the new Workspace.
    await expect(listbox).toHaveCount(0);
    await expect(trigger).toContainText('extra');
    await expect(workspaceRow(page, 'extra')).toBeVisible();
    // The browser offered the same registration only once, and the field can reopen on the longer list.
    await trigger.click();
    await expect(listbox.getByRole('option', { name: 'extra' })).toHaveAttribute('aria-selected', 'true');
    expect((await (await f.query('workspace.overview')).json()).workspaces).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
