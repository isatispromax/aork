import { AUTHORIZATION_SERVICE } from '@aork/sdk/server';
import type { AuthorizationService, ServerPluginContext } from '@aork/sdk/server';

/** Account initialization, login and cookies belong to ticket 03. This bootstrap always fails closed. */
export function activate(context: ServerPluginContext) {
  const authorization: AuthorizationService = {
    inspect() { return { state: context.state.get('account') ? 'unauthenticated' : 'setup_required' }; },
  };
  context.provide(AUTHORIZATION_SERVICE, authorization);
  context.query('auth.status', { access: 'public', execute: request => authorization.inspect(request) });
}
