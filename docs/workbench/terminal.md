# Terminal panel

The `terminal` Plugin contributes the Terminal panel type to the right region (`aork.workbench.inspector-tabs@1`, `multiple`): one tab per terminal, each running the user's own login shell on the Host. It is in the shape of deepseek-harness's web terminal (`packages/client/ui-sidebar-terminal`; MIT) and written for this workbench: a Plugin with public contracts, no part of dsh's own runtime.

## Trust boundary

- **The terminal is the user's own shell.** It runs as the system user the Host runs as, with that user's login shell and that user's own shell configuration. It is not a managed writer: it takes no Workspace Claim, checks none, and whatever it changes on disk is reconciled by the Workspace file service's revision checks, not by it. It is not a sandbox against the user.
- **The browser never hands over a command.** It names a shell by its exact path, and the Host starts it only when the path is one it listed itself from `/etc/shells` and found executable (`terminal.shells`). Anything else — a bare name, a path with arguments, a path that was never listed — is refused with `TERMINAL_SHELL_UNKNOWN`.
- **The shell's environment is an explicit whitelist.** Of the Host's environment only `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG` and `TMPDIR` are passed on. The Plugin sets `SHELL` to the chosen shell, `TERM` to `xterm-256color`, and two names of its own for the supervisor (`AORK_SHELL`, and the starting size `AORK_ROWS` / `AORK_COLS`). Nothing else of the Host — credentials, tokens, server settings — reaches the shell.
- **Where it starts.** In the directory of the Workspace selected where the terminal is opened; without one, or when that directory is gone, at the account's home.
- **What a closed terminal guarantees.** `terminal.close` answers `confirmed: true` only when the launcher has exited, nothing is left on the terminal's device, and the launcher's process group is gone. Processes that deliberately left the terminal — a daemon that detached itself — are not tracked and are not claimed to have ended.

## Server

| Surface | Payload | Result |
| --- | --- | --- |
| `terminal.shells` (query) | — | `{ shells: [{ path, name }], default }`; empty on a platform the launcher is not written for |
| `terminal.list` (query) | — | `{ terminals: TerminalInfo[] }` for the current Host process |
| `terminal.create` (command) | `{ terminalId, shell?, cols?, rows?, workspaceId? }` | `TerminalInfo`; waits up to 3 s for the terminal to report itself |
| `terminal.write` (command) | `{ terminalId, data }`, `data` base64 | `{ written }` |
| `terminal.resize` (command) | `{ terminalId, cols, rows }` | `{ cols, rows }` |
| `terminal.close` (command) | `{ terminalId }` | `{ terminalId, confirmed, exitCode }` |
| `terminal.output` (resource) | `terminalId`, `after` | JSON `{ terminalId, from, next, data, state, exitCode }` |

The terminal's id is the tab's `content`: the browser mints it when the tab opens and names it in every command. A terminal that exited keeps its record while its tab is open, so the tab can say how the shell ended; starting one under the same id replaces it. A terminal that is already running is refused with `TERMINAL_EXISTS`.

**Reading output.** Every byte a terminal wrote has a position that only grows. A read asks for what came after a position and gets the bytes at `[from, next)`, at most 192 KiB at a time. The Host keeps the newest 256 KiB of each terminal, so a tab that was switched away from — its body unmounts — or a page that was reloaded comes back to what it missed. A reader that was away longer than that is answered from the oldest byte still kept: `from` is past what it asked for, and the panel clears the screen rather than showing a hole.

A read that finds nothing new waits for output or a change of state, for at most 500 ms, and then answers empty. The bound is short on purpose: the Host waits for reads in flight before it closes, and a read must not be what holds it.

**Writing input.** A write carries at most 32 KiB decoded (`TERMINAL_INPUT_TOO_LARGE` beyond that). The transport caps a JSON request body at 64 KiB and base64 makes three bytes four characters, so the panel sends a paste in several writes; it coalesces what is typed during a frame into one write, keeps the order, retries a write that failed for a reason that may pass, and gives up on one whose terminal is gone.

### Bounds

| Bound | Value |
| --- | --- |
| Terminals running at once | 8 (`TERMINAL_LIMIT`) |
| One write | 32 KiB decoded |
| Screen | `cols` 2–500, `rows` 1–200 |
| Output kept per terminal | 256 KiB |
| One read | 192 KiB |
| A read that finds nothing | 500 ms |
| Ending a terminal | 2 s before the next step; 1.5 s when the Plugin unloads |

