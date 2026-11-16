import { expect, test } from '@playwright/test';
import { largeInputHost } from '../fixtures/large-input-host.js';

test('every large-configuration queued input remains visible, removable and expandable through the public detail interface',async({page})=>{
 const{f,env,session}=await largeInputHost();try{
  const responses=await Promise.all(Array.from({length:100},(_,index)=>f.command('sessions.sendText',{sessionId:session.id,text:`queue-visible-${index}`})));expect(responses.every(response=>response.status===200)).toBe(true);const receipts=await Promise.all(responses.map(response=>response.json()));const firstIndex=receipts.findIndex(receipt=>receipt.result.acceptanceOrder===2);
  await page.goto(f.host.accessUrl);await page.evaluate(value=>{location.hash=new URLSearchParams(value).toString();},{project:env.project.id,workspace:env.workspace.id,session:session.id});const queue=page.getByRole('region',{name:'待发队列',exact:true});await expect(queue.getByRole('button',{name:/移除排队输入/})).toHaveCount(100);await expect(page.getByRole('button',{name:'取消当前轮次',exact:true})).toBeVisible();
  await expect(queue.getByLabel('查看完整排队输入 2',{exact:true})).toBeVisible();await queue.getByLabel('查看完整排队输入 2',{exact:true}).click();const detail=queue.getByRole('region',{name:'轮次原始输入与配置',exact:true});await expect(detail).toContainText(`queue-visible-${firstIndex}`);await expect(detail).toContainText('choice-99');await queue.getByLabel('查看完整排队输入 2',{exact:true}).click();
  for(const order of [2,52,101])await queue.getByRole('button',{name:`移除排队输入 ${order}`,exact:true}).click();await expect(queue.getByRole('button',{name:/移除排队输入/})).toHaveCount(97);await page.reload();await expect(queue.getByRole('button',{name:/移除排队输入/})).toHaveCount(97);await expect(queue.getByRole('button',{name:'移除排队输入 3',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/aork-ticket17-large-queue-mobile.png'});
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('an independently installed UI expands omitted immutable details using the same public resource and schema',async({page})=>{
 const{f,env,session}=await largeInputHost(undefined,'turns');try{
  const responses=await Promise.all(Array.from({length:100},(_,index)=>f.command('sessions.sendText',{sessionId:session.id,text:`independent-queue-${index}`})));expect(responses.every(response=>response.status===200)).toBe(true);const receipts=await Promise.all(responses.map(response=>response.json()));const firstIndex=receipts.findIndex(receipt=>receipt.result.acceptanceOrder===2);await page.goto(f.host.accessUrl);await page.evaluate(value=>{location.hash=new URLSearchParams(value).toString();},{project:env.project.id,workspace:env.workspace.id,session:session.id});const messages=page.getByRole('region',{name:'独立消息视图',exact:true});await expect(messages.getByRole('button',{name:/独立完整输入/})).toHaveCount(101);await messages.getByRole('button',{name:'独立完整输入 2',exact:true}).click();const detail=messages.getByRole('region',{name:'独立原始输入',exact:true});await expect(detail).toContainText(`independent-queue-${firstIndex}`);await expect(detail).toContainText('choice-99');
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
