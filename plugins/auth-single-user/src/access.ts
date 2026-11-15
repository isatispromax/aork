import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ScopedState } from '@aork/sdk/server';

export const randomToken = () => randomBytes(32).toString('base64url');
export const accessConfigurationSchema = z.object({ version: z.literal(1), principalId: z.string().uuid(), signingSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value => Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value) }).strict();
export function createAccessConfiguration(principalId: string = randomUUID()) { return { version: 1 as const, principalId, signingSecret: randomToken() }; }
/** Local-only recovery never executes the server plugin entry being repaired. */
export function rotateAccess(state: ScopedState) {
  const previous = state.get('access');
  const principal = previous && typeof previous === 'object' && !Array.isArray(previous) && typeof previous.principalId === 'string' && z.string().uuid().safeParse(previous.principalId).success ? previous.principalId : randomUUID();
  const configuration = createAccessConfiguration(principal);
  // Rotating the signing key invalidates prior cookies even if later cleanup is interrupted.
  state.set('access', configuration); state.set('sessions', []); state.set('attempts', []);
  return { principalId: principal, sessionsRevoked: true };
}
