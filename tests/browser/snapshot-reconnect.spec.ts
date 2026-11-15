import { expect, test } from '@playwright/test';
import { snapshotHost } from '../fixtures/snapshot-host.js';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('online transport-only access failures retain the applied view until an authoritative logout',async({page})=>{
  const f=await snapshotHost();let disconnect:undefined|(()=>void);let failing=false;let attempts=0;
  try{
    await page.routeWebSocket('**/api/events?*',ws=>{const server=ws.connectToServer();disconnect=()=>server.close();});
    await page.route('**/api/queries/auth.status',async route=>{if(failing){attempts++;await route.abort('failed');}else await route.continue();});
    await page.goto(f.host.accessUrl!);await expect(page.getByTestId('saved-items')).toHaveText('[]');
    await f.command('fixture.add',{id:'kept-before-network-fault'});
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"kept-before-network-fault"}]');
    failing=true;await expect.poll(()=>Boolean(disconnect)).toBe(true);disconnect!();
    await expect.poll(()=>attempts).toBeGreaterThan(0);
    expect(await page.evaluate(()=>navigator.onLine)).toBe(true);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"kept-before-network-fault"}]');
    await f.command('fixture.add',{id:'recovered-without-new-auth-result'});
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"kept-before-network-fault"},{"id":"recovered-without-new-auth-result"}]');
    // Include the independent periodic access probe, not just reconnect admission.
    await expect.poll(()=>attempts,{timeout:6500}).toBeGreaterThan(1);
    await expect(page.getByTestId('saved-items')).toHaveCount(1);
    failing=false;await page.getByRole('button',{name:'退出访问',exact:true}).click();
    await expect(page.getByTestId('saved-items')).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'需要工作台访问链接',exact:true})).toBeVisible();
    expect((await page.request.get(`${f.host.url}/api/snapshots/fixture.items`,{headers:{'X-Aork-Graph':f.bootstrap.pluginGraphHash}})).status()).toBe(401);
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('server resync cancels a hung replacement read and fences its late response without concurrent application',async({page})=>{
  const f=await snapshotHost();let reads=0;let blocked=false;let released=false;let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});let lateAttempted=false;const frames:Array<{kind:string;reason?:string}>=[];let connections=0;
  try{
    await page.routeWebSocket('**/api/events?*',ws=>{connections++;const server=ws.connectToServer();server.onMessage(message=>{frames.push(JSON.parse(String(message)));ws.send(message);});});
    await page.route('**/api/snapshots/fixture.items*',async route=>{
      if(++reads===2){
        const response=await route.fetch(); // Capture a real, now stale owner snapshot.
        blocked=true;await pending;lateAttempted=true;
        await route.fulfill({response}).catch(()=>{});return;
      }
      await route.continue();
    });
    await page.goto(f.host.accessUrl!);await expect(page.getByTestId('saved-items')).toHaveText('[]');
    await expect.poll(()=>connections).toBe(1);
    await f.command('fixture.add',{id:'event-before-hung-http'});await expect.poll(()=>blocked).toBe(true);
    await f.command('fixture.add',{id:'newer-than-held-response'});
    await expect.poll(()=>frames.some(frame=>frame.kind==='resync'&&frame.reason==='slow-consumer'),{timeout:7000}).toBe(true);
    // No manual release of the stalled request is needed for autonomous recovery.
    expect(released).toBe(false);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"event-before-hung-http"},{"id":"newer-than-held-response"}]',{timeout:2000});
    expect(reads).toBeGreaterThan(2);expect(connections).toBeGreaterThan(1);
    release();released=true;await expect.poll(()=>lateAttempted).toBe(true);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"event-before-hung-http"},{"id":"newer-than-held-response"}]');
    await f.command('fixture.add',{id:'still-live-after-late-result'});
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"event-before-hung-http"},{"id":"newer-than-held-response"},{"id":"still-live-after-late-result"}]');
  }finally{release();await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('an authoritative revocation control frame clears protected state during a pending replacement read',async({page})=>{
  const f=await snapshotHost();let reads=0;let blocked=false;let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});const frames:Array<{kind:string;state?:string}>=[];
  try{
    await f.command('fixture.add',{id:'protected-before-revocation'});
    await page.routeWebSocket('**/api/events?*',ws=>{const server=ws.connectToServer();server.onMessage(message=>{frames.push(JSON.parse(String(message)));ws.send(message);});});
    await page.route('**/api/snapshots/fixture.items*',async route=>{if(++reads===2){blocked=true;await pending;await route.abort('failed').catch(()=>{});return;}await route.continue();});
    await page.goto(f.host.accessUrl!);await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"protected-before-revocation"}]');
    await expect.poll(()=>frames.some(frame=>frame.kind==='ready')).toBe(true);
    await f.command('fixture.add',{id:'pending-before-revocation'});await expect.poll(()=>blocked).toBe(true);
    const boot=await(await page.request.get(`${f.host.url}/api/bootstrap`)).json();
    const revoked=await page.request.post(`${f.host.url}/api/commands/auth.logout`,{headers:{Origin:f.host.url,'X-Aork-CSRF':boot.access.csrfToken},data:{apiVersion:1,commandVersion:1,commandId:crypto.randomUUID(),pluginGraphHash:boot.pluginGraphHash,payload:{}}});
    expect(revoked.status()).toBe(200);
    await expect.poll(()=>frames.some(frame=>frame.kind==='access'&&frame.state==='unauthenticated')).toBe(true);
    await expect(page.getByTestId('saved-items')).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'需要工作台访问链接',exact:true})).toBeVisible();
  }finally{release();await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('transport failure grants no initial access and explicit authorization unavailability clears an applied view',async({page})=>{
  const f=await snapshotHost();let disconnect:undefined|(()=>void);
  try{
    await page.route('**/api/queries/auth.status',route=>route.abort('failed'));
    await page.goto(f.host.url);await expect(page.getByTestId('saved-items')).toHaveCount(0);
    await page.getByRole('button',{name:'重新检查访问权限',exact:true}).click();
    await expect(page.getByRole('heading',{name:'需要工作台访问链接',exact:true})).toBeVisible();
    await page.unroute('**/api/queries/auth.status');
    await page.routeWebSocket('**/api/events?*',ws=>{const server=ws.connectToServer();disconnect=()=>server.close();});
    await page.goto(f.host.accessUrl!);await expect(page.getByTestId('saved-items')).toHaveText('[]');
    await f.command('fixture.add',{id:'requires-live-authorization'});
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"requires-live-authorization"}]');
    await page.route('**/api/queries/auth.status',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'AUTH_UNAVAILABLE',message:'Authorization service is unavailable'}})}));
    await expect.poll(()=>Boolean(disconnect)).toBe(true);disconnect!();
    await expect(page.getByTestId('saved-items')).toHaveCount(0);
    await expect(page.getByText('认证服务暂时不可用',{exact:true})).toBeVisible();
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('an independently installed UI recovers saved items after offline, failed application, and reload', async ({ page, context }) => {
  const f = await snapshotHost();
  try {
    await page.goto(f.host.accessUrl!);
    await expect(page.getByTestId('saved-items')).toHaveText('[]');
    expect((await f.command('fixture.add', { id: 'before-offline' })).status).toBe(200);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"before-offline"}]');
    await context.setOffline(true);
    expect((await f.command('fixture.add', { id: 'during-offline' })).status).toBe(200);
    await page.waitForTimeout(5600);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"before-offline"}]');
    await context.setOffline(false);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"before-offline"},{"id":"during-offline"}]');
    await page.getByRole('button', {name:'Fail next application'}).click();
    expect((await f.command('fixture.add', { id: 'after-failure' })).status).toBe(200);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"after-failure"},{"id":"before-offline"},{"id":"during-offline"}]');
    await page.reload();
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"after-failure"},{"id":"before-offline"},{"id":"during-offline"}]');
    const authoritative=await(await fetch(`${f.host.url}/api/snapshots/fixture.items`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}})).json();
    expect(JSON.parse(await page.getByTestId('saved-items').innerText())).toEqual(authoritative.snapshot);
  } finally { await page.goto('about:blank').catch(()=>{}); await f.close(); }
});

