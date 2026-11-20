import { build } from 'esbuild';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, mkdtemp, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { SHARED_CLIENT_IMPORTS } from '../packages/sdk/src/shared.ts';

if (process.versions.node !== '24.22.3') throw new Error('Plugin build requires locked Node 24.22.3');
const { values } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string' } } });
if (!values.dir || !values.out) throw new Error('Usage: node scripts/plugin-build.mjs --dir <source-package> --out <archive.aork-plugin>');
const directory = resolve(values.dir);
const manifest = JSON.parse(await readFile(join(directory, 'aork.plugin.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'aork-plugin-build-'));
const ownershipBoundary = { name: 'public-plugin-boundaries', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    if (/^(?:@aork\/(?:kernel|storage|transport-http|plugin-)|@deepseek-ai\/cordis|fastify(?:\/|$)|better-sqlite3(?:\/|$)|node:sqlite$)/.test(args.path) || /^@aork\/sdk\/(?!client$|server$|shared$)/.test(args.path) || /^@aork\/contracts\/src(?:\/|$)/.test(args.path)) throw new Error('PLUGIN_PRIVATE_IMPORT: use only public SDK and business contracts');
    const resolved = resolve(args.resolveDir, args.path);
    if ((args.path.startsWith('.') || args.path.startsWith('/')) && !resolved.startsWith(directory + '/') && /(?:^|\/)(?:plugins|apps)\/|\/packages\/(?:kernel|storage|transport-http)\//.test(resolved)) throw new Error('PLUGIN_PRIVATE_IMPORT: package imports another owner implementation');
  });
} };
const canonical = value => typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
try {
  const entries = [manifest.server, manifest.maintenance, manifest.client, ...(manifest.assets ?? []),...(manifest.executables??[])].filter(Boolean);
  if (entries.some(entry => !canonical(entry))) throw new Error('Manifest entries must be canonical relative package paths');
  for (const entry of ['server', 'maintenance']) if (manifest[entry]) {
    const result = await build({ entryPoints: [join(directory, `src/${entry}.ts`)], outfile: join(temporary, manifest[entry]), bundle: true, metafile: true, format: 'esm', platform: 'node', target: 'node24', plugins: [ownershipBoundary] });
    for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) if (dependency.external && !dependency.path.startsWith('node:')) throw new Error(`Server dependency must be bundled or use a node: builtin: ${dependency.path}`);
  }
  for(const entry of manifest.executables??[]) await build({entryPoints:[join(directory,'src',entry.replace(/\.m?js$/,'.ts'))],outfile:join(temporary,entry),bundle:true,format:'esm',platform:'node',target:'node24',plugins:[ownershipBoundary]});
  if (manifest.client) {
    const result = await build({ entryPoints: [join(directory, 'src/client.tsx')], outfile: join(temporary, manifest.client), bundle: true, metafile: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', external: [...SHARED_CLIENT_IMPORTS], minifyWhitespace: true, minifySyntax: true, plugins: [ownershipBoundary, { name: 'plugin-css-namespace', setup(builder) {
      builder.onResolve({ filter: /\.module\.css$/ }, args => ({ path: `${manifest.id}-${createHash('sha256').update(relative(directory, resolve(args.resolveDir, args.path))).digest('hex').slice(0, 12)}-${basename(args.path)}`, namespace: 'plugin-css', pluginData: { file: resolve(args.resolveDir, args.path) } }));
      builder.onLoad({ filter: /.*/, namespace: 'plugin-css' }, async args => ({ contents: await readFile(args.pluginData.file, 'utf8'), loader: 'local-css' }));
    } }] });
    if (Object.keys(result.metafile.inputs).some(path => /drizzle-orm|plugins[\\/][^/\\]+[\\/]src[\\/]persistence[\\/]/.test(path))) throw new Error('Client must not bundle server persistence implementation');
    if (Object.keys(result.metafile.inputs).some(path => /node_modules[\\/]react(?:-dom)?[\\/]/.test(path))) throw new Error('Plugin bundled a duplicate React runtime');
    for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) if (dependency.external && !SHARED_CLIENT_IMPORTS.includes(dependency.path)) throw new Error(`Unsupported shared client import ${dependency.path}`);
  }
  await writeFile(join(temporary, 'aork.plugin.json'), JSON.stringify(manifest, null, 2));
  for (const asset of manifest.assets ?? []) {
    try { await readFile(join(temporary, asset)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(dirname(join(temporary, asset)), { recursive: true }); await cp(join(directory, asset), join(temporary, asset)); }
  }
  const members = [];
  async function collect(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(path, entry.name), `${name}/`);
      else {
        if (!entry.isFile()) throw new Error('Only regular files may be archived');
        if (name !== 'aork.plugin.json' && !entries.includes(name)) throw new Error(`Output must be explicitly declared as an entry or asset: ${name}`);
        const bytes = await readFile(join(path, entry.name));
        members.push({ path: name, type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await collect(temporary);
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(resolve(values.out), JSON.stringify({ archiveVersion: 1, members }));
  console.log(JSON.stringify({ archive: resolve(values.out), id: manifest.id, version: manifest.version }));
} finally { await rm(temporary, { recursive: true, force: true }); }
