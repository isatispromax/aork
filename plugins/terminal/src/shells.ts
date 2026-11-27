/** Which shells a terminal may be started in, as pure logic. The browser names one of these or
 * none; it never hands over a command to run. */

/** The login shells `/etc/shells` lists: one absolute path per line, comments aside, in order. */
export function parseShells(text: string): string[] {
  const shells: string[] = [];
  for (const line of text.split('\n')) {
    const path = line.trim();
    if (!path || path.startsWith('#') || !path.startsWith('/') || path.includes('\0') || shells.includes(path)) continue;
    shells.push(path);
  }
  return shells;
}

/** What a shell is called by: the last segment of its path. */
export function shellName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The shell a terminal starts in when none is named: the account's own, where it is one of the
 * listed shells, else the first listed. */
export function defaultShell(shells: readonly string[], loginShell: string | undefined): string | undefined {
  return loginShell !== undefined && shells.includes(loginShell) ? loginShell : shells[0];
}

/** Where the login shells are listed. */
export const SHELLS_FILE = '/etc/shells';

/** The names a terminal inherits from the Host's environment, and no others: what a shell needs to
 * find the account, its files and its programs. Nothing else of the Host's own — credentials,
 * tokens, server settings — reaches the shell. */
export const INHERITED_NAMES: readonly string[] = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR'];

/** The environment a terminal is started with. `size`, when given, is the size the supervisor gives
 * the terminal before the shell starts; the names are absent otherwise. */
export function terminalEnvironment(source: Readonly<Record<string, string | undefined>>, shell: string, size?: { readonly cols: number; readonly rows: number }): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_NAMES) {
    const value = source[name];
    if (value !== undefined && !value.includes('\0')) environment[name] = value;
  }
  // The shell knows itself, programs know what terminal they are drawing for, and the supervisor
  // reads which shell to start from one name of its own.
  environment.SHELL = shell;
  environment.TERM = 'xterm-256color';
  environment.AORK_SHELL = shell;
  if (size !== undefined) {
    environment.AORK_ROWS = String(size.rows);
    environment.AORK_COLS = String(size.cols);
  }
  return environment;
}