### How a terminal is started

macOS only, with its own tools: the launcher is not written for another platform, where `terminal.shells` is empty and `terminal.create` answers `TERMINAL_PLATFORM_UNSUPPORTED`.

```
zsh -f -c 'exec /usr/bin/script -F -q /dev/null /bin/sh -c "$0" aork-terminal < <(cat)' <supervisor>
```

The outer shell execs into `script`, so the process Node holds *is* the terminal: its exit is the shell's exit, with the shell's status. `script` gives the terminal; a supervisor runs on it and starts the login shell as a job of its own. The supervisor reports itself first — which tty it owns, its own pid, then the shell's pid — as two OSC sequences no program produces, which the Plugin takes out of the output. Each reason the shape is what it is was met on this machine:

- `script` refuses a socket as its stdin, and Node hands children sockets; stdin is forwarded to it through a pipe by `cat`. The pipe is destroyed once the terminal ends, and the reader leaves on that.
- The supervisor is not an interactive shell and has no job control, so a command it puts in the background reads `/dev/null`; the login shell is therefore given the terminal to read.
- It ignores its signals with `trap ':'` rather than `trap ''`: an ignored signal would be inherited by the login shell.
- It sets the terminal's size before it starts the shell, so nothing the shell reads while starting finds a terminal of no size.
- When the shell exits it sweeps, while it still holds the terminal, whatever else is on that terminal — `TERM`, a moment, `KILL` — and exits with the shell's status. Once it exits, everything else on the terminal loses the terminal at once and can no longer be found by it.
- This macOS reports every process's session id as 0, so the members of a terminal's session are counted by the terminal they share (`ps -axo pid=,tty=`).
- Node 24 has no `fcntl`, so a resize goes through `stty -f <tty> rows R cols C`. A size asked for before the terminal is known is carried to the shell in the environment instead.

### Ending

Closing the tab sends `terminal.close`. The login shell is hung up on first — what a closed terminal does to a shell — then sent `TERM`, then `KILL`, each only if the one before was not enough. The supervisor then sweeps and exits with the shell's status; should it not, it is killed, then the launcher's process group, then whatever still holds the terminal. Only then is the absence confirmed, by the three checks above.

While any terminal runs, the Plugin's lifecycle authority reports `busy`, and a change to the Plugin graph — disabling a Plugin, changing its configuration — is refused. When the Plugin unloads, every read in flight answers at once and every shell is ended within the time the Host allows.

A terminal outlives the page: it is not ended by a switch to another tab, a collapsed region or a reload, and its tab returns to it. It does not outlive the Host. A tab restored from a saved layout after the Host restarted finds its terminal gone and says so — 此终端已不存在，请新建终端。 — with a button to start another; nothing is started on its own.

## Client

The panel draws the terminal with `@xterm/xterm` and fits it to its pane with `@xterm/addon-fit`; the Host's terminal follows the grid the screen is fitted to. Its colours are read from the workbench's own surface and text and follow the workbench's theme.

- It reads the terminal only while the screen can be seen — shown in the page, and the page on top — and picks up from where it stopped.
- The chip keeps the type's label, or the last title the shell reported.
- `Shell` names the shell the next terminal of the tab starts in, and only the Host's own list; 新建终端 starts one, and is offered only while no shell is running in the tab.
- The exited shell is reported as 进程已退出（{code}）.

## Verification boundary

`tests/terminal-panel.test.ts` covers the output ring, the reading of the start marks (split every way a read can split them), the listing of a terminal's processes, the shell list and the environment whitelist, and the input queue — all pure logic. On macOS it also starts real shells on real terminals: the report and the starting size, a resize, the whitelist holding, the exit status, the sweep of what a shell left in the background, and a busy shell ended and confirmed gone.

`tests/browser/terminal-panel.spec.ts` runs against a real Host in Chromium: a terminal started from the start page in the Workspace's directory, input and output through the screen, a tab switched away from and back, the shell's exit and a new terminal in the same tab, a Host restart, and the tab's close leaving nothing running; and, through the commands themselves, that only a listed shell starts and that every bound holds.
