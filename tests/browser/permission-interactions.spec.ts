import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { permissionHost, permissionWire, startPermission, waitPermission } from '../fixtures/permission-host.js';
async function show(page:Page,f:Awaited<ReturnType<typeof permissionHost>>,session:{id:string;workspaceId:string}){await page.goto(f.host.accessUrl);await page.evaluate(session=>{location.hash=new URLSearchParams({session:session.id,workspace:session.workspaceId}).toString();},session);}
async function close(contexts:BrowserContext[],f:Awaited<ReturnType<typeof permissionHost>>){await Promise.all(contexts.map(context=>context.close()));await f.close();}

test('two actual browser contexts compete for one permission and only the selected native response is written',async({browser})=>{
 const f=await permissionHost();expect(f.bootstrap.ui.providers['aork.sessions.detail@1']).toBe('sessions:detail');const contexts=[await browser.newContext(),await browser.newContext()];
 try{const {env,session}=await startPermission(f);const pages=await Promise.all(contexts.map(context=>context.newPage()));await Promise.all(pages.map(page=>show(page,f,session)));
 const forms=pages.map(page=>page.getByLabel('权限审批表单',{exact:true}));await Promise.all(forms.map(form=>expect(form.getByRole('button',{name:'Allow once',exact:true})).toBeVisible()));await pages[0]!.screenshot({path:'/tmp/aork-ticket15-permission-desktop.png',fullPage:true});
 const waiting:Route[]=[];let release!:()=>void;const both=new Promise<void>(resolve=>release=resolve);const statuses:number[]=[];
 await Promise.all(pages.map(page=>page.route('**/api/commands/interactions.respond',async route=>{waiting.push(route);if(waiting.length===2)release();await both;await route.continue();})));
 pages.forEach(page=>page.on('response',response=>{if(response.url().endsWith('/api/commands/interactions.respond'))statuses.push(response.status());}));
 await Promise.all([forms[0]!.getByRole('button',{name:'Allow once',exact:true}).click(),forms[1]!.getByRole('button',{name:'Reject once',exact:true}).click()]);
 await expect.poll(()=>statuses.sort()).toEqual([200,409]);
 // Under load a losing context's snapshot stream can miss the resolution
 // push; the durable outcome above is authoritative, so the responded
 // label is retried across one bounded reload per page.
 await Promise.all(pages.map(page=>expect.poll(async()=>{if(await page.getByText('已发送响应',{exact:true}).count())return true;await page.reload();return (await page.getByText('已发送响应',{exact:true}).count())>0;},{timeout:15_000}).toBe(true)));
 expect((await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result?.outcome?.outcome==='selected')).toHaveLength(1);
 await expect(pages[0]!.getByText('Agent continued after response',{exact:true})).toHaveCount(0);await writeFile(join(f.directory,'continue'),'continue');await expect(pages[0]!.getByText('Agent continued after response',{exact:true})).toBeVisible();
 }finally{await close(contexts,f);}
});

test('a dropped accepted HTTP response retries the same command without a second native approval and stays usable at 390px',async({browser})=>{
 const f=await permissionHost();const context=await browser.newContext();const contexts=[context];
 try{const {env,session}=await startPermission(f);const page=await context.newPage();await page.setViewportSize({width:390,height:844});await show(page,f,session);await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket15-permission-pending-mobile.png',fullPage:true});const ids:string[]=[];
 await page.route('**/api/commands/interactions.respond',async route=>{ids.push(route.request().postDataJSON().commandId);const response=await route.fetch();if(ids.length===1)await route.abort('failed');else await route.fulfill({response});});
 await page.getByRole('button',{name:'Allow once',exact:true}).click();await expect(page.getByRole('button',{name:'重试同一响应',exact:true})).toBeVisible();await page.getByRole('button',{name:'重试同一响应',exact:true}).click();
 await expect(page.getByText('已发送响应',{exact:true})).toBeVisible();await expect.poll(()=>ids.length).toBe(2);expect(ids[1]).toBe(ids[0]);expect((await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result?.outcome?.outcome==='selected')).toHaveLength(1);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket15-permission-mobile.png',fullPage:true});
 }finally{await close(contexts,f);}
});