test('a delayed owner projection emits a new cursor after unrelated higher events',async({page})=>{
  const f=await snapshotHost(true);
  try{
    await f.command('fixture.add',{id:'projected-later'});
    await page.goto(f.host.accessUrl!);
    await expect(page.getByTestId('saved-items')).toHaveText('[]');
    await f.command('workspace.createProject',{name:'Unrelated higher cursor',workspace:{name:'Notes',management:'managed'}});
    expect((await f.command('projection.release',{})).status).toBe(200);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"projected-later"}]');
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('duplicate public frames and disconnect before application recover without advancing an unapplied cursor',async({page,context})=>{
  const f=await snapshotHost();let blocked=false;let reads=0;let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});const urls:string[]=[];const acknowledgements:string[]=[];
  try{
    await page.routeWebSocket('**/api/events?*',ws=>{
      urls.push(ws.url());const server=ws.connectToServer();let duplicated=false;
      ws.onMessage(message=>{acknowledgements.push(String(message));server.send(message);});
      server.onMessage(message=>{ws.send(message);const frame=JSON.parse(String(message));if(frame.kind==='events'&&!duplicated){duplicated=true;ws.send(message);}});
    });
    await page.route('**/api/snapshots/fixture.items*',async route=>{
      if(++reads===2){blocked=true;await pending;await route.abort('internetdisconnected');return;}
      await route.continue();
    });
    await page.goto(f.host.accessUrl!);await expect(page.getByTestId('saved-items')).toHaveText('[]');
    await f.command('fixture.add',{id:'received-before-apply'});
    await expect.poll(()=>blocked).toBe(true);
    await expect(page.getByTestId('saved-items')).toHaveText('[]');
    expect(acknowledgements).toEqual([]);
    await context.setOffline(true);release();await context.setOffline(false);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"received-before-apply"}]');
    await f.command('fixture.add',{id:'second-id'});
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"received-before-apply"},{"id":"second-id"}]');
    expect(urls.every(url=>!new URL(url).searchParams.has('token'))).toBe(true);
    expect(new URL(urls[0]!).searchParams.get('cursor')).toBe('0');
    await page.screenshot({path:'/tmp/aork-ticket14-independent-reconnect.png',fullPage:true});
  }finally{release();await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('default Session views recover chunks and tools while browser loss leaves the actual Run and ACP prompt alone',async({page,context})=>{
  const f=await sessionHost();
  try{
    await writeFile(join(f.directory,'controlled-agent.mjs'),`import{createInterface}from'node:readline';import{appendFileSync,existsSync}from'node:fs';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('recovery-wire',JSON.stringify(r)+'\\n');if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'recovery-native'}});if(r.method==='session/prompt'){send({method:'session/update',params:{sessionId:'recovery-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'First saved. '}}}});const timer=setInterval(()=>{if(!existsSync('release-recovery'))return;clearInterval(timer);send({method:'session/update',params:{sessionId:'recovery-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Second saved 🌏'}}}});send({method:'session/update',params:{sessionId:'recovery-native',update:{sessionUpdate:'tool_call',toolCallId:'recovered-report',title:'Recovered tool report',kind:'read',status:'completed'}}});send({id:r.id,result:{stopReason:'end_turn'}});},20);}});`);
    const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
    await f.command('sessions.startRun',{sessionId:session.id});
    await expect.poll(async()=>(await(await f.query()).json()).sessions[0]?.execution.state).toBe('ready');
    await page.goto(f.host.accessUrl!);await page.evaluate(input=>{location.hash=new URLSearchParams(input).toString();},{project:env.project.id,workspace:env.workspace.id,session:session.id});
    const messages=page.getByRole('region',{name:'会话消息',exact:true});
    await f.command('sessions.sendText',{sessionId:session.id,text:'one prompt only'});
    await expect(messages.getByText('First saved. ',{exact:true})).toBeVisible();
    await context.setOffline(true);
    expect((await(await f.query()).json()).sessions[0].execution.state).toBe('ready');
    await writeFile(join(env.workspace.directory,'release-recovery'),'go');
    await expect.poll(async()=>{const response=await fetch(`${f.host.url}/api/snapshots/sessions.timeline?sessionId=${session.id}`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}});return(await response.json()).snapshot.turns[0].state;}).toBe('completed');
    await context.setOffline(false);
    await expect(messages.getByText('First saved. Second saved 🌏',{exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'工具报告',exact:true}).getByText('Recovered tool report',{exact:true})).toBeVisible();
    await page.reload();await expect(messages.getByText('First saved. Second saved 🌏',{exact:true})).toHaveCount(1);
    const wire=(await readFile(join(env.workspace.directory,'recovery-wire'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(wire.filter(r=>r.method==='session/prompt')).toHaveLength(1);expect(wire.filter(r=>r.method==='session/cancel')).toHaveLength(0);
    expect((await(await f.query()).json()).sessions[0].execution.state).toBe('ready');
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
