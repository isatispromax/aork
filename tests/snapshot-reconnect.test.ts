import { expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from './fixtures/session-host.js';

async function fixture() {
  return sessionHost(false, async ({ distributionDir, profile }) => {
    const directory = join(distributionDir, 'plugins/snapshot-fixture/0.1.0');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'snapshot-fixture', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', ui: { providers: [] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence={namespace:'plugin_snapshot_hfixture__',migrations:[{version:1,statements:['CREATE TABLE plugin_snapshot_hfixture__items (id TEXT PRIMARY KEY, principal TEXT NOT NULL)']}],statements:{insert:{sql:'INSERT INTO plugin_snapshot_hfixture__items (id,principal) VALUES (?,?)',mode:'write'},list:{sql:'SELECT id FROM plugin_snapshot_hfixture__items WHERE principal=? ORDER BY id',mode:'read'}}};
      export function activate(c){const schema={parse:v=>v};c.snapshot('fixture.items',{maxBytes:65536,read(p,r,tx){return c.repository.all('list',[r.identity],tx);}});c.durableCommand('fixture.add',{version:1,payload:schema,result:schema,events:{'fixture.changed':{version:1,payload:schema}},execute(p,_,tx,r){c.repository.run(tx,'insert',[p.id,r.identity]);return{result:{id:p.id},events:[{type:'fixture.changed',version:1,entityId:p.id,payload:{id:p.id}}]};}});}`);
    profile.plugins.push({ id: 'snapshot-fixture', version: '0.1.0', enabled: true });
  });
}

test('public owner snapshots include a decimal cursor covering the same saved items', async () => {
  const f = await fixture();
  try {
    expect((await f.command('fixture.add', { id: 'one' })).status).toBe(200);
    const response = await fetch(`${f.host.url}/api/snapshots/fixture.items`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } });
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.snapshot).toEqual([{ id: 'one' }]);
    expect(value.streamId).toBe(f.bootstrap.hostEpoch);
    expect(value.cursor).toMatch(/^[1-9][0-9]*$/);
    const events = await (await fetch(`${f.host.url}/api/events?after=${value.cursor}`, { headers: { Cookie: f.cookie } })).json();
    expect(events.events).toEqual([]);
  } finally { await f.close(); }
});
