// Dev loop: watch sources, rebuild the distribution, and restart the Host from dist.
// Assets are loaded into memory at Host startup, so a restart is the switch that
// publishes a rebuilt distribution; browser URLs are content-hashed, so a plain
// refresh picks up the new frontend. Server args after `pnpm dev` are forwarded.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, watch } from 'node:fs';
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

// A watcher on a single file also reports reads that leave the file exactly as it is. On macOS a
// `git status` that re-hashes a modified file raises one, so an open agent session would rebuild
// and restart the Host about once a minute. An event therefore counts only when the file's
// modification time or size differs from the last one seen; an event that names nothing, or a
// path that no longer resolves, counts, since only the build can tell what it means. Every file
// is stamped when the loop starts, so the first such read is ignored like all the later ones.
const stamps = new Map();
const stampOf = (full) => { try { const stat = statSync(full); return stat.isFile() ? `${stat.mtimeMs}/${stat.size}` : undefined; } catch { return undefined; } };
function seed(full) {
  const stamp = stampOf(full);
  if (stamp) stamps.set(full, stamp);
  else { try { for (const name of readdirSync(full)) seed(join(full, name)); } catch { /* neither a file nor a readable directory: nothing to stamp */ } }
}
const watched = paths.map((path) => ({ full: join(root, path), file: stampOf(join(root, path)) !== undefined }));
function changed({ full, file }, name) {
  if (name === null || name === undefined) return true;
  // A watch on a single file reports that file's own name, relative to its directory.
  const target = file ? full : join(full, String(name));
  const stamp = stampOf(target);
  if (stamp === undefined) return true;
  if (stamps.get(target) === stamp) return false;
  stamps.set(target, stamp);
  return true;
}
for (const { full } of watched) seed(full);
for (const target of watched) watch(target.full, { recursive: true }, (_event, filename) => { if (changed(target, filename)) schedule(); });
console.log(`[dev] watching ${paths.length} source paths`);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  console.log(`[dev] received ${signal}; stopping`);
  stopping = true;
  if (server) server.kill('SIGTERM');
  process.exit();
});
process.on('SIGHUP', () => console.log('[dev] received SIGHUP; ignoring'));

await rebuild();
