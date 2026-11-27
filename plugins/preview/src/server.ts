import type { ServerPluginContext } from '@aork/sdk/server';

/** The preview panel reads Workspace files through the public resource the workspace plugin
 * already serves and renders them in the browser, so it has no commands, no resources and
 * nothing stored on the Host. The in-tree build gives every plugin a server entry, and this is
 * the whole of this one's. */
export function activate(_context: ServerPluginContext): void { /* nothing to provide */ }
