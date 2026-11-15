import { expect, test } from 'vitest';
import { snapshotHost as fixture } from './fixtures/snapshot-host.js';
import WebSocket from 'ws';
import type { EventStreamFrame } from '@aork/sdk/durable';

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
