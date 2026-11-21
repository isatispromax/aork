import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';
const peer=`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let active;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('browser-queue-wire',line+'\\n');if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'browser-queue'}});if(r.method==='session/cancel'&&active){send({id:active,result:{stopReason:'cancelled'}});active=undefined;}if(r.method==='session/prompt'){active=r.id;send({method:'session/update',params:{sessionId:'browser-queue',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started '+r.params.prompt[0].text}}}});if(r.params.prompt[0].text!=='hold'){active=undefined;send({id:r.id,result:{stopReason:'end_turn'}});}}});`;

test('running composer queues IME-safe input, shows ordered removal, and explicit continue preserves workspace selection and draft', async ({page})=>{
 const f=await sessionHost();try{
  await writeFile(join(f.directory,'controlled-agent.mjs'),peer);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;await mkdir(join(env.workspace.directory,'notes'));
  await page.goto(f.host.accessUrl);await page.evaluate(({workspace,session})=>{location.hash=new URLSearchParams({workspace,session,directory:'notes',otherPlugin:'preserved'}).toString();},{workspace:env.workspace.id,session:session.id});
  await page.getByRole('button',{name:'启动运行',exact:true}).click();await expect(page.getByText('运行已就绪',{exact:true})).toBeVisible();
  const input=page.getByRole('textbox',{name:'消息输入',exact:true});await input.fill('hold');
  // The composer's send control lags the ready header until its environments subscription lands.
  await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();
  await input.press('Enter');await expect(page.getByRole('button',{name:'取消当前轮次',exact:true})).toBeVisible();
  await input.fill('第二条 🌏');await input.dispatchEvent('compositionstart');await input.press('Enter');await expect(input).toHaveValue('第二条 🌏');await input.dispatchEvent('compositionend');await input.press('Enter');await expect(input).toHaveValue('');
  const queue=page.getByRole('region',{name:'待发队列',exact:true});await expect(queue.getByText('第二条 🌏',{exact:true})).toBeVisible();
  await input.fill('remove from queue');await input.press('Enter');await expect(queue.getByText('remove from queue',{exact:true})).toBeVisible();
  await queue.getByRole('listitem').filter({hasText:'remove from queue'}).getByRole('button',{name:'移除排队输入 3',exact:true}).click();await expect(queue.getByText('remove from queue',{exact:true})).toHaveCount(0);
  await input.fill('draft survives');await page.getByRole('button',{name:'取消当前轮次',exact:true}).click();await expect(queue.getByRole('button',{name:'继续队列',exact:true})).toBeEnabled();
  await page.reload();await expect(input).toHaveValue('draft survives');await expect(queue.getByText('第二条 🌏',{exact:true})).toBeVisible();await expect(queue.getByRole('button',{name:'继续队列',exact:true})).toBeEnabled();
  await page.screenshot({path:'/tmp/aork-ticket13-paused-queue-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket13-paused-queue-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});await queue.getByRole('button',{name:'继续队列',exact:true}).click();await expect(page.getByRole('region',{name:'会话消息',exact:true}).getByText('Started 第二条 🌏',{exact:true})).toBeVisible();await expect(input).toHaveValue('draft survives');
  const requests=(await readFile(join(env.workspace.directory,'browser-queue-wire'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(requests.filter(r=>r.method==='session/prompt').map(r=>r.params.prompt[0].text)).toEqual(['hold','第二条 🌏']);
  const params=new URLSearchParams(new URL(page.url()).hash.slice(1));expect(params.get('workspace')).toBe(env.workspace.id);expect(params.get('otherPlugin')).toBe('preserved');expect(params.get('directory')).toBe('notes');
  await page.screenshot({path:'/tmp/aork-ticket13-queue-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket13-queue-mobile.png',fullPage:true});
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('physical observation failure clears on its own recovery without concealing a separate snapshot failure',async({page})=>{
 const f=await sessionHost();let failEnvironment=false;let failProjection=false;let successfulEnvironmentReads=0;
 try{
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  await page.route('**/api/queries/sessions.environments',async route=>{if(failEnvironment)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROLLED_OBSERVATION_FAILURE',message:'Controlled observation failure'}})});else{successfulEnvironmentReads++;await route.continue();}});
  await page.route('**/api/snapshots/sessions.overview*',async route=>{if(failProjection)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROLLED_PROJECTION_FAILURE',message:'Controlled projection failure'}})});else await route.continue();});
  await page.goto(f.host.accessUrl);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({workspace:env.workspace.id,session:session.id}).toString();},{env,session});
  const heading=page.getByRole('heading',{name:'Research conversation',exact:true});await expect(heading).toBeVisible();
  failEnvironment=true;await expect(page.locator('main').getByRole('alert').filter({hasText:'Controlled observation failure'}).first()).toBeVisible();
  failEnvironment=false;const recoveredAt=successfulEnvironmentReads;await expect.poll(()=>successfulEnvironmentReads).toBeGreaterThan(recoveredAt);
  await expect(heading).toBeVisible();await expect(page.getByText('Controlled observation failure',{exact:true})).toHaveCount(0);
  // Force an initial snapshot failure on reload. Successful independent filesystem
  // observations must not hide a still-failed authoritative DB projection.
  failProjection=true;successfulEnvironmentReads=0;await page.reload();
  await expect(page.locator('main').getByRole('alert').filter({hasText:'Controlled projection failure'}).first()).toBeVisible();
  const observedAtProjectionFailure=successfulEnvironmentReads;await expect.poll(()=>successfulEnvironmentReads).toBeGreaterThan(observedAtProjectionFailure);
  await expect(page.locator('main').getByRole('alert').filter({hasText:'Controlled projection failure'}).first()).toBeVisible();await expect(heading).toHaveCount(0);
  failProjection=false;await expect(heading).toBeVisible();await expect(page.getByText('Controlled projection failure',{exact:true})).toHaveCount(0);
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
