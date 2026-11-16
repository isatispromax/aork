import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';
const agent = `import{createInterface}from'node:readline';import{existsSync,writeFileSync}from'node:fs';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}setInterval(()=>{if(existsSync('self-exit'))process.exit(0);},20);process.stdout.on('error',()=>{});const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'retained-native'}});if(r.method==='session/prompt'){writeFileSync('saved-notes.txt','saved file');send({method:'session/update',params:{sessionId:'retained-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved answer https://example.org/reference'}}}});}});`;
test('retained Session shows safe diagnostics and retries the original check command after a dropped reply on mobile', async ({ page }) => {
  const f=await sessionHost();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));let workspace:string|undefined;
  try {
    await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);workspace=env.workspace.directory;
    const session=(await(await f.command('sessions.create',env.input)).json()).result;
    await f.command('sessions.startRun',{sessionId:session.id});await expect.poll(async()=>(await(await f.query()).json()).sessions[0]?.execution.state).toBe('ready');
    await f.command('sessions.sendText',{sessionId:session.id,text:'Original input with source https://example.org/source'});
    await page.goto(f.host.accessUrl!);await page.evaluate(({session,env})=>{location.hash=new URLSearchParams({project:env.project.id,workspace:env.workspace.id,session:session.id}).toString();},{session,env});
    await expect(page.getByText('Saved answer https://example.org/reference',{exact:true})).toBeVisible();
    await f.crashAndRestart();await page.reload();await expect(page.getByText('运行状态未知',{exact:true})).toBeVisible();
    await expect(page.getByText('工作区保持保护；已保存的内容仍可查看。',{exact:true})).toBeVisible();
    await expect(page.getByText('Original input with source https://example.org/source',{exact:true})).toBeVisible();
    const ids:string[]=[];let first=true;
    await page.route('**/api/commands/sessions.recheckRun',async route=>{ids.push(route.request().postDataJSON().commandId);if(first){first=false;await route.fetch();await route.abort('failed');}else await route.continue();});
    await page.getByRole('button',{name:'再次核对',exact:true}).click();await expect(page.getByRole('button',{name:'重试核对回执',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'重试核对回执',exact:true}).click();await expect(page.getByRole('button',{name:'再次核对',exact:true})).toBeVisible();expect(ids).toHaveLength(2);expect(ids[1]).toBe(ids[0]);
    await page.route('**/api/snapshots/sessions.reconciliation?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'READ_UNAVAILABLE',message:'Temporary diagnostic read failure'}})}));
    await page.reload();await expect(page.getByText('Saved answer https://example.org/reference',{exact:true})).toBeVisible();await expect(page.getByText(/核对信息读取失败/)).toBeVisible();
    await page.unroute('**/api/snapshots/sessions.reconciliation?*');await page.reload();await expect(page.getByRole('button',{name:'再次核对',exact:true})).toBeVisible();
    await writeFile(join(workspace!,'self-exit'),'exit');await expect.poll(async()=>{const r=await(await f.command('sessions.recheckRun',{runId:(await(await f.query()).json()).sessions[0].execution.runId})).json();return r.result?.status;}).toBe('verified-stopped');
    await expect(page.getByText('已核实受管写入停止；队列仍保持暂停。',{exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket22-mobile.png',fullPage:true});expect(errors).toEqual([]);
  } finally {if(workspace)await writeFile(join(workspace!,'self-exit'),'exit');await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('an independently installed Detail consumes the same reconciliation snapshot and command',async({page})=>{
  const f=await sessionHost(true);let directory:string|undefined;
  try{
    await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);directory=env.workspace.directory;const session=(await(await f.command('sessions.create',env.input)).json()).result;
    await f.command('sessions.startRun',{sessionId:session.id});await expect.poll(async()=>(await(await f.query()).json()).sessions[0]?.execution.state).toBe('ready');
    await f.command('sessions.sendText',{sessionId:session.id,text:'Independent retained input'});await f.crashAndRestart();await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({project:env.project.id,workspace:env.workspace.id,session:session.id}).toString();},{env,session});
    await expect(page.getByRole('heading',{name:'独立历史视图'})).toBeVisible();await expect(page.getByText('独立核对状态 blocked',{exact:true})).toBeVisible();await expect(page.getByText('Independent retained input',{exact:true})).toBeVisible();await page.getByRole('button',{name:'独立再次核对',exact:true}).click();await expect(page.getByText('独立核对状态 blocked',{exact:true})).toBeVisible();
    await writeFile(join(directory!,'self-exit'),'exit');const group=(await(await f.query()).json()).sessions[0].execution.processIdentity.group;await expect.poll(()=>{try{process.kill(-group,0);return false;}catch(error){return(error as NodeJS.ErrnoException).code==='ESRCH';}}).toBe(true);await page.getByRole('button',{name:'独立再次核对',exact:true}).click();await expect(page.getByText('独立核对状态 verified-stopped',{exact:true})).toBeVisible();
  }finally{if(directory)await writeFile(join(directory,'self-exit'),'exit');await page.goto('about:blank').catch(()=>{});await f.close();}
});
