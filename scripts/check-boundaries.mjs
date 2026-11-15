import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const failures = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.[cm]?[jt]sx?$/.test(path)) {
      const source = await readFile(path, 'utf8');
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].map(match => match[2]);
      for (const imported of imports) {
        if (path.startsWith('packages/sdk/') && /cordis|fastify|drizzle|better-sqlite3|@aork\/(kernel|storage|transport-http)|plugins\//.test(imported)) failures.push(`${path} imports private ${imported}`);
        if ((path.startsWith('packages/kernel/') || path.startsWith('apps/web/')) && /plugins\/|@aork\/plugin-/.test(imported)) failures.push(`${path} imports business implementation ${imported}`);
        if (path.startsWith('plugins/') && /@aork\/(kernel|storage|transport-http)|cordis|fastify|better-sqlite3|\.\.\/\.\.\/[^s]/.test(imported)) failures.push(`${path} imports private ${imported}`);
        if (path.startsWith('plugins/') && imported.startsWith('drizzle-orm') && !/^plugins\/[^/]+\/src\/persistence\//.test(path)) failures.push(`${path} imports server-only query compiler ${imported}`);
        if (path.startsWith('apps/web/') && /@aork\/sdk\/server|node:|packages\/(storage|kernel)|plugins\//.test(imported)) failures.push(`${path} imports server implementation ${imported}`);
      }
    }
  }
}
for (const directory of ['apps', 'packages', 'plugins']) await walk(directory);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('SDK, kernel, browser bootstrap and Plugin dependency boundaries passed.');
