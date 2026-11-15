import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { maintainProfile, startHost } from './host.js';

const { values, positionals } = parseArgs({ options: { 'data-dir': { type: 'string', default: '.aork' }, host: { type: 'string' }, port: { type: 'string' }, 'distribution-dir': { type: 'string' } }, allowPositionals: true });
const options = { dataDir: resolve(values['data-dir']), ...(values.host ? { host: values.host } : {}), ...(values.port ? { port: Number(values.port) } : {}), ...(values['distribution-dir'] ? { distributionDir: resolve(values['distribution-dir']) } : {}) };
try {
  if (process.versions.node !== '24.22.3') throw new Error('Aork requires the locked Node 24 runtime; see .node-version');
  const command = positionals[0] ?? 'serve';
  if (command === 'serve') {
    const host = await startHost(options);
    console.log(JSON.stringify({ event: 'host.listening', url: host.url, dataDir: host.dataDir }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().then(() => { process.exitCode = 0; }).catch(error => { console.error(error.message); process.exitCode = 1; }); });
  } else if (command === 'doctor' || (command === 'profile' && positionals[1] === 'show')) {
    console.log(JSON.stringify(await maintainProfile(options), null, 2));
  } else if (command === 'profile' && positionals[1] === 'apply' && positionals[2]) {
    console.log(JSON.stringify(await maintainProfile({ ...options, profile: JSON.parse(await readFile(positionals[2], 'utf8')) }), null, 2));
  } else throw new Error('Usage: aork [serve | doctor | profile show | profile apply <file>] [--data-dir <directory>] [--port <port>]');
} catch (error) {
  console.error(JSON.stringify({ event: 'host.failed', code: error && typeof error === 'object' && 'code' in error ? error.code : 'STARTUP_FAILED', message: error instanceof Error ? error.message : 'Startup failed' }));
  process.exitCode = 1;
}
