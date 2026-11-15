import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('public composer preserves IME and multiline text, and persisted messages and tool reports survive reload', async ({ page }) => {
  const f = await sessionHost();
  try {
    await writeFile(join(f.directory, 'controlled-agent.mjs'), agent);
    const env = await sessionEnvironment(f);
    const session = (await (await f.command('sessions.create', env.input)).json()).result;
    await page.goto(f.host.accessUrl);
    await page.evaluate(({ projectId, workspaceId, sessionId }) => { location.hash = new URLSearchParams({ project: projectId, workspace: workspaceId, session: sessionId }).toString(); }, { ...env.input, sessionId: session.id });
    await page.getByRole('button', { name: '启动运行', exact: true }).click();
    await expect(page.getByText('运行已就绪', { exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('  研究');
    await input.dispatchEvent('compositionstart'); await input.press('Enter');
    await expect(page.getByRole('region', { name: '会话消息', exact: true }).getByText('  研究', { exact: true })).toHaveCount(0);
    await input.dispatchEvent('compositionend'); await input.press('End'); await input.press('Shift+Enter'); await page.keyboard.insertText('世界  ');
    await expect(input).toHaveValue('  研究\n世界  ');
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
  } finally { await page.goto('about:blank').catch(() => {}); await f.close(); }
});
