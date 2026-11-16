import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { SHARED_CLIENT_IMPORTS } from '@aork/sdk/shared';
import type { sessionHost } from './session-host.js';
/** Build the accepted pre-Tools Session package and its exact public contracts.
 * The real Host/Workspace/SQLite/public commands remain the test boundary. */
export async function legacySessions(options: Parameters<NonNullable<Parameters<typeof sessionHost>[1]>>[0]) {
    const current = join(options.distributionDir, 'plugins/sessions/0.1.0');
    const backup = join(options.directory, 'current-session-package');
    await cp(current, backup, { recursive: true });
    const legacy = join(options.directory, 'accepted-session-source');
    await mkdir(legacy);
    const archive = join(options.directory, 'accepted-sessions.tar');
    await promisify(execFile)('git', ['archive', '--format=tar', '--output', archive, 'e7b5cc16776d51bccf35bab674429b07c4ec8200', 'plugins/sessions', 'packages/contracts']);
    await promisify(execFile)('tar', ['-xf', archive, '-C', legacy]);
    const contracts = JSON.parse(await readFile(join(legacy, 'packages/contracts/package.json'), 'utf8'));
    const aliases = { name: 'accepted-public-contracts', setup(builder: import('esbuild').PluginBuild) {
            builder.onResolve({ filter: /^@aork\/contracts\// }, args => {
                const entry = contracts.exports['.' + args.path.slice('@aork/contracts'.length)];
                if (!entry)
                    throw Error('Accepted public contract export missing');
                return { path: join(legacy, 'packages/contracts', entry) };
            });
        } };
    const common = { bundle: true, format: 'esm' as const, nodePaths: [join(process.cwd(), 'node_modules'), join(process.cwd(), 'plugins/sessions/node_modules'), join(process.cwd(), 'packages/contracts/node_modules')], plugins: [aliases] };
    await build({ ...common, entryPoints: [join(legacy, 'plugins/sessions/src/server.ts')], outfile: join(current, 'server.js'), platform: 'node', target: 'node24' });
    await build({ ...common, entryPoints: [join(legacy, 'plugins/sessions/src/client.tsx')], outfile: join(current, 'client.js'), platform: 'browser', target: 'es2022', jsx: 'automatic', external: [...SHARED_CLIENT_IMPORTS] });
    await cp(join(legacy, 'plugins/sessions/aork.plugin.json'), join(current, 'aork.plugin.json'));
    return async () => { await cp(backup, current, { recursive: true }); };
}
