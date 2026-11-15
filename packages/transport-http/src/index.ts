import Fastify from 'fastify';
import { AorkError } from '@aork/sdk';
import type { AccessState, Bootstrap } from '@aork/sdk';
import { AUTHORIZATION_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, RequestContext } from '@aork/sdk/server';
import type { ActiveGraph } from '@aork/kernel';

export interface PublicAsset { bytes: Uint8Array; type: string }
export function createHttpTransport(options: {
  active: ActiveGraph | undefined;
  bootstrap: (access: AccessState) => Bootstrap;
  assets: ReadonlyMap<string, PublicAsset>;
  html: string;
}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const requestContext = (headers: RequestContext['headers']): RequestContext => ({ headers });
  async function access(request: RequestContext): Promise<AccessState> {
    const authorization = options.active?.service<AuthorizationService>(AUTHORIZATION_SERVICE);
    if (!authorization) return { state: 'unavailable' };
    try { return await authorization.inspect(request); } catch { return { state: 'unavailable' }; }
  }
  async function requireIdentity(request: RequestContext): Promise<RequestContext> {
    const result = await access(request);
    switch (result.state) {
      case 'authenticated':
        if (!result.identity) throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service returned no identity', 503);
        return { ...request, identity: result.identity };
      case 'setup_required': throw new AorkError('ACCOUNT_SETUP_REQUIRED', 'Initialize the account through the server maintenance entry', 503);
      case 'unauthenticated': throw new AorkError('AUTHENTICATION_REQUIRED', 'Sign in to continue', 401);
      default: throw new AorkError('AUTH_UNAVAILABLE', 'Authentication service is unavailable; use server maintenance', 503);
    }
  }
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AorkError) return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    const badRequest = error !== null && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
    return reply.status(badRequest ? 400 : 500).send({ error: { code: badRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: badRequest ? 'Request payload is invalid' : 'Request failed; inspect local Host diagnostics' } });
  });
  app.get('/api/bootstrap', async request => options.bootstrap(await access(requestContext(request.headers))));
  app.get('/api/diagnostics', async request => {
    const boot = options.bootstrap(await access(requestContext(request.headers)));
    return { hostEpoch: boot.hostEpoch, pluginGraphHash: boot.pluginGraphHash, access: boot.access, diagnostics: boot.diagnostics, maintenance: boot.maintenance };
  });
  app.get('/api/queries/:name', async request => {
    const { name } = request.params as { name: string };
    const query = options.active?.queries.get(name);
    let context = requestContext(request.headers);
    if (!query || query.registration.access !== 'public') context = await requireIdentity(context);
    if (!query) throw new AorkError('QUERY_NOT_FOUND', `Query ${name} is not registered`, 404);
    return query.registration.execute(context);
  });
  app.post('/api/commands/:name', async request => {
    const { name } = request.params as { name: string };
    const command = options.active?.commands.get(name);
    let context = requestContext(request.headers);
    if (!command || command.registration.access !== 'public') context = await requireIdentity(context);
    const boot = options.bootstrap(await access(context));
    const body = request.body as Record<string, unknown> | undefined;
    if (body?.apiVersion !== 1 || typeof body.commandId !== 'string' || body.commandId.length < 8 || body.commandId.length > 128) throw new AorkError('INVALID_COMMAND', 'Command requires apiVersion 1 and a stable commandId');
    if (body.pluginGraphHash !== boot.pluginGraphHash) throw new AorkError('RELOAD_REQUIRED', 'The plugin graph changed; reload the page', 409);
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host || !['http:', 'https:'].some(protocol => origin === `${protocol}//${host}`)) throw new AorkError('ORIGIN_REJECTED', 'Command Origin must match this Host', 403);
    if (!command) throw new AorkError('COMMAND_NOT_FOUND', `Command ${name} is not registered`, 404);
    return command.registration.execute(body.payload, context);
  });
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(options.html));
  app.get('/*', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    const asset = options.assets.get(pathname);
    if (!asset) throw new AorkError('ASSET_NOT_FOUND', 'Asset is unavailable in this plugin graph', 404);
    return reply.type(asset.type).header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(asset.bytes));
  });
  return app;
}
