import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

// Each browser run owns a fresh real data instance; prior profile versions cannot contaminate it.
const directory = await mkdtemp(join(tmpdir(), 'aork-playwright-'));
const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', directory, '--port', process.env.AORK_BROWSER_TEST_PORT ?? '6693'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { child.kill(signal); });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => {
  void rm(directory, { recursive: true, force: true }).then(() => { process.exitCode = code ?? 1; }).catch(() => { console.error('Unable to remove browser test data'); process.exitCode = 1; });
});
