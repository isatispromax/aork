import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
test('a separately installed layout composes public child views and ordered hidden extensions, saves settings and survives restart', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'aork-installed-browser-'));
  const dataDir = join(directory, 'data');
  const archive = join(directory, 'quiet.aork-plugin');
  const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  // The public archive supports a browser entry, stylesheet and explicit asset in separate directories.
  const packageArchive = JSON.parse(await readFile(archive, 'utf8'));
  const files = new Map<string, Buffer>(packageArchive.members.map((member: { path: string; data: string }) => [member.path, Buffer.from(member.data, 'base64')]));
  const manifest = JSON.parse(files.get('aork.plugin.json')!.toString());
  manifest.client = 'js/client.mjs'; manifest.assets = ['css/client.css', 'assets/mark.svg'];
  files.set('js/client.mjs', files.get('client.js')!); files.delete('client.js');
  files.set('css/client.css', Buffer.from(`${files.get('client.css')}\nbody { background-image: url('../assets/mark.svg'); }`)); files.delete('client.css');
  files.set('assets/mark.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="#fff" d="M0 0h1v1H0z"/></svg>'));
  files.set('aork.plugin.json', Buffer.from(JSON.stringify(manifest)));
  packageArchive.members = [...files].map(([path, bytes]) => ({ path, type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }));
  await writeFile(archive, JSON.stringify(packageArchive));
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'quiet-workbench', version: '0.1.0', enabled: true });
  profile.ui.providers['aork.workbench.layout@1'] = 'quiet-workbench:layout';
  profile.ui.providers['aork.ui.theme@1'] = 'quiet-workbench:theme';
  profile.ui.providers['aork.ui.icons@1'] = 'quiet-workbench:icons';
  profile.ui.extensions = [{ id: 'quiet-workbench:privacy', order: 10, hidden: false }, { id: 'quiet-workbench:service', order: 20, hidden: false }, { id: 'quiet-workbench:extra', order: 0, hidden: true }];
  const file = join(directory, 'profile.json'); await writeFile(file, JSON.stringify(profile));
  await execute(process.execPath, ['dist/server/main.mjs', 'plugin', 'install', archive, '--data-dir', dataDir, '--profile', file]);
  expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
  async function launch() {
    const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', dataDir, '--port', '0', '--insecure-loopback']);
    const exited = once(child, 'exit');
    const info = await test.step('Read independent-plugin Host launch URL', () => new Promise<{ url: string; accessUrl: string }>((resolve, reject) => {
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += String(chunk); const line = output.split('\n').find(line => line.includes('host.listening')); if (line) resolve(JSON.parse(line)); });
      child.stderr.on('data', chunk => { errors += String(chunk); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Host exited ${code}: ${errors}`)));
    }), { timeout: 5000 });
    return { ...info, async close() { child.kill('SIGTERM'); await test.step('Stop independent-plugin Host', async () => { await exited; }, { timeout: 5000 }); } };
  }
  let host: Awaited<ReturnType<typeof launch>> | undefined;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    host = await launch();
    await page.goto(host.accessUrl);
    await expect(page.getByText('Quiet Aork', { exact: true })).toBeVisible();
    const bootstrap = await (await page.request.get(`${host.url}/api/bootstrap`)).json();
    const external = bootstrap.plugins.find((plugin: { id: string }) => plugin.id === 'quiet-workbench');
    expect(external.client).toMatch(/\/js\/client.mjs$/);
    expect((await page.request.get(`${host.url}${external.client}`)).headers()['content-type']).toContain('text/javascript');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toContain('/assets/mark.svg');
    expect((await page.request.get(`${host.url}${external.client.replace('/js/client.mjs', '/server.js')}`)).status()).toBe(404);
    await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    const contributions = page.getByLabel('页头扩展');
    await expect(contributions).toHaveText('本机优先服务设置');
    await expect(page.getByText('可隐藏扩展', { exact: true })).toHaveCount(0);
    expect(await page.locator('header').evaluate(element => getComputedStyle(element).height)).toBe('44px');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--aork-accent').trim())).toBe('#2854a6');
    await page.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '工作台设置' })).toBeVisible();
    await page.getByLabel('工作台名称').fill('独立研究工作台');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存');
    await page.reload();
    await expect(page.locator('header')).toContainText('独立研究工作台');
    await page.screenshot({ path: '/tmp/aork-ticket04-independent-layout.png', fullPage: true });
    await page.goto('about:blank'); await host.close(); host = await launch();
    await page.goto(host.accessUrl);
    await expect(page.locator('header')).toContainText('独立研究工作台');
    await page.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await expect(page.getByLabel('工作台名称')).toHaveValue('独立研究工作台');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '退出访问', exact: true }).click();
    await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});
