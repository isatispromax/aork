import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from '../fixtures/session-host.js';
import { startStructured } from '../fixtures/structured-host.js';
test('cross-project pending jump renders the public form and persisted themes keep the Session draft', async ({ page }) => {
    const f = await sessionHost();
    try {
        const { session } = await startStructured(f);
        await page.goto(f.host.accessUrl);
        await page.getByRole('button', { name: '待处理 · 1', exact: true }).click();
        await expect(page.getByRole('heading', { name: '待处理请求', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '打开请求：Plan the research', exact: true }).click();
        await expect(page.getByRole('form', { name: '结构化输入表单', exact: true })).toBeVisible();
        expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('session')).toBe(session.id);
        await page.getByLabel('消息输入', { exact: true }).fill('Draft remains');
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByLabel('主题', { exact: true }).selectOption('dark');
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('Draft remains');
        await expect(page.locator('html')).toHaveAttribute('data-aork-theme', 'dark');
        await page.reload();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('Draft remains');
        await expect(page.locator('html')).toHaveAttribute('data-aork-theme', 'dark');
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('only the opened reply advances read state across tabs, refresh and later unseen completion', async ({ browser }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    const context = await browser.newContext();
    try {
        const one = await openWorkbench(f, 'First reply');
        const two = await openWorkbench(f, 'Other project reply');
        const page = await context.newPage();
        const other = await context.newPage();
        await page.goto(f.host.accessUrl);
        await other.goto(f.host.accessUrl);
        await page.bringToFront();
        await expect(page.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '未读 · 2', exact: true }).click();
        await page.getByRole('region', { name: '未读回复列表' }).getByRole('article').filter({ hasText: 'First reply' }).getByRole('button', { name: '打开回复', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Completed ordinary question: First reply?');
        await expect(page.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await expect(other.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await f.command('sessions.sendText', { sessionId: one.session.id, text: 'Unseen future' });
        await expect(other.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).not.toContainText('Unseen future');
        await page.reload();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('First reply');
        await expect(page.getByRole('button', { name: '未读 · 2', exact: true })).toBeVisible();
        const unread = await (await f.query('workbench.unread')).json();
        expect(unread.items.some((item: any) => item.sessionId === two.session.id)).toBe(true);
        await page.screenshot({ path: '/tmp/aork18-session-light.png', fullPage: true });
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('opening a long reply keeps unread until every requested page has actually been expanded', async ({ page }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    try {
        await openWorkbench(f, 'long');
        await page.goto(f.host.accessUrl);
        await page.getByRole('button', { name: '未读 · 1', exact: true }).click();
        await page.getByRole('button', { name: '打开回复', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Reply page 49');
        await expect(page.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '展开后续回复内容', exact: true }).click();
        await expect(page.getByRole('article', { name: '选中的完成回复' })).toContainText('Reply page 54');
        await expect(page.getByRole('button', { name: '未读 · 0', exact: true })).toBeVisible();
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('independently installed complete layout and message child preserve services, stable extensions and local failure without reading unseen content', async ({ page }) => {
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { independentWorkbench, openWorkbench } = await import('../fixtures/workbench-host.js');
    const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await independentWorkbench();
    try {
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
        const { session } = await openWorkbench(f, 'Independent first');
        await page.goto(f.host.accessUrl);
        await expect(page.getByText('独立完整布局', { exact: true })).toBeVisible();
        await expect(page.getByRole('navigation', { name: '独立菜单' }).getByRole('button',{name:/^扩展/})).toHaveText(['扩展 Beta', '扩展 Alpha']);
        await expect(page.getByText('扩展通知', { exact: true })).toHaveCount(0);
        await page.evaluate(session => { location.hash = new URLSearchParams({ project: session.projectId, workspace: session.workspaceId, session: session.id, broken: '1' }).toString(); }, session);
        await expect(page.getByRole('alert').filter({ hasText: 'aork.sessions.messages@1' })).toBeVisible();
        await expect(page.getByLabel('消息输入', { exact: true })).toBeVisible();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 1');
        expect((await (await f.query('workbench.unread')).json()).count).toBe(1);
        await page.reload();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 1');
        await page.evaluate(() => { const values = new URLSearchParams(location.hash.slice(1)); values.delete('broken'); location.hash = values.toString(); });
        await page.reload();
        await expect(page.getByRole('heading', { name: '独立可替换消息', exact: true })).toBeVisible();
        await expect(page.getByLabel('独立通知')).toContainText('独立未读 0');
        await page.screenshot({ path: '/tmp/aork18-independent-layout.png', fullPage: true });
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});
test('hidden pending navigation keeps cross-project native requests actionable and both tabs observe actual responses', async ({ browser }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost(false, async ({ profile }) => { profile.ui.extensions.push({ id: 'workbench:pending-link', order: 10, hidden: true }); });
    const context = await browser.newContext();
    try {
        const permission = await openWorkbench(f, 'permission');
        const form = await openWorkbench(f, 'form');
        await openWorkbench(f, 'ordinary completed question');
        const first = await context.newPage();
        const other = await context.newPage();
        await first.goto(f.host.accessUrl);
        await other.goto(f.host.accessUrl);
        await first.bringToFront();
        await expect(first.getByRole('button', { name: /^待处理 ·/ })).toHaveCount(0);
        for (const page of [first, other])
            await page.evaluate(() => { location.hash = 'page=pending'; });
        await expect(first.getByRole('region', { name: '跨项目待处理' })).toContainText('2 个有效请求');
        await expect(other.getByRole('region', { name: '跨项目待处理' })).toContainText('2 个有效请求');
        await first.getByRole('button', { name: '打开请求：Read notes 0', exact: true }).click();
        await first.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(other.getByRole('region', { name: '跨项目待处理' })).toContainText('1 个有效请求');
        await other.getByRole('button', { name: '打开请求：Plan the research', exact: true }).click();
        await other.bringToFront();
        await other.getByRole('form', { name: '结构化输入表单', exact: true }).getByRole('button', { name: '拒绝提供', exact: true }).click();
        await expect(other.getByText('已发送响应', { exact: true })).toBeVisible();
        await expect.poll(async () => (await (await f.query('interactions.pending')).json()).pending.length).toBe(0);
        expect((await (await f.query('interactions.inputPending')).json()).pending).toEqual([]);
    }
    finally {
        await context.close();
        await f.close();
    }
});
test('compact mobile drawers return focus and light dark system changes retain draft and Files selection', async ({ page }) => {
    const { openWorkbench } = await import('../fixtures/workbench-host.js');
    const f = await sessionHost();
    try {
        await page.setViewportSize({width:1440,height:940});const { env, session } = await openWorkbench(f, 'mobile');
        await writeFile(join(env.workspace.directory, 'notes.md'), 'Selected real file\n');
        await page.goto(f.host.accessUrl);
        await page.evaluate(session => { location.hash = new URLSearchParams({ project: session.projectId, workspace: session.workspaceId, session: session.id, file: 'notes.md' }).toString(); }, session);
        await page.getByLabel('消息输入', { exact: true }).fill('保留输入草稿');
        await expect(page.getByRole('region', { name: '工作区文件', exact: true })).toContainText('Selected real file');
        await page.getByRole('button', { name: '设置', exact: true }).click();
        for (const theme of ['dark', 'light', 'system']) {
            await page.getByLabel('主题', { exact: true }).selectOption(theme);
            await expect(page.getByLabel('主题', { exact: true })).toHaveValue(theme);
        }
        await page.getByLabel('主题', { exact: true }).selectOption('dark');
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('保留输入草稿');
        await expect(page.getByRole('region', { name: '工作区文件', exact: true })).toContainText('Selected real file');
        await page.screenshot({ path: '/tmp/aork18-session-dark.png', fullPage: true });
        await page.getByRole('button',{name:'切换文件面板宽度',exact:true}).click();
        await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();await page.reload();
        await expect(page.getByRole('region',{name:'工作区文件',exact:true})).toBeHidden();await expect(page.getByLabel('消息输入',{exact:true})).toHaveValue('保留输入草稿');
        await page.getByRole('button',{name:'切换文件面板',exact:true}).click();await expect(page.getByRole('region',{name:'工作区文件',exact:true})).toContainText('Selected real file');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '切换导航', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '工作台侧栏', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: '切换导航', exact: true })).toBeFocused();
        await page.getByRole('button', { name: '切换文件面板', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '会话文件', exact: true })).toContainText('Selected real file');await page.getByRole('button',{name:'返回文件树',exact:true}).click();await page.getByRole('button',{name:/notes\.md/}).click();await expect(page.getByRole('dialog',{name:'会话文件',exact:true})).toContainText('Selected real file');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: '切换文件面板', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByLabel('消息输入', { exact: true })).toHaveValue('保留输入草稿');
        await page.screenshot({ path: '/tmp/aork18-session-mobile.png', fullPage: true });
    }
    finally {
        await page.goto('about:blank').catch(() => { });
        await f.close();
    }
});

test('a reply completing underneath full-screen Files stays unread until the actual content is uncovered',async({page})=>{
 const{openWorkbench}=await import('../fixtures/workbench-host.js');const f=await sessionHost();try{
 await page.setViewportSize({width:390,height:844});const{session}=await openWorkbench(f,'Visible first');await page.goto(f.host.accessUrl);await page.evaluate(session=>{location.hash=new URLSearchParams({project:session.projectId,workspace:session.workspaceId,session:session.id}).toString();},session);
 await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 await page.getByRole('button',{name:'切换文件面板',exact:true}).click();await expect(page.getByRole('dialog',{name:'会话文件',exact:true})).toBeVisible();
 const acks:string[]=[];page.on('request',request=>{if(request.url().endsWith('/api/commands/workbench.markRead'))acks.push(...request.postDataJSON().payload.activityIds);});
 const turn=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'Covered by Files'})).json()).result;
 await expect(page.getByText('Completed ordinary question: Covered by Files?',{exact:true})).toBeAttached();await page.waitForLoadState('networkidle');
 expect((await(await f.query('workbench.unread')).json()).count).toBe(1);expect(acks).not.toContain(turn.id);
 await page.screenshot({path:'/tmp/aork18-fix-files-covered.png',fullPage:true});
 await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();await expect(page.getByText('Completed ordinary question: Covered by Files?',{exact:true})).toBeVisible();
 await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);expect(acks).toContain(turn.id);
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('Settings and navigation modal layers keep new replies unread, and closing a cover does not read offscreen content',async({page})=>{
 const{openWorkbench}=await import('../fixtures/workbench-host.js');const f=await sessionHost();try{
 await page.setViewportSize({width:1440,height:940});const{session}=await openWorkbench(f,'Visible before modal');await page.goto(f.host.accessUrl);await page.evaluate(session=>{location.hash=new URLSearchParams({project:session.projectId,workspace:session.workspaceId,session:session.id}).toString();},session);
 await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'工作台设置',exact:true})).toBeVisible();
 await f.command('sessions.sendText',{sessionId:session.id,text:'Covered by Settings'});await expect(page.getByText('Completed ordinary question: Covered by Settings?',{exact:true})).toBeAttached();await page.waitForLoadState('networkidle');expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'切换导航',exact:true}).click();await expect(page.getByRole('dialog',{name:'工作台侧栏',exact:true})).toBeVisible();
 await f.command('sessions.sendText',{sessionId:session.id,text:'Covered by navigation'});await expect(page.getByText('Completed ordinary question: Covered by navigation?',{exact:true})).toBeAttached();await page.waitForLoadState('networkidle');expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
 await page.getByRole('button',{name:'关闭导航',exact:true}).click();await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 const long=await openWorkbench(f,'long');await page.evaluate(session=>{location.hash=new URLSearchParams({project:session.projectId,workspace:session.workspaceId,session:session.id}).toString();},long.session);await expect(page.getByText('已完成',{exact:true})).toBeVisible();await page.waitForLoadState('networkidle');await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 await page.getByRole('button',{name:'切换文件面板',exact:true}).click();await f.command('sessions.sendText',{sessionId:long.session.id,text:'Still offscreen when uncovered'});const reply=page.getByText('Completed ordinary question: Still offscreen when uncovered?',{exact:true});await expect(reply).toBeAttached();await page.waitForLoadState('networkidle');expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
 await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();await page.waitForLoadState('networkidle');expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
 await reply.scrollIntoViewIfNeeded();await expect(reply).toBeVisible();await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('an installed independent layout preserves exact unread replies under semantic hiding and an opaque cover, then rechecks without a new domain event',async({page})=>{
 const{independentWorkbench,openWorkbench}=await import('../fixtures/workbench-host.js');const f=await independentWorkbench();try{
 const{session}=await openWorkbench(f,'Independent exposed first');await page.goto(f.host.accessUrl);await page.evaluate(session=>{location.hash=new URLSearchParams({project:session.projectId,workspace:session.workspaceId,session:session.id}).toString();},session);await expect(page.getByRole('region',{name:'独立消息'})).toContainText('Completed ordinary question: Independent exposed first?');await page.waitForLoadState('networkidle');await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count).toBe(0);
 for(const mode of ['aria-hidden','visibility','opacity','inert','cover']){
  await page.getByLabel('阅读区域可见性',{exact:true}).selectOption(mode);
  const turn=(await(await f.command('sessions.sendText',{sessionId:session.id,text:`Independent ${mode}`})).json()).result;
  const reply=page.getByText(`Completed ordinary question: Independent ${mode}?`,{exact:true});await expect(reply).toBeAttached();await page.waitForLoadState('networkidle');
  const unread=await(await f.query('workbench.unread')).json();expect(unread.count).toBe(1);expect(unread.items[0].activityId).toBe(turn.id);
  await page.getByLabel('阅读区域可见性',{exact:true}).selectOption('visible');await expect(reply).toBeVisible();await expect.poll(async()=>(await(await f.query('workbench.unread')).json()).count,{message:`uncovered independent ${mode}`}).toBe(0).catch(async failure=>{await page.screenshot({path:`/tmp/aork18-visibility-${mode}-failure.png`});throw failure;});
 }
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('one independently installed public read slot changes exact reply context without remounting or reusing another payload command ID', async ({ page }) => {
    const { singleSlotWorkbench, openWorkbench } = await import('../fixtures/workbench-host.js');
    const { createHash } = await import('node:crypto'); const { readFile } = await import('node:fs/promises');
    const before = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
    const f = await singleSlotWorkbench();
    try {
        const first = await openWorkbench(f, 'Single slot first');
        const second = (await (await f.command('sessions.sendText', { sessionId: first.session.id, text: 'Single slot second' })).json()).result;
        await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(2);
        const attempts: Array<{ commandId: string; payload: { sessionId: string; activityIds: string[] }; status: number }> = [];
        page.on('response', response => { if (response.url().endsWith('/api/commands/workbench.markRead')) { const body = response.request().postDataJSON(); attempts.push({ commandId: body.commandId, payload: body.payload, status: response.status() }); } });
        await page.goto(f.host.accessUrl); await page.evaluate(id => { location.hash = new URLSearchParams({ slotSessions: id }).toString(); }, first.session.id);
        await page.getByRole('button', { name: '阅读回复 1', exact: true }).click();
        await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(1);
        await page.getByLabel('读槽批注', { exact: true }).fill('keep the same mounted content');
        await page.getByRole('button', { name: '阅读回复 2', exact: true }).click();
        await expect(page.getByRole('article', { name: '单槽当前回复' })).toContainText('Completed ordinary question: Single slot second?');
        await expect(page.getByLabel('读槽批注', { exact: true })).toHaveValue('keep the same mounted content');
        await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(0);
        expect(attempts.map(value => value.status)).toEqual([200, 200]);
        expect(attempts.map(value => value.payload)).toEqual([{ sessionId: first.session.id, activityIds: [first.turn.id] }, { sessionId: first.session.id, activityIds: [second.id] }]);
        expect(attempts[0]!.commandId).not.toBe(attempts[1]!.commandId);
        expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(before);
    } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

for (const oldOutcome of ['delivered', 'dropped'] as const) {
    test(`a ${oldOutcome} old reply response cannot cross into the next reused read-slot generation`, async ({ page }) => {
        const { singleSlotWorkbench, openWorkbench } = await import('../fixtures/workbench-host.js');
        const f = await singleSlotWorkbench();
        let releaseOld = () => {}; let releaseNew = () => {};
        const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
        const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
        try {
            const first = await openWorkbench(f, 'Held first reply');
            const second = await openWorkbench(f, 'Next Session reply');
            const other = await openWorkbench(f, 'Unopened other Session');
            await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(3);
            const attempts: Array<{ commandId: string; payload: { sessionId: string; activityIds: string[] } }> = [];
            let oldAccepted = false, newPending = false;
            await page.route('**/api/commands/workbench.markRead', async route => {
                const body = route.request().postDataJSON(); attempts.push(body);
                if (body.payload.activityIds[0] === first.turn.id) {
                    const response = await route.fetch(); expect(response.status()).toBe(200); oldAccepted = true;
                    await oldGate;
                    if (oldOutcome === 'delivered') await route.fulfill({ response }).catch(() => {});
                    else await route.abort('failed').catch(() => {});
                } else if (body.payload.activityIds[0] === second.turn.id) {
                    if (attempts.filter(value => value.payload.activityIds[0] === second.turn.id).length === 1) {
                        newPending = true; await newGate; await route.abort('failed').catch(() => {});
                    } else await route.continue().catch(() => {});
                } else await route.continue();
            });
            await page.goto(f.host.accessUrl);
            await page.evaluate(ids => { location.hash = new URLSearchParams({ slotSessions: ids.join(',') }).toString(); }, [first.session.id, second.session.id, other.session.id]);
            await page.getByRole('button', { name: '阅读回复 1', exact: true }).click();
            await expect.poll(() => oldAccepted).toBe(true);
            expect((await (await f.query('workbench.unread')).json()).count).toBe(2);
            await page.getByLabel('读槽批注', { exact: true }).fill('one mounted reader across generations');
            await page.getByRole('button', { name: '阅读回复 2', exact: true }).click();
            await expect.poll(() => newPending).toBe(true);
            await expect(page.getByRole('article', { name: '单槽当前回复' })).toContainText('Completed ordinary question: Next Session reply?');
            await expect(page.getByLabel('读槽批注', { exact: true })).toHaveValue('one mounted reader across generations');
            const oldRequest = (request: import('@playwright/test').Request) => request.url().endsWith('/api/commands/workbench.markRead') && request.postDataJSON().payload.activityIds[0] === first.turn.id;
            const oldSettled = oldOutcome === 'delivered'
                ? page.waitForResponse(response => oldRequest(response.request()))
                : page.waitForEvent('requestfailed', { predicate: oldRequest });
            releaseOld(); await oldSettled;
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await expect(page.getByText('已读位置尚未同步', { exact: true })).toHaveCount(0);
            // A stale finalizer must not release the new generation's in-flight
            // latch. A real cover/uncover causes another visibility evaluation.
            await page.getByLabel('覆盖读槽', { exact: true }).check();
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.getByLabel('覆盖读槽', { exact: true }).uncheck();
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            expect(attempts.filter(value => value.payload.activityIds[0] === second.turn.id)).toHaveLength(1);
            const unreadBeforeNew = await (await f.query('workbench.unread')).json();
            expect(unreadBeforeNew.items.map((value: { activityId: string }) => value.activityId).sort()).toEqual([second.turn.id, other.turn.id].sort());
            const newAccepted = page.waitForResponse(response => response.url().endsWith('/api/commands/workbench.markRead') && response.request().postDataJSON().payload.activityIds[0] === second.turn.id);
            releaseNew(); expect((await newAccepted).status()).toBe(200);
            await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(1);
            expect(attempts).toHaveLength(3); expect(attempts[0]!.commandId).not.toBe(attempts[1]!.commandId); expect(attempts[2]).toEqual(attempts[1]);
            expect(attempts[1]!.payload).toEqual({ sessionId: second.session.id, activityIds: [second.turn.id] });
            const future = (await (await f.command('sessions.sendText', { sessionId: second.session.id, text: 'Future not selected' })).json()).result;
            await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(2);
            const retained = await (await f.query('workbench.unread')).json();
            expect(retained.items.map((value: { activityId: string }) => value.activityId).sort()).toEqual([future.id, other.turn.id].sort());
            await expect(page.getByRole('article', { name: '单槽当前回复' })).not.toContainText('Future not selected');
            await expect(page.getByText('已读位置尚未同步', { exact: true })).toHaveCount(0);
        } finally { releaseOld(); releaseNew(); await page.unrouteAll({ behavior: 'wait' }); await page.goto('about:blank').catch(() => {}); await f.close(); }
    });
}

test('a dropped response retries the same read payload with the same command ID while its single slot remains current', async ({ page }) => {
    const { singleSlotWorkbench, openWorkbench } = await import('../fixtures/workbench-host.js'); const f = await singleSlotWorkbench();
    try {
        const first = await openWorkbench(f, 'Same payload retry');
        await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(1);
        const attempts: Array<{ commandId: string; payload: unknown }> = [];
        await page.route('**/api/commands/workbench.markRead', async route => {
            attempts.push(route.request().postDataJSON());
            if (attempts.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); }
            else await route.continue();
        });
        await page.goto(f.host.accessUrl); await page.evaluate(id => { location.hash = new URLSearchParams({ slotSessions: id }).toString(); }, first.session.id);
        const acceptedRetry = page.waitForResponse(response => response.url().endsWith('/api/commands/workbench.markRead') && response.status() === 200);
        await page.getByRole('button', { name: '阅读回复 1', exact: true }).click(); await acceptedRetry;
        await expect.poll(() => attempts.length).toBe(2); expect(attempts[1]).toEqual(attempts[0]);
        expect(attempts[0]!.payload).toEqual({ sessionId: first.session.id, activityIds: [first.turn.id] });
        await expect.poll(async () => (await (await f.query('workbench.unread')).json()).count).toBe(0);
        await expect(page.getByText('已读位置尚未同步', { exact: true })).toHaveCount(0);
    } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
