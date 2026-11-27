import { expect, test } from '@playwright/test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handoffHost } from '../fixtures/context-handoff.js';

const wire = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a registered artifact version is reused as input in the same session through the composer', async ({ page }) => {
  test.setTimeout(150000);
  const host = await handoffHost();
  try {
    const { f, env } = host;
    await writeFile(join(env.workspace.directory, 'result.md'), 'browser reusable artifact bytes');
    const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Browser report', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'result.md' } })).json()).result;
    await page.goto(f.host.accessUrl!);
    await page.evaluate(values => { location.hash = new URLSearchParams({ workspace: values.workspaceId }).toString(); }, { workspaceId: env.workspace.id });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const create = page.getByRole('region', { name: '新建会话', exact: true });
    await create.getByLabel('会话名称').fill('Reuse session');
    await create.getByLabel('工作区').selectOption({ index: 1 });
    await create.getByLabel('Agent Profile').selectOption({ label: 'Research Agent · Controlled Agent' });
    await create.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByText('运行已就绪')).toBeVisible({ timeout: 20000 });
    await page.getByText('添加产物版本作为输入').click();
    await page.getByLabel('输入产物选择').selectOption({ label: 'Browser report（1 个版本）' });
    await page.getByRole('button', { name: '添加产物版本' }).click();
    await expect(page.getByLabel('会话输入')).toContainText(`产物版本 ${artifact.versionId}`);
    await page.getByPlaceholder('描述你想完成的工作…').fill('Continue from the saved version.');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('会话消息')).toContainText('Continue from the saved version.');
    await expect(page.getByLabel('会话消息')).toContainText(`产物版本 ${artifact.versionId}`);
    const overview = await (await f.query()).json();
    const sessionId = overview.sessions[0].session.id;
    const readTimeline = () => fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${sessionId}`, { headers: { Cookie: f.cookie } }).then(value => value.json());
    let timeline: any;
    for (let attempt = 0; attempt < 200; attempt++) { timeline = await readTimeline(); if (timeline.turns?.[0]?.attachments) break; await page.waitForTimeout(50); }
    expect(timeline.turns[0].attachments).toEqual([{ artifactVersionId: artifact.versionId, kind: 'text', size: 31, sha256: timeline.turns[0].attachments[0].sha256 }]);
    const prompts = (await wire(join(f.directory, 'agent-a-wire'))).filter(value => value.method === 'session/prompt');
    expect(prompts.at(-1)!.params.prompt).toEqual([
      { type: 'text', text: 'Continue from the saved version.' },
      { type: 'resource', resource: { uri: `aork-artifact://version/${artifact.versionId}`, mimeType: 'text/plain', text: 'browser reusable artifact bytes' } },
    ]);
  } finally { await page.goto('about:blank'); await host.f.close(); }
});

