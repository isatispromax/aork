import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

const agent = `import {createInterface} from 'node:readline';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(request.method==='session/new')send({id:request.id,result:{sessionId:'browser-turn-native'}});
if(request.method==='session/prompt'){
send({method:'session/update',params:{sessionId:'browser-turn-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'A saved answer 🌏'}}}});
send({method:'session/update',params:{sessionId:'browser-turn-native',update:{sessionUpdate:'tool_call',toolCallId:'read-only-report',title:'Read source notes',kind:'read',status:'in_progress'}}});
send({method:'session/update',params:{sessionId:'browser-turn-native',update:{sessionUpdate:'tool_call_update',toolCallId:'read-only-report',status:'completed'}}});
send({id:request.id,result:{stopReason:'end_turn'}});
}});`;

const waitingAgent = agent.replace("if(request.method==='session/prompt'){", `if(request.method==='session/cancel'&&globalThis.waiting){const id=globalThis.waiting;globalThis.waiting=undefined;setTimeout(()=>send({id,result:{stopReason:'cancelled'}}),600);}
if(request.method==='session/prompt'&&request.params.prompt[0].text.startsWith('wait')){globalThis.waiting=request.id;send({id:'browser-permission',method:'session/request_permission',params:{sessionId:'browser-turn-native',toolCall:{toolCallId:'pending-write',title:'Write research notes',status:'pending'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'}]}});return;}
if(request.method==='session/prompt'){`);

async function openTurn(page: import('@playwright/test').Page, f: Awaited<ReturnType<typeof sessionHost>>, source = agent) {
  await writeFile(join(f.directory, 'controlled-agent.mjs'), source);
  const env = await sessionEnvironment(f);
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  await page.goto(f.host.accessUrl);
  await page.evaluate(({ workspaceId, sessionId }) => { location.hash = new URLSearchParams({ workspace: workspaceId, session: sessionId }).toString(); }, { workspaceId: env.workspace.id, sessionId: session.id });
  await page.getByRole('button', { name: '启动运行', exact: true }).click();
  await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
  return session;
}

