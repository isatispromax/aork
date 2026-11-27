import { openSettings } from '../fixtures/settings.js';
import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
async function launch(directory: string, distribution?: string) {
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', join(directory, 'data'), '--port', '0', '--insecure-loopback', ...(distribution ? ['--distribution-dir', distribution] : [])]);
  const exited = once(child, 'exit');
  const info = await new Promise<{url: string; accessUrl: string}>((resolve, reject) => { let stdout=''; let stderr=''; child.stdout.on('data', chunk=> {stdout+=String(chunk); const line=stdout.split('\n').find(line=>line.includes('host.listening'));if(line)resolve(JSON.parse(line));});child.stderr.on('data',chunk=>{stderr+=String(chunk);});child.on('error',reject);child.on('exit',code=>reject(new Error(`Host exited ${code}: ${stderr}`))); });
  return {...info, async close(){child.kill('SIGTERM');await exited;}};
}
test('authenticated settings shows rejected independent package and correction while valid UI remains usable', async ({page}) => {
  const directory = await mkdtemp(join(tmpdir(),'aork-diagnostic-browser-'));let host: Awaited<ReturnType<typeof launch>>|undefined;
  try {
    const manifest={manifestVersion:1,id:'browser-bad',version:'1.0.0',sdkRange:'^99.0.0',server:'server.js',ui:{providers:[]}};
    const archive=join(directory,'bad.aork-plugin');await writeFile(archive,JSON.stringify({archiveVersion:1,members:[['aork.plugin.json',JSON.stringify(manifest)],['server.js','throw new Error("private-agent-secret")']].map(([path,content])=>{const bytes=Buffer.from(content!);return {path,type:'file',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};})}));
    await execute(process.execPath,['dist/server/main.mjs','plugin','install',archive,'--data-dir',join(directory,'data')]).catch(error=>{expect(error.stderr).toContain('SDK_INCOMPATIBLE');});
    host=await launch(directory);await page.goto(host.url);expect((await page.request.get(`${host.url}/api/queries/plugins.diagnostics`)).status()).toBe(401);
    await page.goto(host.accessUrl);const settings=await openSettings(page,'诊断');await expect(page.getByRole('heading',{name:'插件诊断',exact:true})).toBeVisible();
    await expect(page.getByText('browser-bad@1.0.0',{exact:true})).toBeVisible();await expect(page.getByText('SDK_INCOMPATIBLE',{exact:true})).toBeVisible();await expect(page.getByText(/Correct the named package/)).toBeVisible();
    expect(await page.content()).not.toContain('private-agent-secret');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'/tmp/aork-ticket05-diagnostics.png',fullPage:true});await settings.getByRole('button',{name:'返回工作台',exact:true}).click();if(!await page.getByRole('button',{name:'退出访问',exact:true}).isVisible())await page.getByRole('button',{name:'切换导航',exact:true}).click();await page.getByRole('button',{name:'退出访问',exact:true}).click();await expect(page.getByRole('heading',{name:'需要工作台访问链接'})).toBeVisible();
  } finally {await page.goto('about:blank');await host?.close();await rm(directory,{recursive:true,force:true});}
});

test('an explicit compatible fallback handles a faulty selected renderer without switching to an arbitrary candidate',async({page})=>{
  const directory=await mkdtemp(join(tmpdir(),'aork-fallback-browser-'));const distribution=join(directory,'dist');let host:Awaited<ReturnType<typeof launch>>|undefined;
  try {
    await cp('dist',distribution,{recursive:true});
    const manifest={manifestVersion:1,id:'home-fallback',version:'1.0.0',sdkRange:'^0.1.0',client:'client.js',ui:{providers:[{id:'broken',contract:'aork.workbench.home@1'},{id:'backup',contract:'aork.workbench.home@1'}]}};
    const client=`import{createElement}from'react';export function activate(c){c.registerView('broken',()=>{throw Error('private-render-secret')});c.registerView('backup',()=>createElement('h1',null,'Explicit fallback home'));}`;
    const archive=join(directory,'fallback.aork-plugin');await writeFile(archive,JSON.stringify({archiveVersion:1,members:[['aork.plugin.json',JSON.stringify(manifest)],['client.js',client]].map(([path,source])=>{const bytes=Buffer.from(source!);return{path,type:'file',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};})}));
    const profilePath=join(directory,'profile.json');const profile=JSON.parse(await readFile(join(distribution,'profiles/personal-server.json'),'utf8'));profile.plugins.push({id:'home-fallback',version:'1.0.0',enabled:true});profile.ui.providers['aork.workbench.home@1']='home-fallback:broken';profile.ui.fallbacks={'aork.workbench.home@1':'home-fallback:backup'};await writeFile(profilePath,JSON.stringify(profile));
    await execute(process.execPath,['dist/server/main.mjs','plugin','install',archive,'--data-dir',join(directory,'data'),'--distribution-dir',distribution,'--profile',profilePath]);host=await launch(directory,distribution);await page.goto(host.accessUrl);
    await expect(page.getByRole('heading',{name:'Explicit fallback home'})).toBeVisible();expect(await page.content()).not.toContain('private-render-secret');
  }finally{await page.goto('about:blank');await host?.close();await rm(directory,{recursive:true,force:true});}
});
