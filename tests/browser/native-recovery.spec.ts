import{readFile,writeFile}from'node:fs/promises';
import{expect,test}from'@playwright/test';
import{nativeRecoveryFixture}from'../fixtures/native-recovery.js';
test('explicit native recovery and separate saved history survive refresh on mobile',async({page})=>{
 const{f,env,session,nativePath}=await nativeRecoveryFixture();try{
  const native=JSON.parse(await readFile(nativePath,'utf8'));native.push({role:'agent',text:'Same-text distinct native message',messageId:'distinct-one'},{role:'agent',text:'Same-text distinct native message',messageId:'distinct-two'});await writeFile(nativePath,JSON.stringify(native));
  await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({workspace:env.workspace.id,session:session.id}).toString();},{env,session});
  await expect(page.getByRole('button',{name:'恢复原生会话',exact:true})).toBeVisible();await page.getByRole('button',{name:'恢复原生会话',exact:true}).click();
  await expect(page.getByRole('region',{name:'原生恢复历史'})).toContainText('Retain original input');await expect(page.getByText('队列已暂停',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('region',{name:'原生恢复历史'})).toContainText('Retain original input');await expect(page.getByText('Retain original input',{exact:true})).toHaveCount(2);await expect(page.getByText('Saved answer',{exact:true})).toHaveCount(2);await expect(page.getByRole('region',{name:'原生恢复历史'}).getByText('Same-text distinct native message',{exact:true})).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket23-mobile.png',fullPage:true});
 }finally{await page.goto('about:blank');await f.close();}
});
test('an independently built archive replaces recovery and native history through the same public commands and snapshots',async({page})=>{
 const{f,env,session}=await nativeRecoveryFixture('recovery');try{await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({workspace:env.workspace.id,session:session.id}).toString();},{env,session});await expect(page.getByRole('heading',{name:'独立原生恢复'})).toBeVisible();await page.getByRole('button',{name:'独立恢复'}).click();await expect(page.getByRole('region',{name:'独立原生历史'})).toContainText('Saved answer');await f.restart();await page.reload();await expect(page.getByRole('region',{name:'独立原生历史'})).toContainText('Saved answer');}finally{await page.goto('about:blank');await f.close();}
});
test('a saved interrupted prefix never hides the complete recovered message with the same reliable native ID',async({page})=>{
 const{f,env,session}=await nativeRecoveryFixture(false,'interrupted-prefix');try{
  const timeline=await(await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`,{headers:{Cookie:f.cookie}})).json();expect(timeline.turns[0].state).toBe('interrupted');expect(timeline.messages.filter((message:any)=>message.role==='agent').map((message:any)=>message.text).join('')).toBe('Saved prefix. ');
  await f.command('sessions.recoverNative',{sessionId:session.id});await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({workspace:env.workspace.id,session:session.id}).toString();},{env,session});
  const native=page.getByRole('region',{name:'原生恢复历史'});await expect(native).toContainText('Saved prefix. Complete recovered suffix.');await page.reload();await expect(native).toContainText('Saved prefix. Complete recovered suffix.');await expect(page.getByRole('region',{name:'会话消息',exact:true})).toContainText('Saved prefix.');
 }finally{await page.goto('about:blank');await f.close();}
});
test('a completed answer whose bounded live timeline omitted earlier chunks keeps its full recovered native content',async({page})=>{
 const{f,env,session}=await nativeRecoveryFixture(false,'large-completed');try{
  const timeline=await(await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`,{headers:{Cookie:f.cookie}})).json();expect(timeline.turns[0].state).toBe('completed');expect(timeline.truncated).toBe(true);expect(timeline.completedReplies).toEqual([]);expect(timeline.messages.some((message:any)=>message.messageId==='agent-0')).toBe(true);expect(JSON.stringify(timeline.messages)).not.toContain('Native beginning omitted from live timeline.');
  await f.command('sessions.recoverNative',{sessionId:session.id});await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({workspace:env.workspace.id,session:session.id}).toString();},{env,session});const native=page.getByRole('region',{name:'原生恢复历史'});await expect(native).toContainText('Native beginning omitted from live timeline.');
  for(let n=0;n<30;n++){const more=native.getByRole('button',{name:'更多原生历史',exact:true});if(!await more.count())break;await more.click();await expect(native.getByRole('button',{name:'正在读取…'})).toHaveCount(0);}await expect(native).toContainText('Native final recovered content.');
 }finally{await page.goto('about:blank');await f.close();}
});