test('handing off to another Provider creates a linked session with explicit carry, from history without native recovery', async ({ page }) => {
  test.setTimeout(150000);
  const host = await handoffHost();
  try {
    const { f, env } = host;
    await writeFile(join(env.workspace.directory, 'handoff-notes.md'), 'notes to carry across providers');
    const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Carried study', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'handoff-notes.md' } })).json()).result;
    await page.goto(f.host.accessUrl!);
    await page.evaluate(values => { location.hash = new URLSearchParams({ workspace: values.workspaceId }).toString(); }, { workspaceId: env.workspace.id });
    // A session on the alternate provider, which never supports native session loading.
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const create = page.getByRole('region', { name: '新建会话', exact: true });
    await create.getByLabel('会话名称').fill('Alternate history');
    await create.getByLabel('工作区').selectOption({ index: 1 });
    await create.getByLabel('Agent Profile').selectOption({ label: 'Alternate Agent Profile · Alternate Agent' });
    await create.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByText('运行已就绪')).toBeVisible({ timeout: 20000 });
    await page.getByPlaceholder('描述你想完成的工作…').fill('Work that cannot be natively recovered');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await page.getByLabel('更多菜单').click();
    await page.getByRole('button', { name: '结束运行' }).click();
    await expect(page.getByText('运行已结束')).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('原生会话恢复')).toContainText('未声明原生会话加载能力');
    // A stale file reference is rejected with a correctable error and creates no Session.
    await page.getByRole('button', { name: '交接到新会话…' }).click();
    const dialog = page.getByRole('dialog', { name: '交接新会话' });
    await dialog.getByLabel('目标 Agent Profile（可换 Agent Provider）').selectOption({ label: 'Research Agent · Controlled Agent' });
    await dialog.getByLabel('携带摘要（将成为新会话的第一条输入文本）').fill('We stopped on the alternate agent; continue here.');
    await dialog.getByRole('button', { name: '查找来源工作区文件' }).click();
    // The file search fills the select asynchronously; poll for the known file.
    const fileSelect = dialog.getByLabel('携带文件选择');
    let notes: string | undefined;
    await expect.poll(async () => {
        notes = (await fileSelect.locator('option').allTextContents()).find(option => option.includes('handoff-notes.md'));
        return notes;
    }, { timeout: 10_000 }).toBeTruthy();
    await dialog.getByLabel('携带文件选择').selectOption({ label: notes! });
    await dialog.getByLabel('携带产物选择').selectOption({ label: 'Carried study（1 个版本）' });
    await unlink(join(env.workspace.directory, 'handoff-notes.md'));
    await dialog.getByRole('button', { name: '创建关联新会话' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 20000 });
    expect((await (await f.query()).json()).sessions).toHaveLength(1);
    // Correct the reference: drop the stale file, keep summary and artifact version.
    await dialog.getByRole('button', { name: '移除', exact: true }).click();
    await dialog.getByRole('button', { name: '创建关联新会话' }).click();
    await expect(page.getByRole('heading', { name: '交接自 Alternate history' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('会话关联')).toContainText('关联自会话 Alternate history');
    await expect(page.getByLabel('会话关联')).toContainText('上下文交接不是原生恢复');
    await expect(page.getByLabel('会话关联')).toContainText('待发送的交接上下文');
    await expect(page.getByLabel('会话关联')).toContainText('产物版本 1 · handoff-notes.md');
    await expect(page.getByRole('button', { name: '发送交接上下文' })).toBeDisabled();
    await page.getByRole('button', { name: '启动运行' }).click();
    await expect(page.getByText('运行已就绪')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: '发送交接上下文' }).click();
    await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('会话消息')).toContainText('We stopped on the alternate agent; continue here.');
    await expect(page.getByLabel('会话消息')).toContainText(`产物版本 ${artifact.versionId}`);
    const overview = await (await f.query()).json();
    expect(overview.sessions).toHaveLength(2);
    const linked = overview.sessions.find((item: any) => item.session.linkedFrom);
    const sourceEntry = overview.sessions.find((item: any) => item.session.id === linked.session.linkedFrom.sessionId);
    expect(sourceEntry.linkedTo).toEqual([{ sessionId: linked.session.id }]);
    // The old session keeps its own readable history and received no native load anywhere.
    const oldTimeline = await (await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${sourceEntry.session.id}`, { headers: { Cookie: f.cookie } })).json();
    expect(oldTimeline.messages.filter((message: any) => message.role === 'user').map((message: any) => message.text)).toEqual(['Work that cannot be natively recovered']);
    const wireA = await wire(join(f.directory, 'agent-a-wire'));
    expect(wireA.filter(value => value.method === 'session/load')).toHaveLength(0);
    const prompts = wireA.filter(value => value.method === 'session/prompt');
    expect(prompts.at(-1)!.params.prompt).toEqual([
      { type: 'text', text: 'We stopped on the alternate agent; continue here.' },
      { type: 'resource', resource: { uri: `aork-artifact://version/${artifact.versionId}`, mimeType: 'text/plain', text: 'notes to carry across providers' } },
    ]);
  } finally { await page.goto('about:blank'); await host.f.close(); }
});
