import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

async function launch(mutate?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-token-browser-'));
  const distribution = join(directory, 'dist'); await cp('dist', distribution, { recursive: true }); if (mutate) await mutate(distribution);
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--distribution-dir', distribution, '--port', '0', '--insecure-loopback']);
  const exited = once(child, 'exit');
  const info = await test.step('Read the local Host launch entry', () => new Promise<{ url: string; accessUrl: string }>((resolve, reject) => {
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += String(chunk); const url = output.match(/"url":"([^"]+)"/); const access = output.match(/"accessUrl":"([^"]+)"/); if (url && access) resolve({ url: url[1]!, accessUrl: access[1]! }); });
    child.stderr.on('data', chunk => { error += String(chunk); }); child.on('error', reject); child.on('exit', code => reject(new Error(`Host exited ${code}: ${error}`)));
  }), { timeout: 5000 });
  return { ...info, async close() { await test.step('Stop the actual Host and release its data directory', async () => { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); }, { timeout: 5000 }); } };
}

test('a printed token link authorizes the browser, cleans the URL, survives reload and durably exits without an input form', async ({ page, context }) => {
  const host = await launch(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.url); await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible(); await expect(page.getByRole('textbox')).toHaveCount(0);
    expect((await page.goto(`${host.url}/?token=wrong`))!.status()).toBe(401);
    await page.goto(host.accessUrl); await expect(page).toHaveURL(`${host.url}/`); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    expect((await context.cookies()).find(cookie => cookie.name.startsWith('aork_dev_session-'))).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });
    expect(await page.evaluate(() => document.cookie)).toBe('');
    await page.reload(); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    await page.getByRole('button', { name: '退出访问', exact: true }).click(); await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { try { await page.goto('about:blank'); } finally { await host.close(); } }
});

test('revocation stops protected polling and clears cached query results before the selected access UI returns', async ({ page, context }) => {
  const host = await launch(async distribution => {
    const path = join(distribution, 'plugins/workbench/0.1.0/client.js'); const source = await readFile(path, 'utf8');
    const view = `function Home({runtime}) { const [value,setValue]=useState('waiting'); useEffect(()=>{let active=true;runtime.query('fixture.cache',{cache:'prefer-cache'}).then(value=>{if(active)setValue('Cache '+value)}).catch(()=>{});return()=>{active=false}},[runtime]);useEffect(()=>runtime.subscribe('fixture.stream',{next:()=>{}},{intervalMs:250}),[runtime]);return jsx('h1',{children:value})}function activate`;
    await writeFile(path, `import {useState,useEffect} from 'react';\n` + source.replace(/function Home\([^)]*\)\{.*?\}function activate/, view));
    const serverPath = join(distribution, 'plugins/workbench/0.1.0/server.js'); await writeFile(serverPath, (await readFile(serverPath, 'utf8')).replace(/function activate\(([^)]+)\)\s*\{/, (match, context: string) => `${match}let reads=0;${context}.query('fixture.cache',{access:'authenticated',execute:()=>++reads});${context}.query('fixture.stream',{access:'authenticated',execute:()=>true});`));
  });
  try {
    await page.goto(host.accessUrl); await expect(page.getByRole('heading', { name: 'Cache 1' })).toBeVisible();
    const other = await context.newPage(); await other.goto(host.url); await expect(other.getByRole('heading', { name: 'Cache 2' })).toBeVisible(); await other.getByRole('button', { name: '退出访问', exact: true }).click();
    await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible({ timeout: 8000 }); await other.close();
    let afterLoss = 0; page.on('request', request => { if (request.url().includes('/api/queries/fixture.stream')) afterLoss++; });
    await page.waitForResponse(response => response.url().includes('/api/queries/auth.status')); expect(afterLoss).toBe(0);
    expect((await context.request.get(host.accessUrl, { maxRedirects: 0 })).status()).toBe(303);
    await page.getByRole('button', { name: '重新检查访问权限' }).click(); await expect(page.getByRole('heading', { name: 'Cache 3' })).toBeVisible();
  } finally { try { await page.goto('about:blank'); } finally { await host.close(); } }
});

