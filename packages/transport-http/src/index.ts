import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { AorkError, isAorkError } from '@aork/sdk';
import type { AccessState, Bootstrap } from '@aork/sdk';
import { AUTHORIZATION_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, RequestContext } from '@aork/sdk/server';
import type { DurableStorage } from '@aork/storage';
import type { ActiveGraph } from '@aork/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
    return { events: options.durable.events(context.identity!, query.after ?? '0', query.limit === undefined ? 100 : Number(query.limit)) };
  });
  // This guard owns every future WebSocket upgrade. Event subscriptions arrive in a later ticket.
  app.server.on('upgrade', (request, socket) => {
    const reject = (status: number, reason: string) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    void (async () => {
      requireOrigin(request.headers.origin);
      await requireIdentity(requestContext({ headers: request.headers, ip: request.socket.remoteAddress ?? 'unknown' }));
      reject(426, 'WebSocket Not Available');
    })().catch(error => { reject(isAorkError(error) ? error.status : 503, 'Upgrade Rejected'); });
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
