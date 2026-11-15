import { expect, test } from 'vitest';
import { snapshotHost as fixture } from './fixtures/snapshot-host.js';
import WebSocket from 'ws';
import type { EventStreamFrame } from '@aork/sdk/durable';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { cp } from 'node:fs/promises';

function channel(f: Awaited<ReturnType<typeof fixture>>, cursor: string, streamId = f.bootstrap.hostEpoch) {
  const url = new URL('/api/events', f.host.url); url.protocol = 'ws:';
  url.search = new URLSearchParams({ cursor, streamId, graph: f.bootstrap.pluginGraphHash }).toString();
  const socket = new WebSocket(url, { headers: { Cookie: f.cookie, Origin: f.host.url } });
  const frames: EventStreamFrame[] = [];
  socket.on('message', data => frames.push(JSON.parse(String(data))));
  // Errors are asserted through the observable close state, not detached throwers.
  socket.on('error', () => {});
  return { socket, frames };
}

test('database replay bridges snapshot admission and idle subscription writes without duplicates', async () => {
  const f = await fixture(); let socket: WebSocket | undefined;
  try {
    const snapshot = await (await fetch(`${f.host.url}/api/snapshots/fixture.items`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } })).json();
    await f.command('fixture.add', { id: 'edge' });
    const c = channel(f, snapshot.cursor); socket = c.socket;
    await expect.poll(() => c.frames.find(frame => frame.kind === 'events')).toBeDefined();
    const first = c.frames.find(frame => frame.kind === 'events');
    expect(first?.kind === 'events' && first.events.map(event => event.entityId)).toEqual(['edge']);
    if (first?.kind !== 'events') throw new Error('Missing committed event');
    socket.send(JSON.stringify({ kind: 'ack', cursor: first.cursor }));
    await new Promise(resolve => setTimeout(resolve, 150));
    await f.command('fixture.add', { id: 'idle-edge' });
    await expect.poll(() => c.frames.filter(frame => frame.kind === 'events')).toHaveLength(2);
    const events = c.frames.flatMap(frame => frame.kind === 'events' ? frame.events : []);
    expect(events.map(event => event.entityId)).toEqual(['edge', 'idle-edge']);
    expect(new Set(events.map(event => event.id)).size).toBe(2);
  } finally { socket?.terminate(); await f.close(); }
});


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

test('snapshot participants cannot write, await, or retain their read authority', async()=>{
  const f=await fixture();
  try {
    const snapshot=async(name:string)=>fetch(`${f.host.url}/api/snapshots/${name}`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}});
    for(const name of ['fixture.write','fixture.nestedWrite','fixture.async'])expect((await snapshot(name)).status).toBe(500);
    expect((await(await snapshot('fixture.items')).json()).snapshot).toEqual([]);
    expect((await f.query('fixture.expired')).status).toBe(500);
    expect((await f.command('fixture.add',{id:'still-writable'})).status).toBe(200);
    expect((await(await snapshot('fixture.items')).json()).snapshot).toEqual([{id:'still-writable'}]);
  }finally{await f.close();}
});

test('restart, invalid cursors, and an exhausted retained window require a fresh snapshot',async()=>{
  const f=await fixture();const sockets:WebSocket[]=[];
  const resync=async(cursor:string,streamId?:string)=>{const c=channel(f,cursor,streamId);sockets.push(c.socket);await expect.poll(()=>c.frames.find(frame=>frame.kind==='resync')).toBeDefined();return c.frames;};
  try {
    expect((await resync('9223372036854775808'))[0]).toMatchObject({kind:'resync'});
    expect((await resync('1'))[0]).toMatchObject({kind:'resync'});
    const original=f.bootstrap.hostEpoch;await f.restart();
    expect((await resync('0',original))[0]).toMatchObject({kind:'resync',reason:'stream-changed'});
    expect((await f.command('fixture.burst',{count:2050,prefix:'retained-'})).status).toBe(200);
    expect((await resync('0'))[0]).toMatchObject({kind:'resync',reason:'RESYNC_REQUIRED'});
    const response=await fetch(`${f.host.url}/api/snapshots/fixture.items`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}});
    const value=await response.json();expect(value.snapshot).toHaveLength(2050);
    const live=channel(f,value.cursor);sockets.push(live.socket);await expect.poll(()=>live.frames[0]?.kind).toBe('ready');
  }finally{for(const socket of sockets)socket.terminate();await f.close();}
});

test('decimal replay above JavaScript precision accepts filtered sequence gaps',async()=>{
  const f=await fixture();let socket:WebSocket|undefined;
  try {
    await f.offlineRestore(async dataDir=>{
      // Standard offline restore input at the SQLite counter boundary. All
      // observations below are public snapshot/stream envelopes.
      const database=new Database(join(dataDir,'aork.sqlite'));
      try{database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('durable_events',?)").run(9007199254740992n);}finally{database.close();}
    });
    const value=await(await fetch(`${f.host.url}/api/snapshots/fixture.items`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}})).json();
    expect(value.cursor).toBe('9007199254740992');
    await f.command('fixture.foreign',{});
    await f.command('fixture.add',{id:'precise'});
    const c=channel(f,value.cursor);socket=c.socket;
    await expect.poll(()=>c.frames.find(frame=>frame.kind==='events')).toBeDefined();
    const event=c.frames.find(frame=>frame.kind==='events');
    expect(event?.kind==='events'&&event.events[0]?.seq).toBe('9007199254740994');
    expect(event?.kind==='events'&&event.events.map(item=>item.entityId)).toEqual(['precise']);
  }finally{socket?.terminate();await f.close();}
});

