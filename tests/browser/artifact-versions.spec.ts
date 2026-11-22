import {expect,test}from'@playwright/test';
import{writeFile,readFile}from'node:fs/promises';
import{join}from'node:path';
import{sessionHost,sessionEnvironment}from'../fixtures/session-host.js';
test('contextual file capture, pinned immutable version preview and download work at 390px',async({page})=>{
 const f=await sessionHost();try{const env=await sessionEnvironment(f);await writeFile(join(env.workspace.directory,'report.html'),'<script>window.ARTIFACT_EXECUTED=true</script>');await page.goto(f.host.accessUrl!);await page.evaluate(env=>{location.hash=new URLSearchParams({workspace:env.workspace.id,file:'report.html',keep:'unrelated'}).toString();},env);
 await page.getByLabel('更多菜单').click();await page.getByRole('button',{name:'保存当前文件版本',exact:true}).click();const dialog=page.getByRole('dialog',{name:'保存产物版本'});await dialog.getByLabel('产物名称').fill('Saved report');await dialog.getByRole('button',{name:'登记版本',exact:true}).click();const saved=page.getByRole('dialog',{name:'已保存版本'});await expect(saved).toContainText('由用户显式登记');await expect(saved.getByRole('region',{name:'产物预览'})).toContainText('不可变文件副本 · text/html');await expect(page.locator('iframe[title="主动内容受限预览"]')).toBeVisible();expect(await page.locator('iframe[title="主动内容受限预览"]').getAttribute('srcdoc')).toContain('<script>window.ARTIFACT_EXECUTED=true</script>');expect(await page.evaluate(()=>'ARTIFACT_EXECUTED'in window)).toBe(false);
 const identity=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.slice(1))));expect(identity.keep).toBe('unrelated');await writeFile(join(env.workspace.directory,'report.html'),'new file contents');const added=await f.command('artifacts.register',{workspaceId:env.workspace.id,artifactId:identity.artifact,title:'Saved report',source:{kind:'captured-file',workspaceId:env.workspace.id,relativePath:'report.html'}});expect(added.status).toBe(200);await expect(saved.getByLabel('产物版本')).toContainText('版本 2');expect(await page.evaluate(()=>new URLSearchParams(location.hash.slice(1)).get('artifactVersion'))).toBe(identity.artifactVersion);await expect.poll(async()=>page.locator('iframe[title="主动内容受限预览"]').getAttribute('srcdoc')).toContain('ARTIFACT_EXECUTED');
 const download=page.waitForEvent('download');await saved.getByRole('button',{name:'下载此版本'}).click();expect(await readFile((await(await download).path())!,'utf8')).toBe('<script>window.ARTIFACT_EXECUTED=true</script>');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(saved.getByRole('button',{name:'下载此版本'})).toBeVisible();await saved.getByRole('button',{name:'关闭产物'}).click();await expect(saved).toHaveCount(0);
 }finally{await page.goto('about:blank');await f.close();}
});

