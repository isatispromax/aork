import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from '../fixtures/session-host.js';
test('public Session UI starts a real ACP Run, survives browser disconnect and ends with a fresh-native-context warning',async({page})=>{
  const f=await sessionHost();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await writeFile(join(f.directory,'controlled-agent.mjs'),`import {createInterface} from 'node:readline';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);let result;if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:false},agentInfo:{name:'controlled-browser-acp',version:'1.2.3'},authMethods:[]};else if(r.method==='session/new')result={sessionId:'browser-native-context'};else continue;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}`);
    const env=await sessionEnvironment(f);await page.goto(f.host.accessUrl!);await page.evaluate(({projectId,workspaceId})=>{location.hash=new URLSearchParams({project:projectId,workspace:workspaceId}).toString();},env.input);
    await page.getByRole('button',{name:'新建会话',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('会话名称').fill('Actual ACP session');await dialog.getByLabel('Agent Profile').selectOption(env.profile.id);await dialog.getByRole('button',{name:'创建会话',exact:true}).click();
    await page.getByRole('button',{name:'启动运行',exact:true}).click();await expect(page.getByText('运行已就绪',{exact:true})).toBeVisible();await expect(page.getByText('1.2.3',{exact:true})).toHaveCount(2);await expect(page.getByText('不支持',{exact:true})).toBeVisible();await expect(page.getByText('工作区占用用于协调可信 Agent 和插件，不构成操作系统安全沙箱。',{exact:true})).toBeVisible();
    const url=page.url();await page.goto('about:blank');expect((await(await f.query()).json()).sessions[0].execution.state).toBe('ready');await page.goto(url);await expect(page.getByText('运行已就绪',{exact:true})).toBeVisible();await expect(page.getByText('结束运行将停止受管进程与登记任务后释放占用；下次启动会创建新的原生会话。此处不自动休眠。',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'结束运行',exact:true}).click();await expect(page.getByText('运行已结束',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'启动运行',exact:true})).toBeVisible();await page.screenshot({path:'/tmp/aork-ticket11-run.png',fullPage:true});expect(errors).toEqual([]);
  }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
