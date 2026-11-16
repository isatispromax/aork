import{expect,test}from'@playwright/test';
import{nativeRecoveryFixture}from'../fixtures/native-recovery.js';
test('explicit native recovery and separate saved history survive refresh on mobile',async({page})=>{
 const{f,env,session}=await nativeRecoveryFixture();try{
  await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({project:env.project.id,workspace:env.workspace.id,session:session.id}).toString();},{env,session});
  await expect(page.getByRole('button',{name:'恢复原生会话',exact:true})).toBeVisible();await page.getByRole('button',{name:'恢复原生会话',exact:true}).click();
  await expect(page.getByRole('region',{name:'原生恢复历史'})).toContainText('Retain original input');await expect(page.getByText('队列已暂停',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('region',{name:'原生恢复历史'})).toContainText('Retain original input');await expect(page.getByText('Retain original input',{exact:true})).toHaveCount(2);await expect(page.getByText('Saved answer',{exact:true})).toHaveCount(1);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket23-mobile.png',fullPage:true});
 }finally{await page.goto('about:blank');await f.close();}
});
test('an independently built archive replaces recovery and native history through the same public commands and snapshots',async({page})=>{
 const{f,env,session}=await nativeRecoveryFixture('recovery');try{await page.goto(f.host.accessUrl!);await page.evaluate(({env,session})=>{location.hash=new URLSearchParams({project:env.project.id,workspace:env.workspace.id,session:session.id}).toString();},{env,session});await expect(page.getByRole('heading',{name:'独立原生恢复'})).toBeVisible();await page.getByRole('button',{name:'独立恢复'}).click();await expect(page.getByRole('region',{name:'独立原生历史'})).toContainText('Saved answer');await f.restart();await page.reload();await expect(page.getByRole('region',{name:'独立原生历史'})).toContainText('Saved answer');}finally{await page.goto('about:blank');await f.close();}
});