test('switching artifacts selects the new version and switching versions resets download controls', async ({ page }) => {
  const f = await sessionHost();
  let releaseDownload = () => {};
  try {
    const { workspace } = await sessionEnvironment(f);
    async function capture(title: string, content: string, artifactId?: string) {
      await writeFile(join(workspace.directory, 'report.txt'), content);
      const receipt = await f.command('artifacts.register', {
        workspaceId: workspace.id,
        title,
        ...(artifactId ? { artifactId } : {}),
        source: { kind: 'captured-file', workspaceId: workspace.id, relativePath: 'report.txt' },
      });
      expect(receipt.status).toBe(200);
      return (await receipt.json()).result as { artifactId: string; versionId: string };
    }
    const first = await capture('First report', 'First report version');
    const second = await capture('Second report', 'Second report original');
    const latest = await capture('Second report', 'Second report updated', second.artifactId);
    await page.goto(f.host.accessUrl!);
    await page.evaluate(({ workspaceId, artifact, version }) => {
      location.hash = new URLSearchParams({ workspace: workspaceId, artifact, artifactVersion: version }).toString();
    }, { workspaceId: workspace.id, artifact: first.artifactId, version: first.versionId });
    await page.getByLabel('更多菜单').click();
    await page.getByRole('button', { name: '已保存版本', exact: true }).click();
    const saved = page.getByRole('dialog', { name: '已保存版本' });
    const preview = saved.getByRole('region', { name: '产物预览' });
    await expect(preview).toContainText('First report version');
    await saved.getByRole('button', { name: /Second report/ }).click();
    await expect(preview).toContainText('Second report updated');

    const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
    await page.route(url => url.pathname === '/api/resources/artifacts.file' && url.searchParams.get('versionId') === latest.versionId, async route => {
      await downloadGate;
      await route.continue();
    });
    await preview.getByRole('button', { name: '下载此版本' }).click();
    await expect(preview.getByRole('button', { name: '正在下载…' })).toBeDisabled();
    await saved.getByLabel('产物版本').selectOption(second.versionId);
    await expect(preview).toContainText('Second report original');
    const downloaded = page.waitForEvent('download');
    await preview.getByRole('button', { name: '下载此版本' }).click();
    expect(await readFile((await (await downloaded).path())!, 'utf8')).toBe('Second report original');
    await saved.getByRole('button', { name: /Second report/ }).click();
    await expect(preview).toContainText('Second report updated');
  } finally {
    releaseDownload();
    await page.unrouteAll({ behavior: 'wait' });
    await page.goto('about:blank');
    await f.close();
  }
});

test('an independently installed UI replaces all four artifact views through the same public commands, snapshots and downloads',async({page})=>{
 const f=await sessionHost('artifacts');try{const env=await sessionEnvironment(f);await writeFile(join(env.workspace.directory,'independent.txt'),'independent immutable bytes');
 await page.goto(f.host.accessUrl!);await page.evaluate(env=>{location.hash=new URLSearchParams({workspace:env.workspace.id,file:'independent.txt'}).toString();},env);
 await page.getByLabel('更多菜单').click();await page.getByRole('button',{name:'保存当前文件版本',exact:true}).click();
 const register=page.getByRole('dialog',{name:'保存产物版本'});
 await expect(register.getByRole('region',{name:'独立登记'})).toBeVisible();
 await register.getByRole('button',{name:'独立登记版本'}).click();
 const saved=page.getByRole('dialog',{name:'已保存版本'});
 await expect(saved.getByRole('region',{name:'独立列表'})).toContainText('独立登记结果（1 个版本）');
 await expect(saved.getByRole('region',{name:'独立预览'})).toContainText('independent immutable bytes');
 await expect(saved.getByRole('region',{name:'独立预览'})).toContainText('registered-by-user');
 await writeFile(join(env.workspace.directory,'independent.txt'),'changed workspace bytes are not the version');
 await saved.getByRole('button',{name:'登记此产物新版本'}).click();
 await page.getByRole('dialog',{name:'保存产物版本'}).getByRole('button',{name:'独立登记版本'}).click();
 await expect(saved.getByRole('region',{name:'独立版本'})).toContainText('独立版本 2');
 await saved.getByRole('region',{name:'独立版本'}).getByRole('button',{name:'独立版本 1'}).click();
 await expect(saved.getByRole('region',{name:'独立预览'})).toContainText('independent immutable bytes');
 const download=page.waitForEvent('download');await saved.getByRole('button',{name:'独立下载此版本'}).click();expect(await readFile((await(await download).path())!,'utf8')).toBe('independent immutable bytes');
 await f.restart();await page.reload();
 await page.getByLabel('更多菜单').click();await page.getByRole('button',{name:'已保存版本',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'已保存版本'}).getByRole('region',{name:'独立预览'})).toContainText('independent immutable bytes');
 }finally{await page.goto('about:blank');await f.close();}
});
