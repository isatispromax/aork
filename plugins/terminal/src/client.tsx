/** The terminal panel type of the right region: the user's own login shell in a tab, one tab per
 * terminal, in the shape of deepseek-harness's web terminal (ui-sidebar-terminal; MIT). The shell
 * runs on the Host as the Host's own system user; the panel draws its terminal and carries what is
 * typed to it. Nothing is sent as a command to run: the browser names a shell the Host listed. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { InspectorTabContext } from '@aork/contracts/workbench';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { decodeBase64, encodeBase64, InputQueue } from './input.js';
import { TERMINAL_COMMANDS, TERMINAL_LIMITS, TERMINAL_OUTPUT_RESOURCE, TERMINAL_QUERIES, type TerminalInfo, type TerminalOutput, type TerminalShells, type TerminalState } from './protocol.js';
import { forgetCreated, markCreated, wasCreated } from './store.js';
import styles from './terminal.module.css';

type Tab = InspectorTabContext['tab'];
/** What the body knows of its terminal. */
type Phase = 'creating' | 'connected' | 'exited' | 'missing' | 'failed' | 'unsupported';

const STATES: readonly string[] = ['starting', 'running', 'exited'];
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TITLE_LIMIT = 120;
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });
const clamp = (value: number, [least, most]: readonly [number, number]): number => Math.max(least, Math.min(most, value));
/** The code of a refused request, where the runtime gave one. */
const codeOf = (failure: unknown): string | undefined => failure instanceof Error && 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined;
function messageOf(failure: unknown): string {
  const code = codeOf(failure);
  if (code === 'TERMINAL_LIMIT') return `同时运行的终端已达上限（${TERMINAL_LIMITS.concurrent} 个）；请先关闭其他终端。`;
  if (code === 'TERMINAL_START_FAILED') return 'shell 未能启动；请重试或换一个 shell。';
  if (code === 'TERMINAL_SHELL_UNKNOWN') return '所选的 shell 不可用。';
  if (code === 'TERMINAL_PLATFORM_UNSUPPORTED') return '此平台暂不支持终端。';
  return failure instanceof Error && failure.message ? failure.message : '终端不可用。';
}

/** One read's answer, or `undefined` when the bytes are not an answer this body can use. */
function readOutput(bytes: Uint8Array): TerminalOutput | undefined {
  try {
    const frame: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (frame === null || typeof frame !== 'object') return undefined;
    const { terminalId, from, next, data, state, exitCode } = frame as Record<string, unknown>;
    if (typeof terminalId !== 'string' || typeof from !== 'number' || typeof next !== 'number' || typeof data !== 'string' || typeof state !== 'string' || !STATES.includes(state)) return undefined;
    return { terminalId, from, next, data, state: state as TerminalState, exitCode: typeof exitCode === 'number' ? exitCode : null };
  } catch { return undefined; }
}

/** The Workspace selected in the address, by the key the public URL contract gives it. Read here
 * rather than through the contract module, which would carry the Workspace schemas into the
 * browser bundle for the sake of one name. */
function selectedWorkspace(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('workspace') || undefined;
}

