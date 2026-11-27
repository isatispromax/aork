import { openMenu } from '../fixtures/menu.js';
import { expect, test } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';

const peer=`import{createInterface}from'node:readline';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let active;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'retained-session'}});if(r.method==='session/cancel'&&active){send({id:active,result:{stopReason:'cancelled'}});active=undefined;}if(r.method==='session/prompt'){if(r.params.prompt[0].text==='hold'){active=r.id;send({method:'session/update',params:{sessionId:'retained-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'An active saved response'}}}});return;}send({method:'session/update',params:{sessionId:'retained-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved content must remain visible'}}}});send({method:'session/update',params:{sessionId:'retained-session',update:{sessionUpdate:'tool_call',toolCallId:'saved-tool',title:'Saved tool report',kind:'read',status:'completed'}}});send({id:r.id,result:{stopReason:'end_turn'}});}});`;

async function openSavedSession(page:import('@playwright/test').Page,f:Awaited<ReturnType<typeof sessionHost>>){
  await writeFile(join(f.directory,'controlled-agent.mjs'),peer);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  await f.command('sessions.startRun',{sessionId:session.id});
  await expect.poll(async()=>(await(await f.query()).json()).sessions[0]?.execution.state).toBe('ready');
  await f.command('sessions.sendText',{sessionId:session.id,text:'saved input'});
  await page.goto(f.host.accessUrl!);await page.evaluate(input=>{location.hash=new URLSearchParams(input).toString();},{workspace:env.workspace.id,session:session.id});
  await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'工具报告',exact:true}).getByText('Saved tool report',{exact:true})).toBeVisible();
  return session;
}

test('default saved history, tools, draft and cancellation survive observation transport failure and long offline recovery',async({page,context})=>{
  const f=await sessionHost();let failing=false;let failedReads=0;let observed=0;
  try{
    await page.route('**/api/queries/sessions.environments',async route=>{if(failing){failedReads++;await route.abort('failed');}else{observed++;await route.continue();}});
    const session=await openSavedSession(page,f);
    await f.command('sessions.sendText',{sessionId:session.id,text:'hold'});
    const input=page.getByRole('textbox',{name:'消息输入',exact:true});await input.fill('draft survives observation loss');
    const cancel=page.getByRole('button',{name:'取消当前轮次',exact:true});await expect(cancel).toBeEnabled();
    failing=true;await expect.poll(()=>failedReads).toBeGreaterThan(0);
    expect(await page.evaluate(()=>navigator.onLine)).toBe(true);
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'工具报告',exact:true}).getByText('Saved tool report',{exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'会话详情',exact:true}).getByRole('alert').filter({hasText:'工作区状态检查失败'})).toBeVisible();
    await expect(input).toHaveValue('draft survives observation loss');await expect(input).toBeFocused();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();await expect(cancel).toBeEnabled();
    await context.setOffline(true);await page.waitForTimeout(5600);
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toBeVisible();await expect(input).toHaveValue('draft survives observation loss');
    await context.setOffline(false);failing=false;const beforeRecovery=observed;
    await expect.poll(()=>observed).toBeGreaterThan(beforeRecovery);
    await expect(page.getByText(/工作区状态检查失败/)).toHaveCount(0);await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();
    // Only independent observation/reconnect reads recovered; no new domain event
    // was needed to clear the error or remount/reconstruct the saved children.
    await expect(input).toHaveValue('draft survives observation loss');await expect(cancel).toBeEnabled();await cancel.click();
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('已取消',{exact:true})).toBeVisible();
    await openMenu(page);await page.getByRole('button',{name:'结束运行',exact:true}).click();
    const start=page.getByRole('button',{name:'新建原生上下文',exact:true});await expect(start).toBeDisabled();await page.getByLabel('选择新的原生上下文，保留已有工作台记录').check();await expect(start).toBeEnabled();
    failing=true;const priorFailures=failedReads;await expect.poll(()=>failedReads).toBeGreaterThan(priorFailures);await expect(start).toBeDisabled();
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toBeVisible();
    failing=false;await expect(start).toBeEnabled();
    const directory=(await(await f.query()).json()).sessions[0].session.workspace.directory;
    await rm(directory,{recursive:true});
    await expect(page.getByText('目录不可用；历史仍保留，启动前须重新验证工作区。',{exact:true})).toBeVisible();
    await expect(start).toBeDisabled();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toBeVisible();
  }finally{await context.setOffline(false);await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('a failed projection replacement preserves applied history and clears only after its own successful read',async({page})=>{
  const f=await sessionHost();let projectionFailed=false;let environmentFailed=false;let successfulEnvironmentReads=0;
  try{
    await page.route('**/api/snapshots/sessions.overview*',async route=>{if(projectionFailed)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROLLED_PROJECTION_FAILURE',message:'Controlled projection replacement failure'}})});else await route.continue();});
    await page.route('**/api/queries/sessions.environments',async route=>{if(environmentFailed)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROLLED_OBSERVATION_FAILURE',message:'Explicit environment query failure'}})});else{successfulEnvironmentReads++;await route.continue();}});
    const session=await openSavedSession(page,f);const input=page.getByRole('textbox',{name:'消息输入',exact:true});await input.fill('retained projection draft');
    projectionFailed=true;await f.command('sessions.sendText',{sessionId:session.id,text:'another saved input'});
    const detail=page.getByRole('region',{name:'会话详情',exact:true});const projectionWarning=detail.getByRole('alert').filter({hasText:'会话状态更新失败'});
    await expect(projectionWarning).toContainText('Controlled projection replacement failure');
    await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Saved content must remain visible',{exact:true})).toHaveCount(2);
    await expect(page.getByRole('region',{name:'工具报告',exact:true}).getByText('Saved tool report',{exact:true})).toHaveCount(2);
    await expect(input).toHaveValue('retained projection draft');await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
    environmentFailed=true;await expect(detail.getByRole('alert').filter({hasText:'工作区状态检查失败'})).toContainText('Explicit environment query failure');
    environmentFailed=false;const observedAtFailure=successfulEnvironmentReads;
    await expect.poll(()=>successfulEnvironmentReads).toBeGreaterThan(observedAtFailure);
    await expect(detail.getByRole('alert').filter({hasText:'工作区状态检查失败'})).toHaveCount(0);await expect(projectionWarning).toBeVisible();
    projectionFailed=false;await expect(projectionWarning).toHaveCount(0);
    await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();await expect(input).toHaveValue('retained projection draft');
    await page.getByRole('button',{name:'退出访问',exact:true}).click();
    await expect(page.getByRole('region',{name:'会话消息',exact:true})).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'需要工作台访问链接',exact:true})).toBeVisible();
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
