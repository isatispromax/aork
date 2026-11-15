import { expect, test } from '@playwright/test';

test('the real Host loads the selected plugin login through the shared React runtime', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的工作台' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('账号尚未初始化');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
  await page.getByText('启动诊断 · 2 个插件已激活').click();
  await expect(page.getByText('auth-single-user@0.1.0，workbench@0.1.0')).toBeVisible();
  const response = await request.get('/api/queries/workbench.overview');
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_SETUP_REQUIRED' } });
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '登录你的工作台' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function launchFault(mutate: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-browser-fault-'));
  const distribution = join(directory, 'dist');
  await cp('dist', distribution, { recursive: true });
  await mutate(distribution);
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--distribution-dir', distribution, '--port', '0']);
  const exited = once(child, 'exit');
  const url = await new Promise<string>((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); const match = stdout.match(/"url":"([^"]+)"/); if (match) resolve(match[1]!); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('exit', code => reject(new Error(`Host exited ${code}: ${stderr}`)));
  });
  return { url, async close() { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); } };
}

test('a missing explicitly selected provider shows the minimal Host fallback and its maintenance path', async ({ page, request }) => {
  const host = await launchFault(async distribution => {
    const path = join(distribution, 'profiles/personal-server.json');
    const profile = JSON.parse(await readFile(path, 'utf8'));
    delete profile.ui.providers['aork.workbench.home@1'];
    await writeFile(path, JSON.stringify(profile));
  });
  try {
    await page.goto(host.url);
    await expect(page.getByRole('heading', { name: 'Aork 启动失败' })).toBeVisible();
    await expect(page.getByText('UI_PROVIDER_UNAVAILABLE')).toBeVisible();
    await expect(page.getByText('ui.providers.aork.workbench.home@1', { exact: true })).toBeVisible();
    await expect(page.getByText('pnpm aork doctor --data-dir <data-directory>')).toBeVisible();
    await expect(page.getByRole('heading', { name: '登录你的工作台' })).toHaveCount(0);
    const query = await request.get(`${host.url}/api/queries/workbench.overview`);
    expect(query.status()).toBe(503);
    expect(await query.json()).toMatchObject({ error: { code: 'ACCOUNT_SETUP_REQUIRED' } });
  } finally { await host.close(); }
});

test('a login renderer failure is contained and names its selected plugin provider', async ({ page }) => {
  const host = await launchFault(async distribution => {
    const path = join(distribution, 'plugins/auth-single-user/0.1.0/client.js');
    const source = await readFile(path, 'utf8');
    // Inject a failure into the actual prebuilt plugin's view, leaving Host and runtime untouched.
    await writeFile(path, source.replace(/function Login\([^)]*\)\s*\{/, '$& throw new Error("fixture-render-failure");'));
  });
  try {
    await page.goto(host.url);
    await expect(page.getByRole('heading', { name: 'Aork 启动失败' })).toBeVisible();
    await expect(page.getByText('UI_RENDER_FAILED')).toBeVisible();
    await expect(page.getByText('Selected provider auth-single-user:login failed to render')).toBeVisible();
    await expect(page.getByText('fixture-render-failure')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
  } finally { await host.close(); }
});