test('an access renderer failure cannot revoke a valid browser or grant anonymous business access', async ({ page, context, browser }) => {
  const host = await launch(async distribution => {
    const path = join(distribution, 'plugins/auth-single-user/0.1.0/client.js'); await writeFile(path, (await readFile(path, 'utf8')).replace(/function Login\([^)]*\)\s*\{/, '$& throw new Error("private-render-error");'));
  });
  const anonymous = await browser.newContext();
  try {
    await page.goto(host.accessUrl); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    const other = await anonymous.newPage(); await other.goto(host.url); await expect(other.getByText('UI_RENDER_FAILED')).toBeVisible(); await expect(other.getByText('pnpm aork doctor --data-dir <data-directory>')).toBeVisible();
    expect((await anonymous.request.get(`${host.url}/api/queries/workbench.overview`)).status()).toBe(401); expect((await context.request.get(`${host.url}/api/queries/workbench.overview`)).status()).toBe(200);
  } finally { await anonymous.close(); try { await page.goto('about:blank'); } finally { await host.close(); } }
});

test('profile-selected alternative access rendering preserves the token and logout server rules', async ({ page }) => {
  const host = await launch(async distribution => {
    const manifestPath = join(distribution, 'plugins/auth-single-user/0.1.0/aork.plugin.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.ui.providers.push({ id: 'alternative', contract: 'aork.auth.login@1' }); await writeFile(manifestPath, JSON.stringify(manifest));
    const profilePath = join(distribution, 'profiles/personal-server.json'); const profile = JSON.parse(await readFile(profilePath, 'utf8')); profile.ui.providers['aork.auth.login@1'] = 'auth-single-user:alternative'; await writeFile(profilePath, JSON.stringify(profile));
    const path = join(distribution, 'plugins/auth-single-user/0.1.0/client.js'); await writeFile(path, (await readFile(path, 'utf8')).replace(/function activate\(([^)]+)\)\s*\{/, (match, context: string) => `${match}${context}.registerView('alternative',props=>jsxs('div',{children:[jsx('h2',{children:'替代访问提供者'}),jsx(Login,props)]}));`));
  });
  try {
    await page.goto(host.url); await expect(page.getByRole('heading', { name: '替代访问提供者' })).toBeVisible(); await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.goto(host.accessUrl); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible(); await page.getByRole('button', { name: '退出访问' }).click(); await expect(page.getByRole('heading', { name: '替代访问提供者' })).toBeVisible();
  } finally { try { await page.goto('about:blank'); } finally { await host.close(); } }
});

for (const path of ['/api/queries/auth.status', '/api/bootstrap']) {
  test(`a delayed anonymous ${path} response cannot overwrite a newer token authorization`, async ({ page, context }) => {
    const host = await launch(); let release!: () => void; let ready!: () => void; let rejectReady!: (error: unknown) => void; let issuedCookie = false; let other: Page | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    try {
      await page.goto(host.url); await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toBeVisible(); let held = false;
      await page.route(`**${path}`, async route => {
        if (held) { await route.continue(); return; } held = true;
        try {
          const response = await fetch(route.request().url(), { headers: await route.request().allHeaders() }); const body = await response.text(); issuedCookie = response.headers.has('set-cookie'); ready(); await gate;
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
        } catch (error) { rejectReady(error); await route.abort().catch(() => {}); }
      });
      const oldResponse = page.evaluate(path => fetch(path).then(response => response.json()), path);
      await test.step('Intercept the deliberate anonymous request', () => pending, { timeout: 5000 }); expect(issuedCookie).toBe(false);
      other = await context.newPage(); await other.goto(host.accessUrl); await expect(other).toHaveURL(`${host.url}/`); await expect(other.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
      release(); await test.step('Deliver the delayed anonymous response', () => oldResponse, { timeout: 5000 });
      expect((await context.request.get(`${host.url}/api/queries/workbench.overview`)).status()).toBe(200); await page.reload(); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    } finally { release(); try { await other?.close(); await page.unrouteAll({ behavior: 'wait' }); await page.goto('about:blank'); } finally { await host.close(); } }
  });
}

test('a delayed logout response cannot erase a later token exchange cookie', async ({ page, context }) => {
  const host = await launch(); let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { ready = resolve; });
  try {
    await page.goto(host.accessUrl); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible();
    await page.route('**/api/commands/auth.logout', async route => {
      const request = route.request(); const response = await fetch(request.url(), { method: 'POST', headers: await request.allHeaders(), body: request.postData()! }); const body = await response.text(); expect(response.headers.has('set-cookie')).toBe(false); ready(); await gate;
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });
    await page.getByRole('button', { name: '退出访问' }).click(); await pending;
    expect((await context.request.get(host.accessUrl, { maxRedirects: 0 })).status()).toBe(303);
    const arrived = page.waitForResponse(response => response.url().includes('/api/commands/auth.logout')); release(); await arrived;
    await page.reload(); await expect(page.getByRole('heading', { name: '项目与工作区' })).toBeVisible(); expect((await context.request.get(`${host.url}/api/queries/workbench.overview`)).status()).toBe(200);
  } finally { release(); try { await page.unrouteAll({ behavior: 'wait' }); await page.goto('about:blank'); } finally { await host.close(); } }
});

test('a delayed protected rejection cannot clear a newer confirmed authorization', async ({ page, context }) => {
  const host = await launch(async distribution => {
    const path = join(distribution, 'plugins/workbench/0.1.0/client.js'); const source = await readFile(path, 'utf8');
    const view = `function Home({runtime}) {const [value,setValue]=useState('授权视图');const [complete,setComplete]=useState(false);return jsxs('section',{children:[jsx('h1',{children:value}),jsx('output',{children:complete?'旧查询已结束':''}),jsx('button',{children:'查询受保护内容',onClick:()=>{runtime.query('workbench.overview').catch(()=>setComplete(true))}}),jsx('button',{children:'检查新授权',onClick:()=>{runtime.refreshAccess().then(()=>setValue('新授权已确认')).catch(()=>{})}})]})}function activate`;
    await writeFile(path, `import {useState} from 'react';\n` + source.replace(/function Home\([^)]*\)\{.*?\}function activate/, view));
  });
  let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { ready = resolve; });
  try {
    await page.goto(host.accessUrl); await expect(page.getByRole('heading', { name: '授权视图' })).toBeVisible();
    const bootstrap = await (await context.request.get(`${host.url}/api/bootstrap`)).json();
    const logout = await context.request.post(`${host.url}/api/commands/auth.logout`, { headers: { Origin: host.url, 'X-Aork-CSRF': bootstrap.access.csrfToken }, data: { apiVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: bootstrap.pluginGraphHash, payload: {} } }); expect(logout.status()).toBe(200);
    await page.route('**/api/queries/workbench.overview', async route => {
      const response = await fetch(route.request().url(), { headers: await route.request().allHeaders() }); const body = await response.text(); expect(response.status).toBe(401); ready(); await gate; await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });
    await page.getByRole('button', { name: '查询受保护内容' }).click(); await pending;
    expect((await context.request.get(host.accessUrl, { maxRedirects: 0 })).status()).toBe(303);
    await page.getByRole('button', { name: '检查新授权' }).click(); await expect(page.getByRole('heading', { name: '新授权已确认' })).toBeVisible();
    release(); await expect(page.getByText('旧查询已结束')).toBeVisible(); await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole('heading', { name: '新授权已确认' })).toBeVisible(); await expect(page.getByRole('heading', { name: '需要工作台访问链接' })).toHaveCount(0);
  } finally { release(); try { await page.unrouteAll({ behavior: 'wait' }); await page.goto('about:blank'); } finally { await host.close(); } }
});