test('an unacknowledged consumer is closed while an acknowledged stream continues',async()=>{
  const f=await fixture();const sockets:WebSocket[]=[];
  try {
    const slow=channel(f,'0'), healthy=channel(f,'0');sockets.push(slow.socket,healthy.socket);
    healthy.socket.on('message',data=>{const frame=JSON.parse(String(data));if(frame.kind==='events')healthy.socket.send(JSON.stringify({kind:'ack',cursor:frame.cursor}));});
    await expect.poll(()=>healthy.frames[0]?.kind).toBe('ready');
    await f.command('fixture.burst',{count:20,prefix:'page-'});
    await expect.poll(()=>healthy.frames.flatMap(frame=>frame.kind==='events'?frame.events.map(e=>e.entityId):[])).toHaveLength(20);
    await expect.poll(()=>slow.frames.find(frame=>frame.kind==='resync'),{timeout:7000}).toMatchObject({reason:'slow-consumer'});
    expect(slow.frames.flatMap(frame=>frame.kind==='events'?frame.events:[])).toHaveLength(8);
    await f.command('fixture.add',{id:'after-slow-close'});
    await expect.poll(()=>healthy.frames.flatMap(frame=>frame.kind==='events'?frame.events:[]).length).toBe(21);
  }finally{for(const socket of sockets)socket.terminate();await f.close();}
},10000);

test('idle logout revokes a connected stream before further protected frames',async()=>{
  const f=await fixture();let socket:WebSocket|undefined;
  try {
    const c=channel(f,'0');socket=c.socket;await expect.poll(()=>c.frames[0]?.kind).toBe('ready');
    expect((await f.command('auth.logout',{})).status).toBe(200);
    await expect.poll(()=>c.frames.find(frame=>frame.kind==='access')).toMatchObject({kind:'access',state:'unauthenticated'});
    expect((await f.command('fixture.add',{id:'rejected'})).status).toBe(401);
    expect(c.frames.some(frame=>frame.kind==='events')).toBe(false);
  }finally{socket?.terminate();await f.close();}
});

test('a restored older backup and a changed authorization graph invalidate existing streams',async()=>{
  const f=await fixture();const sockets:WebSocket[]=[];
  try{
    await f.command('fixture.add',{id:'in-backup'});
    await f.offlineRestore(dataDir=>cp(join(dataDir,'aork.sqlite'),join(f.directory,'saved.sqlite')));
    const prior=f.bootstrap.hostEpoch;
    await f.command('fixture.add',{id:'after-backup'});
    await f.offlineRestore(dataDir=>cp(join(f.directory,'saved.sqlite'),join(dataDir,'aork.sqlite')));
    const restored=channel(f,'2',prior);sockets.push(restored.socket);
    await expect.poll(()=>restored.frames[0]).toMatchObject({kind:'resync',reason:'stream-changed'});
    const response=await fetch(`${f.host.url}/api/snapshots/fixture.items`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}});const value=await response.json();
    expect(value.snapshot).toEqual([{id:'in-backup'}]);
    const live=channel(f,value.cursor);sockets.push(live.socket);await expect.poll(()=>live.frames[0]?.kind).toBe('ready');
    expect((await f.command('plugins.configure',{pluginId:'auth-single-user',config:{}})).status).toBe(200);
    await expect.poll(()=>live.frames.find(frame=>frame.kind==='reload')).toEqual({kind:'reload'});
    expect(live.frames.some(frame=>frame.kind==='events')).toBe(false);
  }finally{for(const socket of sockets)socket.terminate();await f.close();}
});

test('real WebSocket upgrades reject foreign Origin, absent cookie, token URLs, and stale graph',async()=>{
  const f=await fixture();
  try{
    async function rejected(headers:Record<string,string>,extra:Record<string,string>={}){
      const url=new URL('/api/events',f.host.url);url.protocol='ws:';url.search=new URLSearchParams({cursor:'0',streamId:f.bootstrap.hostEpoch,graph:f.bootstrap.pluginGraphHash,...extra}).toString();
      return new Promise<number>((resolve,reject)=>{const ws=new WebSocket(url,{headers});ws.on('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode!);});ws.on('open',()=>{ws.terminate();reject(new Error('Unexpected protected stream admission'));});ws.on('error',()=>{});});
    }
    expect(await rejected({Origin:'https://foreign.example',Cookie:f.cookie})).toBe(403);
    expect(await rejected({Origin:f.host.url})).toBe(401);
    expect(await rejected({Origin:f.host.url,Cookie:f.cookie},{token:'not-a-cookie'})).toBe(400);
    expect(await rejected({Origin:f.host.url,Cookie:f.cookie},{graph:'stale'})).toBe(409);
  }finally{await f.close();}
});
