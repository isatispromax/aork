import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

function launch(directory: string) {
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', directory, '--port', '0']);
  let output = '';
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/"url":"([^"]+)"/); if (match) resolve(match[1]!); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Host exited ${code}: ${output}`)));
  });
  const exited = once(child, 'exit');
  return { child, ready, exited };
}

test('a paused but live Host keeps exclusive ownership beyond a heartbeat window; process exit releases it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aork-process-lock-'));
  const first = launch(directory);
  try {
    await first.ready;
    first.child.kill('SIGSTOP');
    await delay(31_000);
    const second = launch(directory);
    // Refusal must not depend on a responsive heartbeat from the owner process.
    try { await expect(second.ready).rejects.toThrow(/ELOCKED|already locked|temporarily unavailable/i); }
    finally { second.child.kill('SIGTERM'); await second.exited; }
    first.child.kill('SIGKILL');
    await first.exited;
    const replacement = launch(directory);
    try { expect(await replacement.ready).toMatch(/^http:\/\/127\.0\.0\.1:/); }
    finally { replacement.child.kill('SIGTERM'); await replacement.exited; }
  } finally { first.child.kill('SIGCONT'); first.child.kill('SIGKILL'); await first.exited; await rm(directory, { recursive: true, force: true }); }
}, 45_000);
