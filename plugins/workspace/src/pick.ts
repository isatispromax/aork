import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { AorkError } from '@aork/sdk';
import type { PickDirectory } from '@aork/contracts/workspace';

/** The dialog may legitimately stay open for minutes; the cap only reaps forgotten dialogs. */
const pickerTimeoutMilliseconds = 10 * 60 * 1000;
const pickerEnvironment = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });

export interface PickerProbe { error: (NodeJS.ErrnoException & { killed?: boolean }) | null; stdout: string; stderr: string }
export type RunOsascript = (script: string) => Promise<PickerProbe>;

function runOsascript(script: string): Promise<PickerProbe> {
  return new Promise(resolve => {
    try {
      execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: pickerTimeoutMilliseconds, maxBuffer: 64 * 1024, env: { ...pickerEnvironment } }, (error, stdout, stderr) => {
        resolve({ error: error ? error as NodeJS.ErrnoException & { killed?: boolean } : null, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
      });
    } catch (error) { resolve({ error: error as NodeJS.ErrnoException, stdout: '', stderr: '' }); }
  });
}

function escapeAppleScriptString(value: string): string { return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

export function chooseFolderScript(home: string): string {
  return `POSIX path of (choose folder with prompt "Choose the workspace directory" default location POSIX file "${escapeAppleScriptString(home)}")`;
}

/** `POSIX path of` always ends in a slash; Workspace registration stores unslashed absolute paths (root stays `/`). */
export function normalizePickedDirectory(output: string): string {
  const trimmed = output.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Maps one osascript probe to the picker outcome. Cancel (-128) and a reaped timeout both mean
 * "no selection"; every other failure is an unavailable picker — raw stderr never leaves this module. */
export function pickerOutcome(probe: PickerProbe): PickDirectory {
  if (!probe.error) return { status: 'chosen', directory: normalizePickedDirectory(probe.stdout) };
  if (probe.error.killed) return { status: 'canceled' };
  const cancel = /user canceled|\(-128\)/i.test(`${probe.stderr} ${probe.error.message}`);
  if (cancel) return { status: 'canceled' };
  throw new AorkError('WORKSPACE_PICKER_UNAVAILABLE', 'The native directory picker is unavailable on this server; type the directory path instead', 503);
}

export interface DirectoryPickerOptions { run?: RunOsascript; platform?: NodeJS.Platform; home?: string }

/** Native macOS directory picker. One dialog at a time: a request while the modal is already
 * open is rejected instead of stacking a second panel behind the user's back. */
export function createDirectoryPicker(options: DirectoryPickerOptions = {}): () => Promise<PickDirectory> {
  const run = options.run ?? runOsascript;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  let open = false;
  return async () => {
    if (platform !== 'darwin') throw new AorkError('WORKSPACE_PICKER_UNAVAILABLE', 'The native directory picker requires a macOS server; type the directory path instead', 503);
    if (open) throw new AorkError('WORKSPACE_PICKER_BUSY', 'A directory picker dialog is already open', 409);
    open = true;
    try { return pickerOutcome(await run(chooseFolderScript(home))); } finally { open = false; }
  };
}
