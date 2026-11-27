import { SHARED_CLIENT_IMPORTS } from '../packages/sdk/src/shared.ts';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename, dirname, relative } from 'node:path';
import { release as osRelease } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

if (process.versions.node !== '24.22.3') throw new Error('Build requires Node 24; see .node-version');
const root = process.cwd();
const out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'runtime'), { recursive: true });
const shared = [...SHARED_CLIENT_IMPORTS];
const imports = {};
const sharedRequire = createRequire(pathToFileURL(resolve(root, 'apps/web/package.json')));
function commonJsFacade(name) {
  const names = Object.keys(sharedRequire(name)).filter(key => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) && key !== 'default');
  return `import value from '${name}'; export default value; export const { ${names.join(', ')} } = value;`;
}
const runtimeEntries = new Map([
  ['react', commonJsFacade('react')],
  ['react/jsx-runtime', commonJsFacade('react/jsx-runtime')],
  ['react/jsx-dev-runtime', commonJsFacade('react/jsx-dev-runtime')],
  ['react-dom', commonJsFacade('react-dom')],
  ['react-dom/client', commonJsFacade('react-dom/client')],
  ['@aork/sdk/client', "export * from '@aork/sdk/client'"],
  ['@aork/ui', "export * from '@aork/ui'"],
]);
// One split build owns every shared dependency, so React has exactly one module identity.
const runtimeBuild = await esbuild({
  entryPoints: Object.fromEntries([...runtimeEntries.keys()].map(name => [name.replaceAll(/[^a-z0-9]/g, '-'), `aork-runtime:${name}`])),
  outdir: resolve(out, 'runtime'), bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', minify: true, metafile: true, entryNames: '[name]-[hash]', chunkNames: 'shared-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'shared-runtime-entries', setup(build) {
    build.onResolve({ filter: /^aork-runtime:/ }, args => ({ path: args.path.slice('aork-runtime:'.length), namespace: 'runtime-entry' }));
    build.onLoad({ filter: /.*/, namespace: 'runtime-entry' }, args => ({ contents: runtimeEntries.get(args.path), resolveDir: resolve(root, 'apps/web') }));
  } }],
});
for (const [file, metadata] of Object.entries(runtimeBuild.metafile.outputs)) {
  if (!metadata.entryPoint) continue;
  const name = metadata.entryPoint.slice('runtime-entry:'.length);
  imports[name] = `/runtime/${file.split('/').at(-1)}`;
}
await writeFile(resolve(out, 'runtime/import-map.json'), JSON.stringify({ imports }));
for (const id of ['auth-single-user', 'workbench', 'workspace', 'plugin-diagnostics', 'plugin-management', 'agent-profiles', 'runner-local', 'runtime-acp', 'provider-claude', 'provider-codex', 'interactions', 'tools', 'workspace-tools', 'sessions', 'artifacts', 'browser', 'preview', 'terminal']) {
  const directory = resolve(root, 'plugins', id);
  const manifest = JSON.parse(await readFile(resolve(directory, 'aork.plugin.json'), 'utf8'));
  const target = resolve(out, 'plugins', id, manifest.version);
  await mkdir(target, { recursive: true });
  await esbuild({ entryPoints: [resolve(directory, 'src/server.ts')], outfile: resolve(target, manifest.server), bundle: true, format: 'esm', platform: 'node', target: 'node24' });
  for(const entry of manifest.executables??[]) await esbuild({entryPoints:[resolve(directory,'src',entry.replace(/\.m?js$/,'.ts'))],outfile:resolve(target,entry),bundle:true,format:'esm',platform:'node',target:'node24'});
  if (manifest.maintenance) await esbuild({ entryPoints: [resolve(directory, 'src/maintenance.ts')], outfile: resolve(target, manifest.maintenance), bundle: true, format: 'esm', platform: 'node', target: 'node24' });
  if (manifest.client) {
  const clientBuild = await esbuild({ metafile: true, entryPoints: [resolve(directory, 'src/client.tsx')], outfile: resolve(target, manifest.client), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', external: shared, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, plugins: [{ name: 'plugin-css-namespace', setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, args => ({ path: `${id}-${createHash('sha256').update(relative(directory, resolve(args.resolveDir, args.path))).digest('hex').slice(0, 12)}-${basename(args.path)}`, namespace: 'plugin-css', pluginData: { file: resolve(args.resolveDir, args.path) } }));
    build.onLoad({ filter: /.*/, namespace: 'plugin-css' }, async args => ({ contents: await readFile(args.pluginData.file, 'utf8'), loader: 'local-css' }));
  } }] });
  for (const output of Object.values(clientBuild.metafile.outputs)) for (const dependency of output.imports) {
    if (dependency.external && !shared.includes(dependency.path)) throw new Error(`${id} imports unsupported shared entry ${dependency.path}`);
  }
  if (Object.keys(clientBuild.metafile.inputs).some(path => /drizzle-orm|plugins[\\/][^\\/]+[\\/]src[\\/]persistence[\\/]/.test(path))) throw new Error(`${id} bundled private server persistence into its client`);
  if (Object.keys(clientBuild.metafile.inputs).some(path => /node_modules[\\/]react(?:-dom)?[\\/]/.test(path))) throw new Error(`${id} bundled a duplicate React runtime`);
  }
  await cp(resolve(directory, 'aork.plugin.json'), resolve(target, 'aork.plugin.json'));
}
await mkdir(resolve(out, 'profiles'), { recursive: true });
await cp(resolve(root, 'profiles/personal-server.json'), resolve(out, 'profiles/personal-server.json'));
await esbuild({ entryPoints: [resolve(root, 'apps/server/src/main.ts')], outfile: resolve(out, 'server/main.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['better-sqlite3', 'fs-ext'], banner: { js: "import { createRequire as __aorkCreateRequire } from 'node:module'; const require = __aorkCreateRequire(import.meta.url);" } });
await viteBuild({ configFile: false, root: resolve(root, 'apps/web'), build: { outDir: resolve(out, 'web'), emptyOutDir: true, target: 'es2022', rollupOptions: { external: shared } } });
async function installedVersion(name, workspace) {
  const require = createRequire(pathToFileURL(resolve(root, workspace, 'package.json')));
  let directory = dirname(require.resolve(name));
  while (directory !== dirname(directory)) {
    try { const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')); if (manifest.name === name) return manifest.version; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate installed version of ${name}`);
}
const dependencyVersions = {};
for (const [name, workspace] of [['@deepseek-ai/cordis', 'packages/kernel'], ['fastify', 'packages/transport-http'], ['react', 'apps/web'], ['react-dom', 'apps/web'], ['better-sqlite3', 'packages/storage'], ['drizzle-orm', 'packages/storage'], ['fs-ext', 'packages/storage'], ['zod', 'packages/sdk'], ['typescript', '.'], ['vite', '.'], ['vitest', '.'], ['@playwright/test', '.'], ['@agentclientprotocol/sdk','plugins/runtime-acp'],['@modelcontextprotocol/server','plugins/tools'],['acorn','packages/kernel']]) dependencyVersions[name] = await installedVersion(name, workspace);
await writeFile(resolve(out, 'compatibility.json'), JSON.stringify({ node: process.versions.node, nodeAbi: process.versions.modules, platform: process.platform, architecture: process.arch, osRelease: osRelease(), sdk: '0.1.0', api: 1, dependencies: dependencyVersions, plugins: ['auth-single-user@0.1.0', 'workbench@0.1.0', 'workspace@0.1.0', 'plugin-diagnostics@0.1.0', 'plugin-management@0.1.0', 'agent-profiles@0.1.0', 'sessions@0.1.0', 'runner-local@0.1.0', 'runtime-acp@0.1.0', 'provider-claude@0.1.0', 'provider-codex@0.1.0', 'interactions@0.1.0', 'tools@0.1.0', 'workspace-tools@0.1.0', 'artifacts@0.1.0', 'browser@0.1.0', 'preview@0.1.0', 'terminal@0.1.0'], shared, lockfileSha256: createHash('sha256').update(await readFile(resolve(root, 'pnpm-lock.yaml'))).digest('hex') }, null, 2));
console.log('Built Host, browser bootstrap, shared runtime and default plugin ESM artifacts.');