test('public composer preserves IME and multiline text, and persisted messages and tool reports survive reload', async ({ page }) => {
  const f = await sessionHost();
  try {
    await writeFile(join(f.directory, 'controlled-agent.mjs'), agent);
    const env = await sessionEnvironment(f);
    const session = (await (await f.command('sessions.create', env.input)).json()).result;
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ workspaceId, sessionId }) => { location.hash = new URLSearchParams({ workspace: workspaceId, session: sessionId }).toString(); }, { workspaceId: env.workspace.id, sessionId: session.id });
    await page.getByRole('button', { name: '启动运行', exact: true }).click();
    await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
    console.log('SIBLING footer:', await page.locator('footer').last().textContent());
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('  研究');
    await input.dispatchEvent('compositionstart'); await input.press('Enter');
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('  研究', { exact: true })).toHaveCount(0);
    await input.dispatchEvent('compositionend'); await input.press('End'); await input.press('Shift+Enter'); await page.keyboard.insertText('世界  ');
    await expect(input).toHaveValue('  研究\n世界  ');
    // Detail and composer apply their own saved snapshots. A ready header does
    // not prove the composer's current send control is already actionable.
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await writeFile('/tmp/aork17-ime-readiness-proof.json', JSON.stringify({ headerReady: true, composerSendEnabledBeforeWait: await send.isEnabled() }));
    await expect(send).toBeEnabled();
    await input.press('Enter');
    const messages = page.getByRole('region', { name: '会话消息', exact: true });
    await expect(messages.getByText('  研究\n世界  ', { exact: true })).toBeVisible();
    await expect(messages.getByText('A saved answer 🌏', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '工具报告', exact: true }).getByText('Read source notes', { exact: true })).toBeVisible();
    await expect(page.getByText('用量未知 · 费用未知', { exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    await page.reload();
    await expect(messages.getByText('  研究\n世界  ', { exact: true })).toBeVisible();
    await expect(messages.getByText('A saved answer 🌏', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/aork-ticket12-turns-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/aork-ticket12-turns-mobile.png', fullPage: true });
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('an uncertain accepted send keeps its original command identity and draft through reload', async ({ page }) => {
  const f = await sessionHost(); const commandIds: string[] = [];
  try {
    const session = await openTurn(page, f);
    await page.route('**/api/commands/sessions.sendText', async route => {
      commandIds.push(route.request().postDataJSON().commandId);
      const response = await route.fetch();
      if (commandIds.length === 1) await route.abort('failed'); else await route.fulfill({ response });
    });
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('  keep this original input  '); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试原输入', exact: true })).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue('  keep this original input  ');
    await input.fill('a separate draft');
    await page.getByRole('button', { name: '重试原输入', exact: true }).click();
    await expect(input).toHaveValue('a separate draft');
    expect(commandIds).toHaveLength(2); expect(commandIds[1]).toBe(commandIds[0]);
    const timeline = await (await page.request.get(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`)).json();
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.messages.filter((message: { role: string }) => message.role === 'user').map((message: { text: string }) => message.text)).toEqual(['  keep this original input  ']);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('a late send receipt preserves changes made after reopening the same session', async ({ page }) => {
  const f = await sessionHost();
  let releaseReceipt = () => {};
  const heldReceipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
  try {
    const session = await openTurn(page, f);
    const other = await f.command('sessions.create', {
      name: 'Other conversation', workspaceId: session.workspaceId, profileId: session.profile.id,
    });
    expect(other.ok).toBe(true);
    let sent = 0;
    await page.route('**/api/commands/sessions.sendText', async route => {
      if (++sent > 1) { await route.continue(); return; }
      const response = await route.fetch();
      await heldReceipt;
      await route.fulfill({ response });
    });
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    const retry = page.getByRole('button', { name: '重试原输入', exact: true });
    const nav = page.getByRole('region', { name: '工作区', exact: true });
    await input.fill('Message awaiting its receipt');
    await send.click();
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('A saved answer 🌏', { exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await nav.getByRole('treeitem', { name: 'Other conversation', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('Other session draft');
    await nav.getByRole('treeitem', { name: 'Research conversation', exact: true }).click();
    await expect(input).toHaveValue('Message awaiting its receipt');
    await input.fill('New draft in the first session');
    releaseReceipt();
    await expect(send).toBeEnabled();
    await expect(retry).toHaveCount(0);
    await expect(input).toHaveValue('New draft in the first session');
    await nav.getByRole('treeitem', { name: 'Other conversation', exact: true }).click();
    await expect(input).toHaveValue('Other session draft');
    await nav.getByRole('treeitem', { name: 'Research conversation', exact: true }).click();
    await expect(input).toHaveValue('New draft in the first session');
    expect(sent).toBe(1);
  } finally { releaseReceipt(); await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('waiting permissions retain the active public Turn while following input queues and an unsent draft survives cancellation', async ({ page }) => {
  const f = await sessionHost();
  let releaseCancel = () => {};
  const heldCancel = new Promise<void>(resolve => { releaseCancel = resolve; });

  try {
    const session = await openTurn(page, f, waitingAgent);
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('first'); await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled(); await input.press('Enter'); await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible();
    const receipt = await f.command('sessions.sendText', { sessionId: session.id, text: 'wait ' + 'long prompt '.repeat(800) }); expect(receipt.status).toBe(200); const waiting = (await receipt.json()).result;
    const permission = page.getByRole('region', { name: '权限请求', exact: true });
    await expect(permission.getByText('Write research notes', { exact: true })).toBeVisible();
    await expect(permission.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
    await input.fill('next draft retained'); await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.getByRole('region', { name: '待发队列', exact: true }).getByText('next draft retained', { exact: true })).toBeVisible();
    await page.route('**/api/commands/sessions.cancelTurn', async route => {
      await heldCancel;
      await route.continue();
    });
    await input.fill('another unsent draft');
    await page.getByRole('button', { name: '取消当前轮次', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await input.press('Enter');
    releaseCancel();
    await expect(page.getByRole('button', { name: '取消中…', exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('已取消', { exact: true })).toBeVisible();
    await expect(permission.getByText('响应已取消', { exact: true })).toBeVisible(); await expect(permission.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0); await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
    const timeline = await (await page.request.get(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`)).json();
    expect(timeline.turns).toHaveLength(3); expect(timeline.turns.find((turn: { id: string }) => turn.id === waiting.id).state).toBe('cancelled');
    await page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect(input).toHaveValue('another unsent draft');
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('next draft retained', { exact: true })).toBeVisible();
  } finally { releaseCancel(); await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('a definitively rejected input can be corrected and sent as a new command', async ({ page }) => {
  const f = await sessionHost();
  try {
    await openTurn(page, f);
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    // Detail and composer apply their own saved snapshots; the composer's send
    // control becomes actionable only after its environments subscription lands.
    await input.fill('研'.repeat(6000));
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await input.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await input.fill('a corrected input'); await input.press('Enter');
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('a corrected input', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});

test('an independently packaged UI replaces composer, messages and tools while default detail preserves public Turn rules', async ({ page }) => {
  const hostHash = createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
  const f = await sessionHost('turns');
  try {
    const session = await openTurn(page, f, waitingAgent);
    expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(hostHash);
    const bootstrap = f.bootstrap;
    for (const name of ['composer', 'messages', 'tools']) expect(bootstrap.ui.providers[`aork.sessions.${name}@1`]).toBe(`independent-turn-view:${name}`);
    expect(bootstrap.ui.providers['aork.sessions.detail@1']).toBe('sessions:detail');
    const input = page.getByRole('textbox', { name: '独立消息输入', exact: true });
    await input.fill('  independently sent  '); await page.getByRole('button', { name: '独立发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '独立消息视图', exact: true }).getByText('A saved answer 🌏', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '独立工具视图', exact: true }).getByText('Read source notes · completed', { exact: true })).toBeVisible();
    const response = await f.command('sessions.sendText', { sessionId: session.id, text: 'wait via public command' });
    expect(response.status).toBe(200);
    const waiting = (await response.json()).result;
    await expect(page.getByRole('status', { name: '独立当前轮次', exact: true })).toContainText(waiting.id);
    await expect(page.getByRole('button', { name: '独立发送', exact: true })).toBeDisabled();
    expect((await f.command('sessions.sendText', { sessionId: session.id, text: 'queued by a public command' })).status).toBe(200);
    await page.getByRole('button', { name: '独立取消轮次', exact: true }).click();
    await expect(page.getByRole('region', { name: '独立消息视图', exact: true }).getByText('cancelled', { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('region', { name: '独立消息视图', exact: true }).getByText('  independently sent  ', { exact: true })).toBeVisible();
    const timeline = await (await page.request.get(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`)).json(); expect(timeline.turns).toHaveLength(3);
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
