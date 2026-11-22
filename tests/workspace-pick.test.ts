import { expect, test } from 'vitest';
import { AorkError } from '@aork/sdk';
import { chooseFolderScript, createDirectoryPicker, normalizePickedDirectory, pickerOutcome } from '../plugins/workspace/src/pick.ts';
import type { PickerProbe } from '../plugins/workspace/src/pick.ts';

test('chooseFolderScript pins the prompt and escapes the default location for AppleScript', () => {
  expect(chooseFolderScript('/Users/demo')).toBe('POSIX path of (choose folder with prompt "Choose the workspace directory" default location POSIX file "/Users/demo")');
  expect(chooseFolderScript('/Users/de\\"mo')).toContain('POSIX file "/Users/de\\\\\\"mo"');
});

test('normalizePickedDirectory strips the trailing slash POSIX path always adds, keeping the root total', () => {
  expect(normalizePickedDirectory('/Users/demo/notes/\n')).toBe('/Users/demo/notes');
  expect(normalizePickedDirectory('/')).toBe('/');
  expect(normalizePickedDirectory('///')).toBe('/');
});

test('pickerOutcome maps success, cancel and reaped timeouts, and hides every other failure behind an unavailable picker', () => {
  expect(pickerOutcome({ error: null, stdout: '/Volumes/Docs/\n', stderr: '' })).toEqual({ status: 'chosen', directory: '/Volumes/Docs' });
  expect(pickerOutcome({ error: new Error('Command failed') as NodeJS.ErrnoException, stdout: '', stderr: 'execution error: User canceled. (-128)' })).toEqual({ status: 'canceled' });
  expect(pickerOutcome({ error: Object.assign(new Error('spawn timed out'), { killed: true }) as NodeJS.ErrnoException & { killed?: boolean }, stdout: '', stderr: '' })).toEqual({ status: 'canceled' });
  for (const probe of [
    { error: Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' },
    { error: new Error('osascript: OpenScripting.framework error -609'), stdout: '', stderr: '' },
  ] as PickerProbe[]) expect(() => pickerOutcome(probe)).toThrowError(AorkError);
  try { pickerOutcome({ error: new Error('osascript failed'), stdout: '', stderr: 'raw internal detail' }); } catch (error) {
    expect(error).toMatchObject({ code: 'WORKSPACE_PICKER_UNAVAILABLE', status: 503 });
    expect((error as Error).message).not.toContain('raw internal detail');
  }
});

test('the picker refuses non-mac servers and serializes concurrent dialogs', async () => {
  const unavailable = createDirectoryPicker({ platform: 'linux', run: async () => { throw new Error('never spawns'); } });
  await expect(unavailable()).rejects.toMatchObject({ code: 'WORKSPACE_PICKER_UNAVAILABLE', status: 503 });

  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const scripts: string[] = [];
  const pick = createDirectoryPicker({
    platform: 'darwin', home: '/Users/demo',
    run: async script => { scripts.push(script); await gate; return { error: null, stdout: '/Users/demo/picked/', stderr: '' }; },
  });
  const first = pick();
  await expect(pick()).rejects.toMatchObject({ code: 'WORKSPACE_PICKER_BUSY', status: 409 });
  release();
  await expect(first).resolves.toEqual({ status: 'chosen', directory: '/Users/demo/picked' });
  // The guard reopens after the dialog settles and the script pins the injected home.
  await expect(pick()).resolves.toMatchObject({ status: 'chosen' });
  expect(scripts.every(script => script.includes('"/Users/demo"'))).toBe(true);
});