test('cancelling permission from the public composer disables stale approval without releasing the healthy Run',async({browser})=>{
 const f=await permissionHost();const context=await browser.newContext();const contexts=[context];
 try{const {env,session,interaction}=await startPermission(f);const page=await context.newPage();await show(page,f,session);await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();await page.getByRole('button',{name:'取消当前轮次',exact:true}).click();
 await expect(page.getByText('响应已取消',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
 expect((await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-once'})).status).toBe(409);expect((await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result?.outcome?.outcome==='selected')).toHaveLength(0);await waitPermission(async()=>await(await f.query()).json(),value=>value.sessions[0]?.execution.state==='ready');
 }finally{await close(contexts,f);}
});

test('an independently installed package replaces both permission contracts under the fixed Host and keeps the public response gate',async({browser})=>{
 const hash=createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');const f=await permissionHost(true);const context=await browser.newContext();const contexts=[context];
 try{const {env,session,interaction}=await startPermission(f);expect(createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex')).toBe(hash);expect(f.bootstrap.ui.providers['aork.sessions.detail@1']).toBe('sessions:detail');for(const name of ['cards','permission'])expect(f.bootstrap.ui.providers[`aork.interactions.${name}@1`]).toBe(`independent-permission-view:${name}`);
 const page=await context.newPage();await show(page,f,session);await expect(page.getByRole('region',{name:'独立权限卡片',exact:true})).toBeVisible();await page.getByRole('button',{name:'独立选择 Reject once',exact:true}).click();await expect(page.getByRole('region',{name:'独立权限卡片',exact:true}).getByText('responded',{exact:true})).toBeVisible();
 expect((await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-once'})).status).toBe(409);expect((await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result).map(value=>value.result)).toEqual([{outcome:{outcome:'selected',optionId:'deny-once'}}]);
 await page.screenshot({path:'/tmp/aork-ticket15-independent-permission-desktop.png',fullPage:true});
 }finally{await close(contexts,f);}
});

test('the retained permission form explains its own snapshot failure and recovers without consuming or repeating a choice',async({browser})=>{
 const f=await permissionHost('cards');const context=await browser.newContext();const contexts=[context];
 try{const {env,session}=await startPermission(f);const page=await context.newPage();await show(page,f,session);const form=page.getByLabel('权限审批表单',{exact:true});const allow=form.getByRole('button',{name:'Allow once',exact:true});await expect(allow).toBeEnabled();
 let unavailable=true;const message='Permission form snapshot temporarily unavailable';
 await page.route('**/api/snapshots/interactions.history?**',async route=>{if(unavailable)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SNAPSHOT_TEMPORARILY_UNAVAILABLE',message}})});else await route.continue();});
 // A second real Interaction invalidates both independent public observers.
 // Its Cards provider reads pending successfully while the form's history
 // request alone fails after retaining its previously displayed permission.
 await startPermission(f);await waitPermission(async()=>await(await f.query('interactions.pending')).json(),value=>value.pending.length===2);
 await expect(allow).toBeDisabled();await expect(page.getByRole('region',{name:'独立待处理权限卡片',exact:true}).getByText('Write research notes',{exact:true})).toBeVisible();await expect(form.getByRole('alert')).toHaveText(message);
 expect((await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result?.outcome?.outcome==='selected')).toHaveLength(0);
 unavailable=false;await expect(allow).toBeEnabled({timeout:10000});await expect(form.getByRole('alert')).toHaveCount(0);await allow.click();
 await expect.poll(async()=>(await permissionWire(env.workspace.directory)).filter(value=>value.id===0&&value.result?.outcome?.outcome==='selected').length).toBe(1);
 }finally{await close(contexts,f);}
});
