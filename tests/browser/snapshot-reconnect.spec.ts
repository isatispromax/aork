import { expect, test } from '@playwright/test';
import { snapshotHost } from '../fixtures/snapshot-host.js';

test('an independently installed UI recovers saved items after offline, failed application, and reload', async ({ page, context }) => {
  const f = await snapshotHost();
  try {
    await page.goto(f.host.accessUrl!);
    await expect(page.getByTestId('saved-items')).toHaveText('[]');
    expect((await f.command('fixture.add', { id: 'before-offline' })).status).toBe(200);
    await expect(page.getByTestId('saved-items')).toHaveText('[{"id":"before-offline"}]');
    await context.setOffline(true);
    expect((await f.command('fixture.add', { id: 'during-offline' })).status).toBe(200);
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
