import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Agent Settings save a redacted credential and Profile, edit it and restore it after refresh and restart', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'aork-agent-browser-')); const dataDir = join(directory, 'data');
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const provider = join(distributionDir, 'plugins/test-agent/0.1.0'); await mkdir(provider, { recursive: true });
  await writeFile(join(provider, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'test-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1'], ui: { providers: [] } }));
  await writeFile(join(provider, 'server.js'), `export function activate(context) { context.service('aork.agent.providers@1').register({ id: 'test.acp', label: 'Controllable ACP test Provider', version: '1.2.0', launch: { executable: process.execPath, arguments: ['controlled-acp.cjs'], protocol: 'acp-stdio' }, parameters: [{name:'model',label:'Model',type:'string'}], authentication: ['none','api-key'], parseParameters(value) { if(Object.keys(value).some(key=>key!=='model')) throw new Error('invalid'); return value; }, detect() { return { status: 'available', version: '1.2.0' }; } }); context.service('aork.agent.providers@1').register({ id: 'zzz.missing-acp', label: 'Missing ACP binary', version: '1.0.0', launch: { executable: '/absent/acp-binary', arguments: [], protocol: 'acp-stdio' }, parameters: [], authentication: ['none'], parseParameters(value) { return value; }, detect() { return { status: 'unavailable', reason: 'binary-missing' }; } }); }`);
  const key = join(directory, 'master.key'); await writeFile(key, randomBytes(32), { mode: 0o600 });
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8')); profile.plugins.push({ id: 'test-agent', version: '0.1.0', enabled: true }); profile.plugins.find((item: { id: string }) => item.id === 'agent-profiles').config = { masterKeyFile: key };
  // profile apply is a public local-maintenance entry and takes the same exclusive Host lock.
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const execute = promisify(execFile);
  const file = join(directory, 'profile.json'); await writeFile(file, JSON.stringify(profile));
  await execute(process.execPath, ['dist/server/main.mjs', 'profile', 'apply', file, '--data-dir', dataDir, '--distribution-dir', distributionDir]);
  async function launch() {
    const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', dataDir, '--distribution-dir', distributionDir, '--port', '0', '--insecure-loopback']); const exited = once(child, 'exit');
    const info = await new Promise<{ url: string; accessUrl: string }>((resolve, reject) => { let output = ''; let error = ''; child.stdout.on('data', data => { output += data; const line = output.split('\n').find(line => line.includes('host.listening')); if (line) resolve(JSON.parse(line)); }); child.stderr.on('data', data => { error += data; }); child.once('error', reject); child.once('exit', () => reject(new Error(`Host failed: ${error}`))); });
    return { ...info, async close() { child.kill('SIGTERM'); await exited; } };
  }
  let host: Awaited<ReturnType<typeof launch>> | undefined; const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    host = await launch(); await page.goto(host.accessUrl);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible(); await expect(page.getByText('未找到 Agent 二进制', { exact: true })).toBeVisible();
    await expect(page.getByText('Controllable ACP test Provider', { exact: true }).first()).toBeVisible();
    await page.getByLabel('凭据名称').fill('Browser credential'); const secret = `browser-private-${crypto.randomUUID()}`;
    await page.getByLabel('新 API 凭据').fill(secret); await page.getByRole('button', { name: '保存新凭据' }).click();
    await expect(page.getByRole('status').filter({ hasText: '凭据已保存' })).toBeVisible(); await expect(page.getByLabel('新 API 凭据')).toHaveValue('');
    await page.getByLabel('配置名称').fill('Browser agent'); await page.getByLabel('版本要求').fill('^1.0.0'); await page.getByLabel('Model', { exact: true }).fill('first-model');
    await page.getByLabel('认证方式').selectOption('api-key'); await page.getByLabel('凭据引用').selectOption({ label: 'Browser credential' });
    await page.getByRole('button', { name: '保存 Agent Profile' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Agent Profile 已保存' })).toBeVisible(); await expect(page.getByText('Browser agent', { exact: true })).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain(secret);
    const overview = await (await page.request.get(`${host.url}/api/queries/agents.overview`)).text(); expect(overview).not.toContain(secret); expect(overview).not.toContain('masterKeyFile');
    await page.getByRole('button', { name: '编辑 Browser agent' }).click(); await page.getByLabel('配置名称').fill('Edited browser agent'); await page.getByRole('button', { name: '更新 Agent Profile' }).click();
    await expect(page.getByText('Edited browser agent', { exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByText('Edited browser agent', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/aork-ticket09-settings-mobile.png', fullPage: true }); await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: '/tmp/aork-ticket09-settings.png', fullPage: true });
    await page.goto('about:blank'); await host.close(); host = await launch(); await page.goto(host.accessUrl); await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByText('Edited browser agent', { exact: true })).toBeVisible(); await expect(page.getByLabel('新 API 凭据')).toHaveValue('');
    await page.goto('about:blank'); await host.close(); await rm(key); host = await launch(); await page.goto(host.accessUrl); await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByText('手动 API 凭据缺少独立主密钥，请在服务器配置后重启。')).toBeVisible(); await expect(page.getByRole('button', { name: '保存新凭据' })).toBeDisabled(); expect(errors).toEqual([]);
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});
