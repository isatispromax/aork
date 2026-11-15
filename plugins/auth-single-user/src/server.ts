import { z } from 'zod';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AorkError } from '@aork/sdk';
import { AUTHORIZATION_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, RequestContext, ServerPluginContext, ScopedState } from '@aork/sdk/server';
import { accessConfigurationSchema, createAccessConfiguration, randomToken } from './access.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const sessionSchema = z.array(z.object({ digest: hex, csrf: hex, expiresAt: z.number().int().positive() }).strict()).max(160);
const attemptsSchema = z.array(z.object({ address: hex, at: z.number().int() }).strict()).max(20);
const payloadSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), audience: z.string(), issuedAt: z.number().int().safe(), expiresAt: z.number().int().safe() }).strict();
const lifetime = 30 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
const launchTokens = new WeakMap<ScopedState, string>();
export function activate(context: ServerPluginContext) {
  const previous = context.state.get('access');
  const configuration = accessConfigurationSchema.parse(previous ?? createAccessConfiguration());
  if (previous === undefined) context.state.set('access', configuration);
  const launchToken = launchTokens.get(context.state) ?? randomToken();
  launchTokens.set(context.state, launchToken);
  let sessions = sessionSchema.parse(context.state.get('sessions') ?? []).filter(session => session.expiresAt > Date.now());
  let attempts = attemptsSchema.parse(context.state.get('attempts') ?? []);
  const sign = (body: string) => createHmac('sha256', Buffer.from(configuration.signingSecret, 'base64url')).update(body).digest('base64url');
  function saveSessions(next: typeof sessions) { context.state.set('sessions', next); sessions = next; }
  function find(request: RequestContext) {
    const value = request.session.token;
    if (!value) return undefined;
    const parts = value.split('.'); const body = parts[1]; const signature = parts[2];
    if (parts.length !== 3 || parts[0] !== 'v1' || !body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature) || Buffer.from(body, 'base64url').toString('base64url') !== body || !equal(signature, sign(body))) return undefined;
    let raw: unknown; try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return undefined; }
    const parsed = payloadSchema.safeParse(raw); if (!parsed.success) return undefined;
    const payload = parsed.data;
    if (payload.audience !== request.session.audience || payload.issuedAt > Date.now() || payload.expiresAt <= Date.now() || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > lifetime) return undefined;
    return sessions.find(session => session.digest === digest(payload.id) && session.expiresAt === payload.expiresAt);
  }
  const authorization: AuthorizationService = {
    inspect(request) {
      const session = find(request);
      return session ? { state: 'authenticated', identity: configuration.principalId, csrfToken: session.csrf } : { state: 'unauthenticated' };
    },
    accessUrl(origin) { const url = new URL('/', origin); url.searchParams.set('token', launchToken); return url.href; },
    exchangeToken(request, presented) {
      // An already-authorized browser may clean an old launch URL without replacing its cookie.
      if (find(request)) return;
      const address = digest(request.clientAddress);
      attempts = attempts.filter(attempt => attempt.at > Date.now() - 15 * 60 * 1000);
      if (!equal(presented, launchToken)) {
        if (attempts.filter(attempt => attempt.address === address).length >= 5 || attempts.length >= 20) throw new AorkError('ACCESS_RATE_LIMITED', 'Too many invalid access links; retry later or use local access recovery', 429);
        const next = [...attempts, { address, at: Date.now() }]; context.state.set('attempts', next); attempts = next;
        throw new AorkError('TOKEN_REJECTED', 'Reopen the access URL printed by the local Host', 401);
      }
      const valid = sessions.filter(session => session.expiresAt > Date.now());
      if (valid.length >= 160) throw new AorkError('SESSION_CAPACITY', 'Sign out another browser or use local access recovery', 429);
      const issuedAt = Date.now(); const expiresAt = issuedAt + lifetime;
      const payload = { version: 1, id: randomToken(), audience: request.session.audience, issuedAt, expiresAt };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      saveSessions([...valid, { digest: digest(payload.id), csrf: digest(randomToken()), expiresAt }]);
      request.session.issue(`v1.${body}.${sign(body)}`, expiresAt);
    },
    verifyCsrf(request) {
      const session = find(request); const supplied = request.headers['x-aork-csrf'];
      if (!session || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !equal(supplied, session.csrf)) throw new AorkError('CSRF_REJECTED', 'Refresh the page before submitting this command', 403);
    },
  };
  context.provide(AUTHORIZATION_SERVICE, authorization);
  context.query('auth.status', { access: 'public', execute: request => authorization.inspect(request) });
  context.command('auth.logout', { access: 'authenticated', execute(_payload, request) {
    const session = find(request);
    saveSessions(sessions.filter(existing => existing !== session && existing.expiresAt > Date.now()));
    // A delayed logout response must not erase a subsequent successful token exchange cookie.
    return { signedOut: true };
  } });
}
