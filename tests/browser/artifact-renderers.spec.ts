import { expect, test, type Page } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from '../fixtures/session-host.js';

/** Independently authored renderer contributions installed as a real plugin: a working markdown renderer and a deliberately failing csv renderer. */
const manifest = (ids: Array<{ id: string; mediaType: string }>) => JSON.stringify({ manifestVersion: 1, id: 'artifact-renderer-fixture', version: '0.1.0', sdkRange: '^0.1.0', client: 'client.js', ui: { providers: ids.map(entry => ({ id: entry.id, contract: 'aork.artifacts.renderer@1', mimeTypes: [entry.mediaType] })) } });
const client = (working: boolean) => [
  "import { createElement, useEffect, useState } from 'react';",
  'export function activate(context) {',
  ...(working ? [
    "  context.registerView('markdown', ({ runtime, context: value }) => {",
    '    const [text, setText] = useState("");',
    '    useEffect(() => { let live = true; void runtime.resource("artifacts.preview", { versionId: value.versionId }).then(result => { if (live) setText(JSON.parse(new TextDecoder().decode(result.bytes)).text ?? "fixture-no-text"); }, () => { if (live) setText("fixture-renderer-failed"); }); return () => { live = false; }; }, [value.versionId]);',
    '    return createElement("section", { "aria-label": "受限 Markdown 预览" }, createElement("h4", null, "独立 Markdown 渲染器"), createElement("pre", null, text));',
    '  });',
  ] : ["  context.registerView('markdown', () => createElement('p', null, 'unused'));"]),
  ...(working ? [] : ["  context.registerView('failing', () => { throw new Error('fixture renderer failure'); });"]),
  '}',
].join('\n');
async function installFixture(distributionDir: string, providers: Array<{ id: string; mediaType: string }>, working: boolean) {
  const directory = join(distributionDir, 'plugins/artifact-renderer-fixture/0.1.0'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'aork.plugin.json'), manifest(providers));
  await writeFile(join(directory, 'client.js'), client(working));
}
const hostile = [
  '<!doctype html><html><head><title>hostile</title></head><body><p>hostile preview content</p><script>',
  'const results=[];',
  "try{results.push('cookie='+(document.cookie===''?'EMPTY':document.cookie));}catch(e){results.push('cookie=THREW');}",
  "try{results.push('storage='+localStorage.getItem('probe'));}catch(e){results.push('storage=THREW');}",
  "fetch('/api/queries/sessions.overview',{credentials:'include'}).then(r=>results.push('fetch='+r.status),()=>results.push('fetch=BLOCKED'));",
  "try{top.location='https://example.invalid/';results.push('topnav=ALLOWED');}catch(e){results.push('topnav=THREW');}",
  "function report(){document.body.setAttribute('data-probe',results.join('|'));}",
  'setTimeout(report,800);report();',
  '</script></body></html>',
].join('');
async function registerFromWorkspace(page: Page, env: Awaited<ReturnType<typeof sessionEnvironment>>, path: string, title: string) {
  await page.evaluate(([workspace, file]) => { location.hash = new URLSearchParams({ workspace, file }).toString(); }, [env.workspace.id, path]);
  await page.getByLabel('更多菜单').click(); await page.getByRole('button', { name: '保存当前文件版本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存产物版本' }); await dialog.getByLabel('产物名称').fill(title);
  await dialog.getByRole('button', { name: '登记版本', exact: true }).click();
  return page.getByRole('dialog', { name: '已保存版本' });
}

