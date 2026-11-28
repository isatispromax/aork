import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { SHARED_CLIENT_IMPORTS } from '@aork/sdk/shared';
import type { sessionHost } from './session-host.js';
/** Build the accepted pre-Tools Session package and its exact public contracts.
 * The real Host/Workspace/SQLite/public commands remain the test boundary.
 * Accepted-package accommodations for the merged tree, without touching the
 * legacy Session behavior: the current artifacts package registers its
 * version-reader seam on every Sessions provider, and the Host requires a
 * selected provider for every public UI contract — so the legacy window adds a
 * no-op seam registration and a minimal handoff view plugin. The merged tree
 * also removed the Project layer (ADR-0005), so the accepted window's contracts
 * drop projectId and its create validation stops requiring one. It then made
 * the Workspace browser one tree and removed the Workspace archived state
 * (ADR-0006), so the accepted window's embedded Workspace record takes the
 * current shape in `status`' place and its navigation provider answers the
 * `rows` contract; the backfill scenario under test (upgrade archives tool
 * selections read-only, exactly once) is unchanged. */
export async function legacySessions(options: Parameters<NonNullable<Parameters<typeof sessionHost>[1]>>[0]) {
    const current = join(options.distributionDir, 'plugins/sessions/0.1.0');
    const backup = join(options.directory, 'current-session-package');
    await cp(current, backup, { recursive: true });
    const legacy = join(options.directory, 'accepted-session-source');
    await mkdir(legacy);
    const archive = join(options.directory, 'accepted-sessions.tar');
    await promisify(execFile)('git', ['archive', '--format=tar', '--output', archive, '234d9ac', 'plugins/sessions', 'packages/contracts']);
    await promisify(execFile)('tar', ['-xf', archive, '-C', legacy]);
    const legacyServer = join(legacy, 'plugins/sessions/src/server.ts');
    const acceptedProvide = 'context.provide(SESSIONS_SERVICE, service);';
    let serverSource = await readFile(legacyServer, 'utf8');
    if (!serverSource.includes(acceptedProvide))
        throw new Error('Accepted legacy Sessions provide call moved; update the seam patch');
    // Workspace-first adaptation (ADR-0005): the current Workspace service no longer
    // carries projectId/management, so the accepted window's public contracts and its
    // create validation must speak the workspace-first vocabulary. The access concept
    // was later removed entirely, so the embedded strict Workspace parse drops it too.
    const legacyContractsWorkspace = join(legacy, 'packages/contracts/src/workspace.ts');
    const legacyContractsSession = join(legacy, 'packages/contracts/src/session.ts');
    const workspaceSource = await readFile(legacyContractsWorkspace, 'utf8');
    const sessionSource = await readFile(legacyContractsSession, 'utf8');
    const legacyWorkspaceLine = "  id, projectId: id, name, status: z.enum(['open', 'archived']), management: z.enum(['managed', 'external']),";
    const legacyWorkspaceAccessLine = "  requestedDirectory: z.string(), directory: z.string(), access: z.enum(['read-only', 'read-write']),";
    const legacySessionInput = "export const createSessionSchema = z.object({ name: z.string().trim().min(1).max(120), projectId: id, workspaceId: id, profileId: id }).strict();";
    const environmentMismatch = "      if (workspace.projectId !== payload.projectId) throw new AorkError('SESSION_ENVIRONMENT_MISMATCH', 'Workspace does not belong to the selected Project', 409);\n";
    if (!workspaceSource.includes(legacyWorkspaceLine) || !workspaceSource.includes(legacyWorkspaceAccessLine) || !sessionSource.includes(legacySessionInput) || !serverSource.includes(environmentMismatch))
        throw new Error('Accepted legacy project axis moved; update the workspace-first adaptation');
    const legacyWorkspaceArchived = "  id, name, status: z.enum(['open', 'archived']),\n  requestedDirectory";
    // ADR-0006: a Workspace record now carries its creation time and an optional order, and no archived state.
    const adaptedWorkspace = workspaceSource
        .replace(legacyWorkspaceLine, "  id, name, status: z.enum(['open', 'archived']),")
        .replace(legacyWorkspaceAccessLine, '  requestedDirectory: z.string(), directory: z.string(),')
        .replace(legacyWorkspaceArchived, "  id, name, createdAt: z.iso.datetime(), order: z.number().int().nonnegative().optional(),\n  requestedDirectory");
    if (!adaptedWorkspace.includes('createdAt: z.iso.datetime()'))
        throw new Error('Accepted legacy Workspace record moved; update the archived-state adaptation');
    await writeFile(legacyContractsWorkspace, adaptedWorkspace);
    await writeFile(legacyContractsSession, sessionSource.replace(legacySessionInput, 'export const createSessionSchema = z.object({ name: z.string().trim().min(1).max(120), workspaceId: id, profileId: id }).strict();'));
    serverSource = serverSource.replace(acceptedProvide, 'context.provide(SESSIONS_SERVICE, { ...service, registerArtifactVersions() { return () => { }; } });').replace(environmentMismatch, '');
    // ADR-0006: the Workspace service keeps one requirement, the registration's existence.
    serverSource = serverSource.replaceAll('requireOpenWorkspace', 'requireWorkspace');
    await writeFile(legacyServer, serverSource);
    const contracts = JSON.parse(await readFile(join(legacy, 'packages/contracts/package.json'), 'utf8'));
    // esbuild may report importers through their real path (macOS /var -> /private/var),
    // so scope the alias by resolved roots instead of raw string prefixes.
    const legacyRoots = await Promise.all([legacy, await realpath(legacy)].map(async root => [root, await realpath(join(root, 'plugins')).catch(() => join(root, 'plugins'))] as const));
    const inLegacy = (importer: string) => legacyRoots.some(([root, plugins]) => importer === root || importer.startsWith(`${plugins}/`));
    const aliases = { name: 'accepted-public-contracts', setup(builder: import('esbuild').PluginBuild) {
            builder.onResolve({ filter: /^@aork\/contracts\// }, args => {
                // The accepted legacy code resolves against its own contracts; the current
                // persistence declaration (same owner namespace, current migrations) keeps
                // resolving against the current tree, like the Tools capability fixture.
                if (!args.importer || !inLegacy(args.importer))
                    return;
                const entry = contracts.exports['.' + args.path.slice('@aork/contracts'.length)];
                if (!entry)
                    throw Error('Accepted public contract export missing');
                return { path: join(legacy, 'packages/contracts', entry) };
            });
        } };
    const common = { bundle: true, format: 'esm' as const, nodePaths: [join(process.cwd(), 'node_modules'), join(process.cwd(), 'plugins/sessions/node_modules'), join(process.cwd(), 'packages/contracts/node_modules')], plugins: [aliases] };
    await build({ ...common, stdin: { contents: `export { activate } from ${JSON.stringify(legacyServer)};
export { persistence } from ${JSON.stringify(join(process.cwd(), 'plugins/sessions/src/persistence/repository.ts'))};
`, resolveDir: process.cwd(), sourcefile: 'accepted-legacy-sessions.ts' }, outfile: join(current, 'server.js'), platform: 'node', target: 'node24' });
    // ADR-0006: `aork.sessions.navigation@1` gave way to `aork.sessions.rows@1`; the accepted window's
    // navigation view answers that contract under the id the current profile selects.
    const legacyClient = join(legacy, 'plugins/sessions/src/client.tsx');
    const clientSource = await readFile(legacyClient, 'utf8');
    const legacyNavigation = "context.registerView('navigation', Navigation)";
    if (!clientSource.includes(legacyNavigation))
        throw new Error('Accepted legacy Sessions navigation registration moved; update the rows adaptation');
    await writeFile(legacyClient, clientSource.replace(legacyNavigation, "context.registerView('rows', Navigation)"));
    await build({ ...common, entryPoints: [legacyClient], outfile: join(current, 'client.js'), platform: 'browser', target: 'es2022', jsx: 'automatic', external: [...SHARED_CLIENT_IMPORTS] });
    const manifest = JSON.parse(await readFile(join(legacy, 'plugins/sessions/aork.plugin.json'), 'utf8'));
    const navigation = manifest.ui.providers.find((provider: { id: string }) => provider.id === 'navigation');
    if (!navigation)
        throw new Error('Accepted legacy Sessions navigation provider moved; update the rows adaptation');
    Object.assign(navigation, { id: 'rows', contract: 'aork.sessions.rows@1' });
    await writeFile(join(current, 'aork.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    delete options.profile.ui.providers['aork.sessions.navigation@1'];
    options.profile.ui.providers['aork.sessions.rows@1'] = 'sessions:rows';
    const handoff = join(options.distributionDir, 'plugins/legacy-handoff-view/0.1.0');
    await mkdir(handoff, { recursive: true });
    await writeFile(join(handoff, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'legacy-handoff-view', version: '0.1.0', sdkRange: '^0.1.0', client: 'client.js', requires: ['aork.sessions@1'], ui: { providers: [{ id: 'handoff', contract: 'aork.sessions.handoff@1' }] } }));
    await writeFile(join(handoff, 'client.js'), "export function activate(c){c.registerView('handoff',()=>null);}");
    options.profile.plugins.push({ id: 'legacy-handoff-view', version: '0.1.0', enabled: true });
    options.profile.ui.providers['aork.sessions.handoff@1'] = 'legacy-handoff-view:handoff';
    return async () => { await cp(backup, current, { recursive: true }); };
}
