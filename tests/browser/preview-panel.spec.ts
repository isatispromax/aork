import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from '../fixtures/session-host.js';
import { openWorkbench } from '../fixtures/workbench-host.js';
import { openPanel } from '../fixtures/right-region.js';

/** The frame policy a rendered Workspace page runs under (plugins/preview/src/client.tsx). */
const PREVIEW_PAGE_SANDBOX = 'allow-scripts';

/** Files of every kind the panel shows differently. */
async function writeFiles(directory: string): Promise<void> {
  await writeFile(join(directory, 'notes.md'), '# 项目纪要\n\n这是一段 **正文**，带 [相对链接](detail.md) 和 [外部链接](https://example.com/)。\n\n<script>window.__previewScript = 1</script>\n');
  await writeFile(join(directory, 'detail.md'), '# 细节\n\n第二篇。\n');
  await writeFile(join(directory, 'main.ts'), 'const answer: number = 42;\nexport default answer;\n');
  // Reports where it runs and whether it could reach the workbench's cookies.
  await writeFile(join(directory, 'page.html'), '<!doctype html><html><head><title>预览页</title></head><body><h1>网页预览</h1><script>var cookie;try{cookie=document.cookie?"cookies":"none"}catch(e){cookie="denied"}document.body.dataset.origin=location.origin;document.body.dataset.cookie=cookie;</script></body></html>');
  await writeFile(join(directory, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  await writeFile(join(directory, 'photo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(join(directory, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
  // Bytes that are not text, under a suffix that claims nothing.
  await writeFile(join(directory, 'blob.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x23, 0x20, 0x41]));
}

/** Selects a Session of the environment in the page, with any extra hash keys. */
function show(page: Page, env: { workspace: { id: string } }, sessionId: string, extra: Record<string, string> = {}) {
  return page.evaluate(({ workspace, session, extra }) => { location.hash = new URLSearchParams({ workspace, session, ...extra }).toString(); }, { workspace: env.workspace.id, session: sessionId, extra });
}

/** Counts the reads of each Workspace file the page asks for. */
function readsOf(page: Page): Record<string, number> {
  const reads: Record<string, number> = {};
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/resources/workspace.file') reads[url.searchParams.get('path') ?? ''] = (reads[url.searchParams.get('path') ?? ''] ?? 0) + 1;
  });
  return reads;
}

test('the preview panel shows a Workspace file for what it is, opened from the Files panel or a link, once per file', async ({ page }) => {
  const f = await sessionHost();
  try {
    await page.setViewportSize({ width: 1440, height: 940 });
    const { env, session } = await openWorkbench(f, 'Preview');
    await writeFiles(env.workspace.directory);
    await page.goto(f.host.accessUrl);
    await show(page, env, session.id);
    const reads = readsOf(page);
    const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
    const chips = right.getByRole('tablist').getByRole('tab');
    const chipFor = (title: string | RegExp) => right.getByRole('tablist').getByRole('tab', { name: title });
    const panel = right.getByRole('region', { name: '文档预览', exact: true });

    // The Files panel offers a preview where a panel type declares it opens files, and none for a file nothing can render.
    await openPanel(page, '文件');
    const files = right.getByRole('region', { name: '工作区文件', exact: true });
    await files.getByRole('button', { name: /archive\.zip/ }).click();
    await expect(files.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
    await files.getByRole('button', { name: /notes\.md/ }).click();
    await files.getByRole('button', { name: '预览', exact: true }).click();

    // Markdown is rendered, named by its file, with its active content taken out.
    await expect(chips).toHaveCount(2);
    await expect(chipFor(/notes\.md/)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('article h1')).toHaveText('项目纪要');
    await expect(panel.locator('article strong')).toHaveText('正文');
    await expect(panel.locator('article script')).toHaveCount(0);
    expect(await page.evaluate(() => '__previewScript' in window)).toBe(false);
    await expect(panel.getByRole('link', { name: '外部链接' })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(panel.getByRole('link', { name: '外部链接' })).toHaveAttribute('target', '_blank');

    // The same file can be read as its source, chosen from the ways it can be shown.
    await panel.getByLabel('打开方式', { exact: true }).selectOption('源码');
    await expect(panel.locator('[data-preview-code="markdown"]')).toContainText('# 项目纪要');
    // The gutter is the one thing in the source that is hidden from assistive technology.
    await expect(panel.locator('[data-preview-code="markdown"] [aria-hidden="true"]')).toHaveText(['1', '2', '3', '4', '5']);
    await panel.getByLabel('打开方式', { exact: true }).selectOption('Markdown');
    await expect(panel.locator('article h1')).toHaveText('项目纪要');

    // A link to another Workspace file opens that file in a tab of its own.
    await panel.getByRole('link', { name: '相对链接' }).click();
    await expect(chips).toHaveCount(3);
    await expect(panel.locator('article h1')).toHaveText('细节');

    // Coming back to a tab shows what it read before; only 重新读取 reads the file again.
    await chipFor(/notes\.md/).click();
    await expect(panel.locator('article h1')).toHaveText('项目纪要');
    expect(reads['notes.md']).toBe(1);
    await panel.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect.poll(() => reads['notes.md']).toBe(2);

    // A link that names a file opens its preview the same way the Files panel does.
    await show(page, env, session.id, { preview: 'main.ts' });
    await expect(chips).toHaveCount(4);
    await expect(chipFor(/main\.ts/)).toHaveAttribute('aria-selected', 'true');
    const code = panel.locator('[data-preview-code="typescript"]');
    await expect(code).toContainText('const answer: number = 42;');
    await expect(code.locator('[aria-hidden="true"]')).toHaveText(['1', '2']);
    await expect(panel.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await panel.getByRole('button', { name: '自动换行', exact: true }).click();
    await expect(panel.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // The file is handed over as it is.
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('main.ts');

    // A link to a file that is already open brings its tab forward rather than opening it twice.
    await chipFor(/notes\.md/).click();
    await show(page, env, session.id, { preview: 'detail.md' });
    await expect(chips).toHaveCount(4);
    await expect(chipFor(/detail\.md/)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('article h1')).toHaveText('细节');
  }
  finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});

test('the preview panel renders a page only in its sandbox, shows bytes as what they are, and names a file it cannot preview without reading it', async ({ page }) => {
  const f = await sessionHost();
  try {
    await page.setViewportSize({ width: 1440, height: 940 });
    const { env, session } = await openWorkbench(f, 'Preview forms');
    await writeFiles(env.workspace.directory);
    await page.goto(f.host.accessUrl);
    await show(page, env, session.id);
    const reads = readsOf(page);
    const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
    const panel = right.getByRole('region', { name: '文档预览', exact: true });

    // HTML runs as a page in a frame that keeps its scripts and nothing of the workbench's origin.
    await show(page, env, session.id, { preview: 'page.html' });
    await expect(panel).toHaveAttribute('data-preview-form', 'html');
    const frame = panel.locator('[data-preview-frame="page"]');
    await expect(frame).toHaveAttribute('sandbox', PREVIEW_PAGE_SANDBOX);
    const shown = page.frameLocator('[data-preview-frame="page"]');
    await expect(shown.getByRole('heading', { name: '网页预览' })).toBeVisible();
    await expect(shown.locator('body')).toHaveAttribute('data-origin', 'null');
    await expect(shown.locator('body')).toHaveAttribute('data-cookie', 'denied');
    await panel.getByLabel('打开方式', { exact: true }).selectOption('源码');
    await expect(panel.locator('[data-preview-code="xml"]')).toContainText('<!doctype html>');

    // An image is drawn from its bytes, under the type its suffix names.
    await show(page, env, session.id, { preview: 'logo.svg' });
    await expect(panel).toHaveAttribute('data-preview-form', 'image');
    await expect.poll(() => panel.locator('[data-preview-image]').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(8);
    await show(page, env, session.id, { preview: 'photo.png' });
    await expect.poll(() => panel.locator('[data-preview-image]').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);

    // A file nothing can render is named and offered for download; not one byte of it is read.
    await show(page, env, session.id, { preview: 'archive.zip' });
    await expect(panel).toHaveAttribute('data-preview-form', 'none');
    await expect(panel.getByRole('status')).toHaveText('该格式文件暂时无法预览');
    await expect(panel.getByRole('button', { name: '重新读取', exact: true })).toHaveCount(0);
    expect(reads['archive.zip']).toBeUndefined();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('archive.zip');

    // Bytes that are not text are not passed off as a source file.
    await show(page, env, session.id, { preview: 'blob.dat' });
    await expect(panel.getByRole('status')).toHaveText('这个文件不是 UTF-8 文本，无法这样预览；请下载查看。');
  }
  finally { await page.goto('about:blank').catch(() => { }); await f.close(); }
});