function useHash(): string {
  const [value, setValue] = useState(() => location.hash);
  useEffect(() => {
    const changed = (): void => { setValue(location.hash); };
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  return value;
}

/* Per terminal, for as long as its tab is open. A body unmounts whenever its tab is not the one
 * showing, but the terminal keeps running: what was typed but not yet sent, and the ending of the
 * terminal when the tab closes, outlive every body. */
const inputs = new Map<string, InputQueue>();
const endings = new Map<string, () => void>();
/** Ties a terminal to its tab: the queue of what is typed, and ending it when the tab closes. */
function watch(tab: Tab, runtime: UiRuntime): InputQueue {
  const id = tab.content ?? tab.id;
  let input = inputs.get(id);
  if (!input) {
    input = new InputQueue(async (bytes) => {
      try { await runtime.command(TERMINAL_COMMANDS.write, { terminalId: id, data: encodeBase64(bytes) }, crypto.randomUUID()); return 'sent'; }
      catch (failure) { return codeOf(failure) === 'TERMINAL_NOT_FOUND' || codeOf(failure) === 'TERMINAL_EXITED' ? 'stopped' : 'retry'; }
    }, TERMINAL_LIMITS.writeBytes);
    inputs.set(id, input);
  }
  if (!endings.has(id)) {
    // Only the tab closing ends a terminal — not a switch to another tab, a collapsed region or a
    // reload. A terminal outlives the page: its tab comes back to it, as long as the Host does.
    const end = (): void => {
      endings.delete(id);
      inputs.get(id)?.stop();
      inputs.delete(id);
      forgetCreated(tab.sessionId, id);
      try { void runtime.command(TERMINAL_COMMANDS.close, { terminalId: id }, crypto.randomUUID()).catch(() => { /* already gone */ }); }
      catch { /* the page itself is going away; the Host ends the terminal when it stops */ }
    };
    endings.set(id, end);
    tab.signal.addEventListener('abort', end, { once: true });
  }
  return input;
}

/** The colours the terminal draws with: the workbench's own surface and text, and one of two
 * palettes chosen by how light the surface is. Read off the panel's root, which paints itself in
 * the surface colour; the screen on top of it is transparent, and a transparent background would
 * leave the terminal on the black of its own stylesheet. */
function themeOf(node: HTMLElement): ITheme {
  const style = getComputedStyle(node);
  const background = style.backgroundColor || '#ffffff';
  const foreground = style.color || '#0f1115';
  const dark = luminance(background) < 0.5;
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: dark ? 'rgba(140, 186, 255, 0.35)' : 'rgba(89, 117, 156, 0.28)',
    ...(dark ? DARK : LIGHT),
  };
}
/** Relative luminance of an `rgb()` or `rgba()` colour; 0 for anything else. */
function luminance(color: string): number {
  const channels = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (!channels) return 0;
  const [red, green, blue] = channels.slice(1).map((value) => { const level = Number(value) / 255; return level <= 0.03928 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
const LIGHT: ITheme = {
  black: '#383a42', red: '#b54235', green: '#2f8f5b', yellow: '#986f1c', blue: '#2f6fb0', magenta: '#8a4fb5', cyan: '#1f7a86', white: '#6b7079',
  brightBlack: '#8b9099', brightRed: '#c9503f', brightGreen: '#2f9f66', brightYellow: '#b0821f', brightBlue: '#3a80c4', brightMagenta: '#9a5fc6', brightCyan: '#248c99', brightWhite: '#20242a',
};
const DARK: ITheme = {
  black: '#5c6066', red: '#e06c60', green: '#7fbf8a', yellow: '#d9b45a', blue: '#7fb0e0', magenta: '#b58fd9', cyan: '#6fbfc9', white: '#c5c8cd',
  brightBlack: '#7c8087', brightRed: '#f08a7e', brightGreen: '#9fd9a8', brightYellow: '#ecd07e', brightBlue: '#a3cbee', brightMagenta: '#cfaee9', brightCyan: '#93d9e1', brightWhite: '#f2f3f5',
};

function TerminalBody({ runtime, context }: ViewProps) {
  const tab = (context as InspectorTabContext | undefined)?.tab;
  // The chip keeps the type's label, or a title the shell reported; nothing here resets it.
  if (!tab || tab.content === undefined) return <p className={styles.orphan} role="status">终端面板只能显示在右侧栏的标签里。</p>;
  // One body is one terminal: its queue is found once, and it never has to follow another.
  return <TerminalTab key={tab.id} runtime={runtime} tab={tab} />;
}

function TerminalTab({ runtime, tab }: { runtime: UiRuntime; tab: Tab }) {
  const id = tab.content ?? tab.id;
  const input = watch(tab, runtime);
  const hash = useHash();
  const workspaceId = selectedWorkspace(hash);
  // The Workspace a terminal starts in is the one selected as it starts.
  const workspace = useRef(workspaceId);
  workspace.current = workspaceId;
  const [phase, setPhase] = useState<Phase>('creating');
  // What the callbacks that are not React see as the current phase.
  const phaseNow = useRef<Phase>('creating');
  phaseNow.current = phase;
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [failure, setFailure] = useState('');
  const [shells, setShells] = useState<TerminalShells>();
  const [shell, setShell] = useState('');
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const shown = useRef(visible);
  shown.current = visible;
  const root = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const measure = useRef<() => void>(() => { /* set once the screen exists */ });
  const cursor = useRef(0);
  const size = useRef({ cols: 0, rows: 0 });
  const starting = useRef(false);
  const mounted = useRef(true);

  /** Starts the terminal of this tab, in `chosen` or in the Host's default shell. */
  const start = useCallback(async (chosen: string): Promise<void> => {
    if (starting.current) return;
    starting.current = true;
    setPhase('creating');
    phaseNow.current = 'creating';
    setExitCode(null);
    setFailure('');
    term.current?.reset();
    cursor.current = 0;
    input.revive();
    try {
      const { cols, rows } = size.current;
      await runtime.command<TerminalInfo>(TERMINAL_COMMANDS.create, { terminalId: id, ...(chosen ? { shell: chosen } : {}), ...(cols && rows ? { cols, rows } : {}), ...(workspace.current ? { workspaceId: workspace.current } : {}) }, crypto.randomUUID());
      if (!mounted.current) return;
      markCreated(tab.sessionId, id);
      setPhase('connected');
    } catch (error) {
      if (!mounted.current) return;
      setFailure(messageOf(error));
      setPhase(codeOf(error) === 'TERMINAL_PLATFORM_UNSUPPORTED' ? 'unsupported' : 'failed');
    } finally { starting.current = false; }
  }, [runtime, id, input, tab.sessionId]);

  /* The screen. */
  useLayoutEffect(() => {
    const node = screen.current!;
    const xterm = new Terminal({ fontFamily: FONT, fontSize: 12, lineHeight: 1.35, scrollback: 10000, cursorBlink: true, rightClickSelectsWord: true, minimumContrastRatio: 4.5, theme: themeOf(root.current!) });
    const addon = new FitAddon();
    xterm.loadAddon(addon);
    xterm.open(node);
    xterm.textarea?.setAttribute('aria-label', '终端输入');
    term.current = xterm;
    fit.current = addon;
    // A title the shell reports — the directory, the command running — names the tab.
    const titles = xterm.onTitleChange((title) => { const name = title.trim(); if (name) tab.setTitle(name.slice(0, TITLE_LIMIT)); });
    const typed = xterm.onData((data) => { if (phaseNow.current === 'connected') input.push(new TextEncoder().encode(data)); });
    cursor.current = 0;
    mounted.current = true;
    return () => { mounted.current = false; titles.dispose(); typed.dispose(); addon.dispose(); xterm.dispose(); term.current = undefined; fit.current = undefined; };
  }, [input, tab]);

  /* Finding the terminal: a tab restored with its layout returns to the terminal it had; a tab
   * just opened has none yet and starts one. A terminal this browser started and no longer exists
   * is not started again on its own. */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const frame = readOutput((await runtime.resource(TERMINAL_OUTPUT_RESOURCE, { terminalId: id, after: '0' })).bytes);
        if (!live || !frame) return;
        cursor.current = frame.next;
        if (frame.data.length > 0) term.current?.write(decodeBase64(frame.data));
        if (frame.state === 'exited') { setExitCode(frame.exitCode); setPhase('exited'); }
        else setPhase('connected');
      } catch (error) {
        if (!live) return;
        if (codeOf(error) === 'TERMINAL_NOT_FOUND') {
          if (wasCreated(tab.sessionId, id)) setPhase('missing');
          else await start('');
          return;
        }
        setFailure(messageOf(error));
        setPhase('failed');
      }
    })();
    return () => { live = false; };
  }, [runtime, id, tab.sessionId, start]);

  /* Reading the terminal. Each read waits on the Host for output, so the loop is paced by the
   * reads themselves; it runs only while the screen can be seen, and picks up from where it
   * stopped — the Host keeps what arrived meanwhile. */
  const connected = phase === 'connected';
  useEffect(() => {
    if (!connected || !visible) return;
    let live = true;
    const read = async (): Promise<void> => {
      while (live) {
        try {
          const frame = readOutput((await runtime.resource(TERMINAL_OUTPUT_RESOURCE, { terminalId: id, after: String(cursor.current) })).bytes);
          if (!live) return;
          // An answer that is not one is left alone for a moment rather than acted on.
          if (!frame) { await delay(500); continue; }
          // Away longer than the terminal kept its output: what was missed is not coming, so the screen starts over.
          if (frame.from > cursor.current) term.current?.reset();
          cursor.current = frame.next;
          if (frame.data.length > 0) term.current?.write(decodeBase64(frame.data));
          if (frame.state === 'exited') { setExitCode(frame.exitCode); setPhase('exited'); return; }
          // A read with nothing new already waited; a terminal still starting is asked again shortly.
          if (frame.state === 'starting') await delay(50);
        } catch (error) {
          if (!live) return;
          if (codeOf(error) === 'TERMINAL_NOT_FOUND') { setPhase('missing'); return; }
          await delay(1000);
        }
      }
    };
    void read();
    return () => { live = false; };
  }, [connected, visible, runtime, id]);

  /* Fitting the screen to its pane; the Host's terminal follows the grid drawn here. */
  useLayoutEffect(() => {
    const node = screen.current!;
    const fitScreen = (): void => {
      const xterm = term.current;
      // A screen that is not on screen has no size to propose, and none to send.
      if (!xterm || !shown.current || !node.clientWidth || !node.clientHeight) return;
      const dimensions = fit.current?.proposeDimensions();
      if (!dimensions) return;
      const cols = clamp(dimensions.cols, TERMINAL_LIMITS.cols);
      const rows = clamp(dimensions.rows, TERMINAL_LIMITS.rows);
      if (cols === size.current.cols && rows === size.current.rows) return;
      size.current = { cols, rows };
      xterm.resize(cols, rows);
      if (phaseNow.current === 'connected') void runtime.command(TERMINAL_COMMANDS.resize, { terminalId: id, cols, rows }, crypto.randomUUID()).catch(() => { /* a terminal that went reports by its output */ });
    };
    measure.current = fitScreen;
    const observer = new ResizeObserver(fitScreen);
    observer.observe(node);
    fitScreen();
    return () => { observer.disconnect(); measure.current = () => { /* the screen is gone */ }; };
  }, [runtime, id]);

  /* Shown in the page, and the page on top: a terminal nobody can look at is not read. */
  useEffect(() => {
    const inView = { current: true };
    const update = (): void => { setVisible(inView.current && document.visibilityState === 'visible'); };
    const observer = new IntersectionObserver((entries) => { inView.current = entries.some(entry => entry.isIntersecting); update(); });
    observer.observe(screen.current!);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  // Back on screen, the pane may have changed shape while the screen could not see it.
  useEffect(() => { if (visible) measure.current(); }, [visible]);
  // The terminal takes the keys as soon as there is something to take them, and no longer when there is not.
  useEffect(() => {
    if (!term.current) return;
    term.current.options.disableStdin = phase !== 'connected';
    if (phase === 'connected') term.current.focus();
  }, [phase]);

  /* The workbench's theme is its own to change; the terminal follows it. */
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => { if (term.current && root.current) term.current.options.theme = themeOf(root.current); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-aork-theme', 'style'] });
    return () => observer.disconnect();
  }, []);

  /* The shells the Host will start. */
  useEffect(() => {
    let live = true;
    void runtime.query<TerminalShells>(TERMINAL_QUERIES.shells).then((offered) => { if (live) { setShells(offered); setShell((current) => current || offered.default); } }, () => { if (live) setShells({ shells: [], default: '' }); });
    return () => { live = false; };
  }, [runtime]);

  const running = phase === 'creating' || phase === 'connected';
  const status: string | undefined = phase === 'creating' ? '正在启动 shell…'
    : phase === 'exited' ? (exitCode === null ? '进程已结束' : `进程已退出（${exitCode}）`)
    : phase === 'missing' ? '此终端已不存在，请新建终端。'
    : phase === 'failed' ? `终端无法使用：${failure}`
    : phase === 'unsupported' ? '此平台暂不支持终端。'
    : undefined;
  return (
    <div ref={root} className={styles.root} data-dock-fill data-terminal-phase={phase} data-terminal-id={id}>
      <div className={styles.toolbar}>
        <label className={styles.shell}>Shell
          <select aria-label="Shell" value={shell} disabled={running || !shells?.shells.length} onChange={(event) => { setShell(event.currentTarget.value); }}>
            {shell === '' && <option value="">（不可用）</option>}
            {shells?.shells.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" className={styles.restart} disabled={running || !shells?.shells.length} onClick={() => { void start(shell); }}>新建终端</button>
      </div>
      {status !== undefined && <p className={styles.status} role="status">{status}</p>}
      <div ref={screen} className={styles.screen} data-terminal-screen />
    </div>
  );
}

export function activate(context: ClientPluginContext) {
  context.registerExtension('terminal', TerminalBody);
}
