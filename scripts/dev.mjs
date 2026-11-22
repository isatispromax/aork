// Dev loop: watch sources, rebuild the distribution, and restart the Host from dist.
// Assets are loaded into memory at Host startup, so a restart is the switch that
// publishes a rebuilt distribution; browser URLs are content-hashed, so a plain
// refresh picks up the new frontend. Server args after `pnpm dev` are forwarded.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';

if (process.versions.node !== '24.22.3') throw new Error('Dev requires Node 24; see .node-version');
const root = process.cwd();
const serverArgs = process.argv.slice(2);

const paths = ['apps/server/src', 'apps/web/src', 'apps/web/index.html', 'profiles/personal-server.json', 'scripts/build.mjs'];
for (const group of ['packages', 'plugins']) for (const name of readdirSync(join(root, group))) {
  if (existsSync(join(root, group, name, 'src'))) paths.push(`${group}/${name}/src`);
  if (existsSync(join(root, group, name, 'aork.plugin.json'))) paths.push(`${group}/${name}/aork.plugin.json`);
}

let building = false;
let queued = false;
let server = null;
let stopping = false;
let restartPending = false;

function spawnServer() {
  server = spawn(process.execPath, ['dist/server/main.mjs', ...serverArgs], { cwd: root, stdio: 'inherit' });
  console.log(`[dev] host started (pid ${server.pid})`);
  server.on('exit', (code, signal) => {
    server = null;
    if (stopping) return;
    if (restartPending) { restartPending = false; spawnServer(); return; } // exit we requested; the Host closes gracefully
    console.log(`[dev] host exited (code ${code ?? signal}); restarting in 1s`);
    setTimeout(() => { if (!stopping && !server) spawnServer(); }, 1000);
  });
}

function restartHost() {
  if (!server) { spawnServer(); return; }
  restartPending = true;
  const old = server;
  old.kill('SIGTERM');
  const force = setTimeout(() => { if (old.exitCode === null && old.signalCode === null) old.kill('SIGKILL'); }, 3000);
  old.once('exit', () => clearTimeout(force)); // exit handler respawns
}

async function rebuild() {
  if (building) { queued = true; return; }
  building = true;
  console.log('[dev] rebuilding distribution...');
  const started = Date.now();
  const code = await new Promise(resolve => {
    const build = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
    build.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  building = false;
  if (queued) { queued = false; rebuild(); return; } // rebuild again before publishing
  if (code === 0) { console.log(`[dev] rebuilt in ${Date.now() - started}ms`); restartHost(); }
  else console.log('[dev] build failed; keeping current host');
}

let timer = null;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { timer = null; rebuild(); }, 120); }
for (const path of paths) watch(join(root, path), { recursive: true }, schedule);
console.log(`[dev] watching ${paths.length} source paths`);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  console.log(`[dev] received ${signal}; stopping`);
  stopping = true;
  if (server) server.kill('SIGTERM');
  process.exit();
});
process.on('SIGHUP', () => console.log('[dev] received SIGHUP; ignoring'));

await rebuild();
