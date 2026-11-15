import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { sessionHost } from '../fixtures/session-host.js';
import { answer, formRequest, inputWire, startStructured, structuredAgent, structuredHost } from '../fixtures/structured-host.js';
async function show(page: Page, f: Awaited<ReturnType<typeof sessionHost>>, session: {
    id: string;
    projectId: string;
    workspaceId: string;
}) { await page.goto(f.host.accessUrl); await page.evaluate(session => { location.hash = new URLSearchParams({ session: session.id, project: session.projectId, workspace: session.workspaceId }).toString(); }, session); }
test('default work form validates fields, reloads its live request, and sends reviewed content at 390px', async ({ browser }) => {
    const f = await sessionHost();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
        const { env, session } = await startStructured(f);
        const page = await context.newPage();
        await show(page, f, session);
        const form = page.getByRole('form', { name: '结构化输入表单', exact: true });
        await expect(form.getByLabel('Topic', { exact: true })).toBeVisible();
        await form.getByLabel('Topic', { exact: true }).fill('x');
        await form.getByRole('button', { name: '发送信息', exact: true }).click();
        await expect(form.getByText('长度须为 3–20 个字符', { exact: true })).toBeVisible();
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toHaveLength(0);
        await page.reload();
        await expect(form.getByLabel('Topic', { exact: true })).toBeVisible();
        await form.getByLabel('Topic', { exact: true }).fill(answer.topic);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: '/tmp/aork-ticket16-form-mobile.png', fullPage: true });
        await form.getByRole('button', { name: '发送信息', exact: true }).click();
        await expect(page.getByText('已发送响应', { exact: true })).toBeVisible();
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result).map(value => value.result)).toEqual([{ action: 'accept', content: answer }]);
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('two real browser contexts submit competing form actions and only one native action wins', async ({ browser }) => {
    const f = await sessionHost();
    const contexts = [await browser.newContext(), await browser.newContext()];
    try {
        const { env, session } = await startStructured(f);
        const pages = await Promise.all(contexts.map(context => context.newPage()));
        await Promise.all(pages.map(page => show(page, f, session)));
        const forms = pages.map(page => page.getByRole('form', { name: '结构化输入表单', exact: true }));
        await Promise.all(forms.map(form => form.getByLabel('Topic', { exact: true }).fill(answer.topic)));
        let release!: () => void;
        const both = new Promise<void>(resolve => release = resolve);
        let count = 0;
        const statuses: number[] = [];
        await Promise.all(pages.map(page => page.route('**/api/commands/interactions.submit', async (route) => { if (++count === 2)
            release(); await both; await route.continue(); })));
        pages.forEach(page => page.on('response', response => { if (response.url().endsWith('/api/commands/interactions.submit'))
            statuses.push(response.status()); }));
        await Promise.all([forms[0]!.getByRole('button', { name: '发送信息', exact: true }).click(), forms[1]!.getByRole('button', { name: '拒绝提供', exact: true }).click()]);
        await expect.poll(() => statuses.sort()).toEqual([200, 409]);
        await Promise.all(pages.map(page => expect(page.getByText('已发送响应', { exact: true })).toBeVisible()));
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toHaveLength(1);
    }
    finally {
        await Promise.all(contexts.map(context => context.close()));
        await f.close();
    }
});
test('a dropped accepted form reply retains the same command receipt retry, and cancelling a live form disables stale fields', async ({ browser }) => {
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const { env, session } = await startStructured(f);
        const page = await context.newPage();
        await show(page, f, session);
        const form = page.getByRole('form', { name: '结构化输入表单', exact: true });
        await form.getByLabel('Topic', { exact: true }).fill(answer.topic);
        const ids: string[] = [];
        await page.route('**/api/commands/interactions.submit', async (route) => { ids.push(route.request().postDataJSON().commandId); const response = await route.fetch(); if (ids.length === 1)
            await route.abort('failed');
        else
            await route.fulfill({ response }); });
        await form.getByRole('button', { name: '发送信息', exact: true }).click();
        await expect(page.getByRole('button', { name: '重试同一响应', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '重试同一响应', exact: true }).click();
        await expect(page.getByText('已发送响应', { exact: true })).toBeVisible();
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(ids[1]);
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toHaveLength(1);
        const next = await startStructured(f);
        await show(page, f, next.session);
        await expect(form.getByLabel('Topic', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '取消当前轮次', exact: true }).click();
        await expect(page.getByText('响应已取消', { exact: true })).toBeVisible();
        await expect(form).toHaveCount(0);
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('a real independently installed form replaces only its public contract under the unchanged Host and default Session', async ({ browser }) => {
    const hash = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await structuredHost();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
        const { env, session } = await startStructured(f);
        expect(f.bootstrap.ui.providers['aork.sessions.detail@1']).toBe('sessions:detail');
        expect(f.bootstrap.ui.providers['aork.interactions.input-cards@1']).toBe('interactions:input-cards');
        expect(f.bootstrap.ui.providers['aork.interactions.form@1']).toBe('independent-structured-view:form');
        expect(f.bootstrap.ui.providers['aork.interactions.permission@1']).toBe('interactions:permission');
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(hash);
        const page = await context.newPage();
        await show(page, f, session);
        const form = page.getByRole('form', { name: '独立信息表单', exact: true });
        await expect(form).toBeVisible();
        await form.getByLabel('独立 Topic', { exact: true }).fill('x');
        await form.getByRole('button', { name: '独立发送信息', exact: true }).click();
        await expect(form.getByRole('alert')).toContainText('长度须为 3–20');
        await form.getByLabel('独立 Topic', { exact: true }).fill(answer.topic);
        await form.getByRole('button', { name: '独立发送信息', exact: true }).click();
        await expect(page.getByText('已发送响应', { exact: true })).toBeVisible();
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result).map(value => value.result)).toEqual([{ action: 'accept', content: answer }]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: '/tmp/aork-ticket16-independent-form-mobile.png', fullPage: true });
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('unsupported peers retain ordinary chat and unsafe URL elicitations show only a bounded capability diagnostic', async ({ browser }) => {
    const question = 'Which topic should we research?';
    const questionSource = structuredAgent().replace(`send({id:0,method:'elicitation/create',params:${JSON.stringify(formRequest)}});`, `send({method:'session/update',params:{sessionId:'input-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(question)}}}}});send({id:r.id,result:{stopReason:'end_turn'}});`);
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const { session } = await startStructured(f, questionSource);
        const page = await context.newPage();
        await show(page, f, session);
        await expect(page.getByText(question, { exact: true })).toBeVisible();
        await expect(page.getByRole('form', { name: '结构化输入表单', exact: true })).toHaveCount(0);
        await expect(page.getByRole('region', { name: '信息请求', exact: true })).toHaveCount(0);
        const secret = 'must-not-render-auth-secret';
        const next = await startStructured(f, structuredAgent({ ...formRequest, mode: 'url', url: `https://auth.example/?token=${secret}`, elicitationId: secret }));
        await show(page, f, next.session);
        await expect(page.getByText('此 Agent 请求超出当前工作表单能力；认证、URL 或未知字段约束未启用。', { exact: true })).toBeVisible();
        await expect(page.getByRole('form', { name: '结构化输入表单', exact: true })).toHaveCount(0);
        await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('an uncertain actual native write stays unresolved in the browser and remains closed after reload', async ({ browser }) => {
    const source = structuredAgent().replace("import{appendFileSync}from'node:fs';", "import{appendFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';").replace('prompt=r;send({id:0', "prompt=r;process.stdin.pause();setInterval(()=>{if(existsSync(join(dirname(fileURLToPath(import.meta.url)),'disconnect')))process.exit(0);},10);send({id:'fill',method:'unknown'+('X'.repeat(400000)),params:{}});send({id:0");
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const { env, session } = await startStructured(f, source);
        const page = await context.newPage();
        await show(page, f, session);
        const form = page.getByRole('form', { name: '结构化输入表单', exact: true });
        await form.getByLabel('Topic', { exact: true }).fill(answer.topic);
        await form.getByRole('button', { name: '发送信息', exact: true }).click();
        await expect(page.getByText('响应已受理，等待发送确认', { exact: true })).toBeVisible();
        await expect(page.getByText('已发送响应', { exact: true })).toHaveCount(0);
        await writeFile(join(f.directory, 'disconnect'), 'disconnect');
        await expect(page.getByText('响应交付结果未知，请勿重复发送', { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByText('响应交付结果未知，请勿重复发送', { exact: true })).toBeVisible();
        await expect(form).toHaveCount(0);
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result?.action === 'accept')).toHaveLength(0);
        await page.screenshot({ path: '/tmp/aork-ticket16-delivery-unknown-desktop.png', fullPage: true });
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('a retained form disables fresh submission on snapshot failure and recovers without consuming its pending request', async ({ browser }) => {
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const { env, session } = await startStructured(f);
        const page = await context.newPage();
        await show(page, f, session);
        const form = page.getByRole('form', { name: '结构化输入表单', exact: true });
        const topic = form.getByLabel('Topic', { exact: true });
        await expect(topic).toBeEnabled();
        await topic.fill(answer.topic);
        let unavailable = true;
        const message = 'Form snapshot temporarily unavailable';
        await page.route('**/api/snapshots/interactions.inputHistory?**', async (route) => { if (unavailable)
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SNAPSHOT_TEMPORARILY_UNAVAILABLE', message } }) });
        else
            await route.continue(); });
        await startStructured(f);
        await expect(topic).toBeDisabled();
        await expect(page.getByRole('alert').filter({ hasText: message }).first()).toBeVisible();
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toHaveLength(0);
        unavailable = false;
        await expect(topic).toBeEnabled({ timeout: 10000 });
        await expect(topic).toHaveValue(answer.topic);
        await form.getByRole('button', { name: '发送信息', exact: true }).click();
        await expect(page.getByText('已发送响应', { exact: true })).toBeVisible();
        expect((await inputWire(env.workspace.directory)).filter(value => value.id === 0 && value.result)).toHaveLength(1);
    }
    finally {
        await context.close();
        await f.close();
    }
});