test('active HTML renders in a restricted frame that cannot read workbench credentials or act for the user', async ({ page }) => {
  const f = await sessionHost();
  try {
    const env = await sessionEnvironment(f);
    await writeFile(join(env.workspace.directory, 'hostile.html'), hostile);
    await page.goto(f.host.accessUrl!);
    const saved = await registerFromWorkspace(page, env, 'hostile.html', 'Hostile page');
    await expect(saved.getByRole('region', { name: '产物预览' })).toContainText('不可变文件副本 · text/html', { timeout: 15000 });
    const frame = page.locator('iframe[title="主动内容受限预览"]');
    await expect(frame).toBeVisible();
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(await frame.getAttribute('srcdoc')).toContain('hostile preview content');
    await expect(page.frameLocator('iframe[title="主动内容受限预览"]').getByText('hostile preview content')).toBeVisible();
    const probe = page.frames().find(candidate => candidate.url() === 'about:srcdoc')!;
    await expect.poll(async () => probe.locator('body').getAttribute('data-probe'), { timeout: 15000 }).toContain('fetch=');
    const reported = (await probe.locator('body').getAttribute('data-probe'))!;
    expect(reported).toMatch(/cookie=(EMPTY|THREW)/);
    expect(reported).toContain('storage=THREW');
    expect(reported).toContain('fetch=BLOCKED');
    expect(reported).toContain('topnav=THREW');
    expect(await page.evaluate(async () => (await fetch('/api/queries/artifacts.maintenance', { credentials: 'same-origin' })).status)).toBe(200);
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('a failing renderer and an unknown binary format keep file information and authorized download while other views stay usable', async ({ page }) => {
  const f = await sessionHost(false, async ({ distributionDir, profile }) => {
    await installFixture(distributionDir, [{ id: 'markdown', mediaType: 'text/markdown' }, { id: 'failing', mediaType: 'text/csv' }], false);
    profile.plugins.push({ id: 'artifact-renderer-fixture', version: '0.1.0', enabled: true });
  });
  try {
    const env = await sessionEnvironment(f);
    await writeFile(join(env.workspace.directory, 'table.csv'), 'a,b\n1,2\n');
    await writeFile(join(env.workspace.directory, 'blob.dat'), `${String.fromCharCode(0)}binary payload`);
    await page.goto(f.host.accessUrl!);
    const saved = await registerFromWorkspace(page, env, 'table.csv', 'Failing table');
    const preview = saved.getByRole('region', { name: '产物预览' });
    await expect(preview).toContainText('此格式的渲染器当前不可用；文件信息和下载保持可用。', { timeout: 15000 });
    await expect(preview).toContainText('table.csv');
    await expect(saved.getByLabel('产物版本')).toBeVisible();
    await expect(saved.getByRole('region', { name: '产物列表' })).toBeVisible();
    const download = page.waitForEvent('download'); await preview.getByRole('button', { name: '下载此版本' }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe('a,b\n1,2\n');
    await saved.getByRole('button', { name: '关闭产物' }).click();
    const binary = await registerFromWorkspace(page, env, 'blob.dat', 'Unknown binary');
    const binaryPreview = binary.getByRole('region', { name: '产物预览' });
    await expect(binaryPreview).toContainText('此格式无法基础文本预览；文件信息和下载始终可用。', { timeout: 15000 });
    await expect(binaryPreview).toContainText('blob.dat');
    const binaryDownload = page.waitForEvent('download'); await binaryPreview.getByRole('button', { name: '下载此版本' }).click();
    expect(await readFile((await (await binaryDownload).path())!, 'utf8')).toBe(`${String.fromCharCode(0)}binary payload`);
  } finally { await page.goto('about:blank'); await f.close(); }
});

test('an installed renderer is selected by media type, falls back after deactivation and keeps versions accessible across restart', async ({ page }) => {
  const f = await sessionHost(false, async ({ distributionDir, profile }) => {
    await installFixture(distributionDir, [{ id: 'markdown', mediaType: 'text/markdown' }], true);
    profile.plugins.push({ id: 'artifact-renderer-fixture', version: '0.1.0', enabled: true });
  });
  try {
    const env = await sessionEnvironment(f);
    await writeFile(join(env.workspace.directory, 'notes.md'), '# 项目纪要');
    await page.goto(f.host.accessUrl!);
    const saved = await registerFromWorkspace(page, env, 'notes.md', 'Notes');
    await expect(saved.getByRole('region', { name: '受限 Markdown 预览' })).toContainText('# 项目纪要', { timeout: 15000 });
    await saved.getByRole('button', { name: '关闭产物' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('配置插件', { exact: true }).selectOption('artifact-renderer-fixture@0.1.0');
    await page.getByRole('button', { name: '停用 artifact-renderer-fixture' }).click();
    await page.waitForLoadState('networkidle');
    await page.reload();
    await page.getByLabel('更多菜单').click(); await page.getByRole('button', { name: '已保存版本', exact: true }).click();
    const fallback = page.getByRole('dialog', { name: '已保存版本' }).getByRole('region', { name: '产物预览' });
    await expect(fallback).toContainText('# 项目纪要', { timeout: 15000 });
    await expect(fallback.getByRole('region', { name: '受限 Markdown 预览' })).toHaveCount(0);
    const download = page.waitForEvent('download'); await fallback.getByRole('button', { name: '下载此版本' }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe('# 项目纪要');
    await f.restart(); await page.reload();
    await page.getByLabel('更多菜单').click(); await page.getByRole('button', { name: '已保存版本', exact: true }).click();
    const afterRestart = page.getByRole('dialog', { name: '已保存版本' }).getByRole('region', { name: '产物预览' });
    await expect(afterRestart).toContainText('# 项目纪要', { timeout: 15000 });
    const again = page.waitForEvent('download'); await afterRestart.getByRole('button', { name: '下载此版本' }).click();
    expect(await readFile((await (await again).path())!, 'utf8')).toBe('# 项目纪要');
  } finally { await page.goto('about:blank'); await f.close(); }
});
