import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { AorkError, isAorkError } from '@aork/sdk';
import type { AccessState, Bootstrap } from '@aork/sdk';
import { AUTHORIZATION_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, RequestContext } from '@aork/sdk/server';
import type { DurableStorage } from '@aork/storage';
import type { ActiveGraph } from '@aork/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';

export interface PublicAsset { bytes: Uint8Array; type: string }
export function createHttpTransport(options: {
  active: ActiveGraph | undefined;
  bootstrap: (access: AccessState) => Bootstrap;
  assets: ReadonlyMap<string, PublicAsset>;
  html: string;
  origin: () => string;
  insecureLoopback: boolean;
  durable: DurableStorage;
}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, forceCloseConnections: true });
  const authorizationOwner = () => { const boot=options.bootstrap({state:'unavailable'}); return boot.profile.services?.[AUTHORIZATION_SERVICE]??boot.plugins.find(plugin=>plugin.manifest.provides.includes(AUTHORIZATION_SERVICE))?.id; };
  async function useAuthorization<T>(operation:(authorization:AuthorizationService)=>T|Promise<T>):Promise<T|undefined>{const owner=authorizationOwner();const authorization=options.active?.service<AuthorizationService>(AUTHORIZATION_SERVICE);if(!owner||!authorization)return undefined;const release=options.active!.lease(owner);try{return await operation(authorization);}finally{await release();}}
  const cookieName = () => `${options.insecureLoopback ? 'aork_dev_session' : '__Host-aork_session'}-${createHash('sha256').update(options.origin()).digest('base64url')}`;
  const requestContext = (request: Pick<FastifyRequest, 'headers' | 'ip'>, reply?: FastifyReply): RequestContext => {
    const name = cookieName();
    const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`)) ?? [];
    const candidate = cookies.length === 1 ? cookies[0]!.slice(name.length + 1) : undefined;
    return { headers: request.headers, clientAddress: request.ip, session: {
      ...(candidate && candidate.length <= 2048 && /^[A-Za-z0-9_.-]+$/.test(candidate) ? { token: candidate } : {}),
      audience: options.origin(),
      issue(value, expiresAt) { reply?.header('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${options.insecureLoopback ? '' : '; Secure'}; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`); },
    } };
  };
  function requireOrigin(origin: string | undefined) {
    if (!origin || origin !== options.origin()) throw new AorkError('ORIGIN_REJECTED', 'Origin must match this Host', 403);
  }
  async function access(request: RequestContext): Promise<AccessState> {
    try { return await useAuthorization(authorization=>authorization.inspect(request))??{state:'unavailable'}; } catch { return {state:'unavailable'}; }
  }
  async function requireIdentity(request: RequestContext): Promise<RequestContext> {
    const result = await access(request);
    switch (result.state) {
      case 'authenticated':
        if (!result.identity) throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service returned no identity', 503);
        return { ...request, identity: result.identity };
      case 'unauthenticated': throw new AorkError('AUTHENTICATION_REQUIRED', 'Open the local Host access URL to continue', 401);
      default: throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service is unavailable; use server maintenance', 503);
    }
  }
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.status(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the allowed byte limit' } });
    if (isAorkError(error)) return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    const badRequest = error !== null && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
    return reply.status(badRequest ? 400 : 500).send({ error: { code: badRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: badRequest ? 'Request payload is invalid' : 'Request failed; inspect local Host diagnostics' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Requested route is unavailable' } }));
  app.get('/api/bootstrap', async (request, reply) => options.bootstrap(await access(requestContext(request, reply))));
  app.get('/api/diagnostics', async (request, reply) => {
    const boot = options.bootstrap(await access(requestContext(request, reply)));
    return { hostEpoch: boot.hostEpoch, pluginGraphHash: boot.pluginGraphHash, access: boot.access, diagnostics: boot.diagnostics, maintenance: boot.maintenance };
  });
  app.get('/api/queries/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    let query = options.active?.queries.get(name);
    let context = requestContext(request, reply);
    const publicAuth = name === 'auth.status' && query?.registration.access === 'public' && query.pluginId === authorizationOwner();
    if (!publicAuth) context = await requireIdentity(context);
    if(request.headers['x-aork-graph']&&request.headers['x-aork-graph']!==options.bootstrap({state:'unavailable'}).pluginGraphHash)throw new AorkError('RELOAD_REQUIRED','The plugin graph changed; reload the page',409);
    query=options.active?.queries.get(name);
    if (!query) throw new AorkError('QUERY_NOT_FOUND', 'Query is not registered', 404);
    const release = options.active!.lease(query.pluginId);
    try { return await query.registration.execute(context); } finally { await release(); }
  });
  app.get('/api/snapshots/:name', async (request, reply) => {
    const expected = request.headers['x-aork-graph'];
    const checkGraph = () => { if (expected !== options.bootstrap({state:'unavailable'}).pluginGraphHash) throw new AorkError('RELOAD_REQUIRED', 'The plugin graph changed; reload the page', 409); };
    const context = await requireIdentity(requestContext(request, reply)); checkGraph();
    const entry = options.active?.snapshots.get((request.params as {name:string}).name);
    if (!entry) throw new AorkError('SNAPSHOT_NOT_FOUND', 'Snapshot is unavailable', 404);
    const parameters = Object.create(null) as Record<string,string>;
    for (const [key,value] of Object.entries(request.query as Record<string,unknown>)) {
      if (typeof value !== 'string' || key.length > 100 || value.length > 4096 || Object.keys(parameters).length >= 16) throw new AorkError('INVALID_SNAPSHOT_PARAMETERS', 'Use bounded string snapshot parameters');
      parameters[key] = value;
    }
    const release = options.active!.lease(entry.pluginId);
    try {
      checkGraph();
      const value = options.durable.readSnapshot(token => entry.registration.read(parameters, context, token));
      const encoded = JSON.stringify(value.snapshot);
      if (encoded === undefined || Buffer.byteLength(encoded) > entry.registration.maxBytes) throw new AorkError('SNAPSHOT_TOO_LARGE', 'Snapshot exceeds its declared bound', 500);
      return { ...value, streamId: options.bootstrap({state:'unavailable'}).hostEpoch };
    } finally { await release(); }
  });
  app.post('/api/commands/:name', async (request, reply) => {
    requireOrigin(request.headers.origin);
    const { name } = request.params as { name: string };
    let command = options.active?.commands.get(name);
    let context = requestContext(request, reply);
    context = await requireIdentity(context);
    const boot = options.bootstrap(await access(context));
    const body = request.body as Record<string, unknown> | undefined;
    if (body?.apiVersion !== 1 || typeof body.commandId !== 'string' || body.commandId.length < 8 || body.commandId.length > 128) throw new AorkError('INVALID_COMMAND', 'Command requires apiVersion 1 and a stable commandId');
    if (body.pluginGraphHash !== boot.pluginGraphHash) throw new AorkError('RELOAD_REQUIRED', 'The plugin graph changed; reload the page', 409);
    const authorization = options.active?.service<AuthorizationService>(AUTHORIZATION_SERVICE);
    if (!authorization || boot.access.state === 'unavailable') throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service is unavailable; use local maintenance', 503);
    await useAuthorization(owner=>owner.verifyCsrf(context));
    if(body.pluginGraphHash!==options.bootstrap({state:'unavailable'}).pluginGraphHash)throw new AorkError('RELOAD_REQUIRED','The plugin graph changed; reload the page',409);
    command=options.active?.commands.get(name);
    if (!command) throw new AorkError('COMMAND_NOT_FOUND', 'Command is not registered', 404);
    const release = options.active!.lease(command.pluginId);
    try {
    if (command.durable) {
      if (!Number.isInteger(body.commandVersion) || Number(body.commandVersion) < 1) throw new AorkError('INVALID_COMMAND', 'Durable command requires commandVersion');
      return await options.durable.execute(command.pluginId, name, command.registration, { commandId: body.commandId, version: Number(body.commandVersion), payload: body.payload }, context);
    }
    return await command.registration.execute(body.payload, context);
    } finally { await release(); }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  async function resource(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    if(write)requireOrigin(request.headers.origin);
    const context=await requireIdentity(requestContext(request,reply));
    const expected=request.headers['x-aork-graph'];
    const checkGraph=()=>{if((write||expected!==undefined)&&expected!==options.bootstrap({state:'unavailable'}).pluginGraphHash)throw new AorkError('RELOAD_REQUIRED','The plugin graph changed; reload the page',409);};
    checkGraph();
    if(write)await useAuthorization(owner=>owner.verifyCsrf(context));
    checkGraph();
    const entry=options.active?.resources.get((request.params as {name:string}).name);
    if(!entry)throw new AorkError('RESOURCE_NOT_FOUND','Resource is unavailable',404);
    const release=options.active!.lease(entry.pluginId);
    let released=false;
    const finish=()=>{if(released)return;released=true;reply.raw.off('finish',finish);reply.raw.off('close',finish);void release();};
    try {
      const parameters=Object.create(null) as Record<string,string>;
      for(const[key,value]of Object.entries(request.query as Record<string,unknown>)){
        if(typeof value!=='string'||key.length>100||value.length>4096)throw new AorkError('INVALID_RESOURCE_PARAMETERS','Resource parameters must be single bounded strings');parameters[key]=value;
      }
      let value;
      if(write){
        if(!entry.registration.write)throw new AorkError('RESOURCE_READ_ONLY','Resource does not accept writes',405);
        if(!Buffer.isBuffer(request.body))throw new AorkError('INVALID_RESOURCE_BODY','Upload requires application/octet-stream');
        if(request.body.byteLength>entry.registration.maxBytes)throw new AorkError('RESOURCE_TOO_LARGE','Resource exceeds its byte limit',413);
        value=await entry.registration.write(parameters,request.body,context);
      }else{
        if(!entry.registration.read)throw new AorkError('RESOURCE_WRITE_ONLY','Resource does not support reads',405);
        value=await entry.registration.read(parameters,context);
      }
      if(!(value.bytes instanceof Uint8Array)||value.bytes.byteLength>entry.registration.maxBytes||!['application/json','application/octet-stream'].includes(value.mediaType))throw new AorkError('INVALID_RESOURCE_RESULT','Plugin returned an invalid resource',500);
      reply.header('Content-Security-Policy',"sandbox; default-src 'none'").type(value.mediaType);
      if(value.mediaType==='application/octet-stream')reply.header('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(value.filename??'download').replaceAll("'",'%27')}`);
      // Client cancellation never releases a still-running registration Promise or physical write.
      if(reply.raw.destroyed||reply.raw.writableFinished)finish();else{reply.raw.once('finish',finish);reply.raw.once('close',finish);}
      return reply.send(Buffer.from(value.bytes));
    }catch(error){finish();throw error;}
  }
  app.get('/api/resources/:name', (request, reply) => resource(request, reply, false));
  app.post('/api/resources/:name', { bodyLimit: 8 * 1024 * 1024 }, (request, reply) => resource(request, reply, true));
  app.get('/api/receipts/:commandId', async (request, reply) => {
    const context = await requireIdentity(requestContext(request, reply));
    const receipt = options.durable.receipt(context.identity!, (request.params as { commandId: string }).commandId);
    if (!receipt) throw new AorkError('RECEIPT_NOT_FOUND', 'Command receipt is unavailable', 404);
    return receipt;
  });
  app.get('/api/events', async (request, reply) => {
    const context = await requireIdentity(requestContext(request, reply));
    const query = request.query as Record<string, string>;
    if(request.headers['x-aork-graph']&&request.headers['x-aork-graph']!==options.bootstrap({state:'unavailable'}).pluginGraphHash)throw new AorkError('RELOAD_REQUIRED','Plugin graph changed',409);
    const allowed=new Set(options.bootstrap({state:'unavailable'}).plugins.map(plugin=>plugin.id));
    return { events: options.durable.replay(context.identity!, query.after ?? '0', query.limit === undefined ? 100 : Number(query.limit)).filter(event=>allowed.has(event.owner)) };
  });
  const streams = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const counts = new Map<string,number>();
  app.addHook('preClose', async () => { for (const client of streams.clients) client.terminate(); streams.close(); });
  app.server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, reason: string) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const admissionTimer = setTimeout(() => socket.destroy(), 5000); admissionTimer.unref();
    void (async () => {
      requireOrigin(request.headers.origin);
      const original = requestContext({ headers: request.headers, ip: request.socket.remoteAddress ?? 'unknown' });
      const context = await requireIdentity(original);
      const url = new URL(request.url ?? '/', options.origin());
      if (url.pathname !== '/api/events') throw new AorkError('ROUTE_NOT_FOUND', 'Stream is unavailable', 404);
      if (!url.searchParams.has('cursor') || !url.searchParams.has('streamId') || !url.searchParams.has('graph')) { reject(426, 'Snapshot Required'); return; }
      if ([...url.searchParams.keys()].some(key => !['cursor','streamId','graph'].includes(key) || url.searchParams.getAll(key).length !== 1) || url.search.length > 512) throw new AorkError('INVALID_STREAM', 'Use only bounded snapshot stream metadata');
      const graph = url.searchParams.get('graph')!; const streamId = url.searchParams.get('streamId')!;
      if (graph !== options.bootstrap({state:'unavailable'}).pluginGraphHash) throw new AorkError('RELOAD_REQUIRED', 'Plugin graph changed', 409);
      const cursor = url.searchParams.get('cursor')!;
      let reason: string | undefined;
      if (streamId !== options.bootstrap({state:'unavailable'}).hostEpoch) reason = 'stream-changed';
      else try { options.durable.replay(context.identity!, cursor); } catch (error) { if (isAorkError(error)) reason = error.code; else throw error; }
      if (streams.clients.size >= 64 || (counts.get(context.identity!) ?? 0) >= 32) throw new AorkError('STREAM_LIMIT', 'Too many event subscriptions', 429);
      if (socket.destroyed) return;
      streams.handleUpgrade(request, socket, head, ws => {
        counts.set(context.identity!, (counts.get(context.identity!) ?? 0) + 1);
        let lastSent = cursor; let awaiting: { cursor: string; at: number } | undefined; let running = false; let stopped = false;
        const stop = (frame?: object, code = 4001) => {
          if (stopped) return; stopped = true; clearInterval(timer);
          if (ws.readyState === WebSocket.OPEN && frame && ws.bufferedAmount < 512 * 1024) ws.send(JSON.stringify(frame));
          ws.close(code, 'Reconnect using a current snapshot');
          const force = setTimeout(() => ws.terminate(), 250); force.unref();
        };
        const tick = async () => {
          if (running || stopped || ws.readyState !== WebSocket.OPEN) return; running = true;
          try {
            // Each cycle reacquires short authorization leases. The original cookie is
            // inspected again; a socket never holds a service alive or keeps old grants.
            if (graph !== options.bootstrap({state:'unavailable'}).pluginGraphHash) { stop({kind:'reload'}); return; }
            const current = await access(original);
            if (current.state !== 'authenticated' || current.identity !== context.identity) { stop({kind:'access',state:current.state === 'unauthenticated' ? 'unauthenticated' : 'unavailable'}); return; }
            if (graph !== options.bootstrap({state:'unavailable'}).pluginGraphHash) { stop({kind:'reload'}); return; }
            if (ws.bufferedAmount > 512 * 1024 || (awaiting && Date.now() - awaiting.at > 5000)) { stop({kind:'resync',reason:'slow-consumer'}); return; }
            if (awaiting) return;
            const page = options.durable.replay(context.identity!, lastSent, 8);
            if (!page.length) return;
            const allowed = new Set(options.bootstrap(current).plugins.map(plugin => plugin.id));
            const events = page.filter(event => allowed.has(event.owner));
            const next = page.at(-1)!.seq;
            const encoded = JSON.stringify({kind:'events',events,cursor:next});
            if (Buffer.byteLength(encoded) > 300 * 1024) { stop({kind:'resync',reason:'frame-limit'}); return; }
            // One bounded page can be in flight. No next DB read until application ACK.
            awaiting = { cursor: next, at: Date.now() };
            ws.send(encoded, error => { if (error) stop(); }); lastSent = next;
          } catch (error) { stop({kind:'resync',reason:isAorkError(error) ? error.code : 'stream-unavailable'}); }
          finally { running = false; }
        };
        const timer = setInterval(() => { void tick(); }, 100); timer.unref();
        ws.on('message', (data, binary) => {
          try {
            if (binary) throw new Error('Invalid ACK');
            const value = JSON.parse(String(data));
            if (!value || Object.keys(value).sort().join(',') !== 'cursor,kind' || value.kind !== 'ack' || !awaiting || value.cursor !== awaiting.cursor) throw new Error('Invalid ACK');
            awaiting = undefined; void tick();
          } catch { stop({kind:'resync',reason:'invalid-ack'}); }
        });
        ws.on('error', () => stop());
        ws.once('close', () => { stopped = true; clearInterval(timer); counts.set(context.identity!, Math.max(0,(counts.get(context.identity!) ?? 1)-1)); });
        if (reason) stop({kind:'resync',reason});
        else { ws.send(JSON.stringify({kind:'ready',streamId,cursor})); void tick(); }
      });
    })().catch(error => { reject(isAorkError(error) ? error.status : 503, 'Upgrade Rejected'); }).finally(() => clearTimeout(admissionTimer));
  });
  app.get('/', { exposeHeadRoute: false }, async (request, reply) => {
    const parameters = new URL(request.url, options.origin()).searchParams;
    if (parameters.has('token')) {
      const expected = new URL(options.origin());
      if (request.headers.host !== expected.host || (request.headers.origin !== undefined && request.headers.origin !== expected.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new AorkError('ORIGIN_REJECTED', 'Access link source is not allowed', 403);
      const tokens = parameters.getAll('token');
      if (tokens.length !== 1 || !tokens[0]) throw new AorkError('TOKEN_REJECTED', 'Reopen the access URL printed by the local Host', 401);
      const authorization = options.active?.service<AuthorizationService>(AUTHORIZATION_SERVICE);
      if (!authorization || (await access(requestContext(request, reply))).state === 'unavailable') throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service is unavailable; use local maintenance', 503);
      await useAuthorization(owner=>owner.exchangeToken(requestContext(request, reply), tokens[0]!));
      return reply.header('Referrer-Policy', 'no-referrer').redirect('./', 303);
    }
    const state = await access(requestContext(request, reply));
    return reply.status(state.state === 'authenticated' ? 200 : state.state === 'unavailable' ? 503 : 401).type('text/html; charset=utf-8').send(options.html);
  });
  app.get('/*', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    const asset = options.assets.get(pathname);
    if (!asset) throw new AorkError('ASSET_NOT_FOUND', 'Asset is unavailable in this plugin graph', 404);
    return reply.type(asset.type).header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(asset.bytes));
  });
  return app;
}
