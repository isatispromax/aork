import type { DurableEvent, EventStreamFrame, SnapshotEnvelope } from '@aork/sdk/durable';

const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function validSnapshot<T>(value: SnapshotEnvelope<T>) {
  if (!value || !decimal(value.cursor) || typeof value.streamId !== 'string' || value.streamId.length > 128) throw new Error('Invalid snapshot envelope');
  return value;
}

/** Only durable snapshots are saved state. This controller never invokes commands. */
export function observeSavedSnapshot<T>(options: {
  snapshot(): Promise<SnapshotEnvelope<T>>;
  graph: string;
  observer: { next(value:T): void | Promise<void>; error?(error:Error):void };
  owners?: readonly string[];
  eventTypes?: readonly string[];
  access(state:'unauthenticated'|'unavailable'):void;
  reload():void;
  refreshAccess():Promise<unknown>;
}) {
  let stopped = false; let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let current: SnapshotEnvelope<T> | undefined; let backoff = 250; let attempt = 0;
  const seen = new Set<string>();
  const report = (error:unknown) => { try { options.observer.error?.(error instanceof Error ? error : new Error('Saved state is unavailable')); } catch { /* Observer errors do not create detached rejection chains. */ } };
  const remember = (id:string) => { seen.add(id); if (seen.size > 1024) seen.delete(seen.values().next().value!); };
  const replacement = async (epoch:number) => {
    const value = validSnapshot(await options.snapshot());
    if (stopped || epoch !== attempt) return;
    await options.observer.next(value.snapshot);
    if (stopped || epoch !== attempt) return;
    current = value; // The cursor moves only AFTER successful application.
  };
  const connect = async () => {
    if (stopped) return; const epoch = ++attempt;
    try {
      if (!current) await replacement(epoch);
      if (stopped || epoch !== attempt || !current) return;
      const url = new URL('/api/events', location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = new URLSearchParams({cursor:current.cursor,streamId:current.streamId,graph:options.graph}).toString();
      const ws = new WebSocket(url); socket = ws;
      let processing = false;
      ws.onmessage = event => {
        if (stopped || epoch !== attempt) return;
        if (processing) { current = undefined; ws.close(); return; }
        processing = true;
        void (async () => {
          if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 300 * 1024) throw new Error('Invalid event frame');
          const frame = JSON.parse(event.data) as EventStreamFrame;
          if (frame.kind === 'resync') { current = undefined; ws.close(); return; }
          if (frame.kind === 'reload') { options.reload(); return; }
          if (frame.kind === 'access') { options.access(frame.state); return; }
          if (frame.kind === 'ready') {
            if (!current || frame.streamId !== current.streamId || frame.cursor !== current.cursor) throw new Error('Event stream disagrees with its snapshot');
            backoff = 250; return;
          }
          if (frame.kind !== 'events' || !decimal(frame.cursor) || !Array.isArray(frame.events) || frame.events.length > 8 || !current) throw new Error('Invalid event page');
          let previous = 0n; let relevant = false;
          for (const event of frame.events as DurableEvent[]) {
            if (!event || !decimal(event.seq) || BigInt(event.seq) <= previous || BigInt(event.seq) > BigInt(frame.cursor) || typeof event.id !== 'string' || event.id.length > 128 || typeof event.owner !== 'string' || typeof event.type !== 'string' || !Number.isInteger(event.version) || event.version < 1) throw new Error('Invalid durable event');
            previous = BigInt(event.seq);
            if (BigInt(event.seq) <= BigInt(current.cursor) || seen.has(event.id)) continue;
            if ((!options.owners || options.owners.includes(event.owner)) && (!options.eventTypes || options.eventTypes.includes(event.type))) relevant = true;
          }
          if (relevant) await replacement(epoch);
          if (stopped || epoch !== attempt || !current || ws.readyState !== WebSocket.OPEN) return;
          // Refetch-on-invalidation interprets no business payload. A successful
          // owner snapshot, including its own projection events, is authoritative.
          for (const event of frame.events) remember(event.id);
          if (BigInt(frame.cursor) > BigInt(current.cursor)) current = {...current,cursor:frame.cursor};
          ws.send(JSON.stringify({kind:'ack',cursor:frame.cursor}));
        })().catch(error => { report(error); current = undefined; ws.close(); }).finally(() => { processing = false; });
      };
      ws.onclose = () => {
        if (stopped || epoch !== attempt) return;
        timer = setTimeout(() => { void options.refreshAccess().catch(() => {}).then(connect); }, backoff);
        backoff = Math.min(5000, backoff * 2);
      };
      ws.onerror = () => { /* Close owns reconnect and access revalidation. */ };
    } catch (error) {
      if (!stopped) { report(error); current = undefined; timer = setTimeout(() => { void connect(); }, backoff); backoff = Math.min(5000,backoff*2); }
    }
  };
  void connect();
  return () => { stopped = true; attempt++; clearTimeout(timer); socket?.close(); current = undefined; seen.clear(); };
}
