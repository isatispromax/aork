import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sessionHost } from '../fixtures/session-host.js';
import { openWorkbench } from '../fixtures/workbench-host.js';
import { openPanel } from '../fixtures/right-region.js';

type Host = Awaited<ReturnType<typeof sessionHost>>;
const command = (f: Host, name: string, payload: unknown) => f.command(name, payload).then(async response => ({ status: response.status, body: await response.json() as { error?: { code: string }; result?: unknown } }));

/** Selects a Session of the environment in the page. */
function show(page: Page, env: { workspace: { id: string } }, sessionId: string) {
  return page.evaluate(({ workspace, session }) => { location.hash = new URLSearchParams({ workspace, session }).toString(); }, { workspace: env.workspace.id, session: sessionId });
}

test('the terminal panel runs a shell in the Workspace, keeps it across tabs and a reload, and ends it with its tab', async ({ page }) => {
  // The account's own shell, wherever this runs, is whatever the Host finds first: /bin/sh keeps the test off this machine's own configuration.
  const previous = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  const f = await sessionHost();
  try {
    await page.setViewportSize({ width: 1440, height: 940 });
    const { env, session } = await openWorkbench(f, 'Terminal');
    await page.goto(f.host.accessUrl);
    await show(page, env, session.id);
    const right = page.getByRole('complementary', { name: '右侧栏', exact: true });
    const chips = right.getByRole('tablist').getByRole('tab');
    const chipFor = (title: string | RegExp) => right.getByRole('tablist').getByRole('tab', { name: title });
    const terminals = async () => ((await (await f.query('terminal.list')).json()) as { terminals: { terminalId: string; state: string }[] }).terminals;
    const control = (name: string) => right.getByRole('button', { name, exact: true });

    // Opening the type starts a shell at once, in the Workspace that is selected.
    await openPanel(page, '终端');
    const panel = right.locator('[data-terminal-id]');
    const screen = panel.locator('.xterm-rows');
    const text = async () => (await screen.textContent()) ?? '';
    await expect(panel).toHaveAttribute('data-terminal-phase', 'connected', { timeout: 15000 });
    const id = (await panel.getAttribute('data-terminal-id'))!;
    expect(await terminals()).toMatchObject([{ terminalId: id, state: 'running' }]);
    // Typed input reaches the shell; what it prints comes back. The answer is spelled so that the echoed command cannot match it.
    await page.keyboard.type('test "$(pwd -P)" = "' + env.workspace.directory + '" && echo "in-""workspace"');
    await page.keyboard.press('Enter');
    await expect.poll(text, { timeout: 10000 }).toMatch(/in-workspace/);
    // The Host's terminal has the size of the pane the screen was fitted to.
    await page.keyboard.type('stty size');
    await page.keyboard.press('Enter');
    await expect.poll(text).toMatch(/(\d+) (\d+)/);

    // Switching away unmounts the panel and leaves the shell running; coming back shows what was printed.
    await control('新建标签页').click();
    await openPanel(page, '文件');
    expect(await terminals()).toHaveLength(1);
    await chipFor('终端').click();
    await expect(panel).toHaveAttribute('data-terminal-phase', 'connected');
    await expect.poll(text).toMatch(/in-workspace/);
    // The start page gave its place to Files: two tabs, the terminal's still among them.
    await expect(chips).toHaveCount(2);
    await expect(chipFor('文件')).toHaveCount(1);

    // The shell exiting ends the terminal with its status and offers a new one in the same tab.
    await page.keyboard.type('exit 3');
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('进程已退出（3）', { timeout: 10000 });
    expect(await terminals()).toMatchObject([{ terminalId: id, state: 'exited' }]);
    await control('新建终端').click();
    await expect(panel).toHaveAttribute('data-terminal-phase', 'connected', { timeout: 15000 });
    await expect(panel.getByRole('status')).toHaveCount(0);
    await page.keyboard.type('echo "new-""shell"');
    await page.keyboard.press('Enter');
    await expect.poll(text).toMatch(/new-shell/);

    // A terminal is gone with the Host that ran it: its tab says so and starts another only when asked.
    await f.restart();
    await page.reload();
    await expect(panel).toHaveAttribute('data-terminal-phase', 'missing', { timeout: 15000 });
    await expect(panel.getByRole('status')).toHaveText('此终端已不存在，请新建终端。');
    expect(await terminals()).toEqual([]);

    // Closing the tab ends its shell: nothing is left running.
    await control('新建终端').click();
    await expect(panel).toHaveAttribute('data-terminal-phase', 'connected', { timeout: 15000 });
    await chipFor('终端').hover();
    await control('关闭：终端').click();
    await expect(chips).toHaveCount(1);
    await expect(chipFor('终端')).toHaveCount(0);
    await expect.poll(terminals).toEqual([]);
  }
  finally { process.env.SHELL = previous; await page.goto('about:blank').catch(() => { }); await f.close(); }
});

test('the terminal commands start only a shell the Host listed, within their bounds, and say what they refuse', async ({ page }) => {
  const f = await sessionHost();
  const started: string[] = [];
  try {
    const shells = await (await f.query('terminal.shells')).json() as { shells: { path: string; name: string }[]; default: string };
    expect(shells.shells.length).toBeGreaterThan(0);
    expect(shells.shells.map(shell => shell.path)).toContain('/bin/sh');
    expect(shells.shells.find(shell => shell.path === shells.default)).toBeDefined();
    // Every shell offered is an absolute path: none is a command or an argument.
    for (const shell of shells.shells) expect(shell.path).toMatch(/^\/[^ ]+$/);

    // Not a shell the Host listed — not a path, a command, or one with something after it.
    for (const shell of ['sh', '/bin/sh -c "echo pwned"', '/bin/definitely-not-a-shell', '/usr/bin/true']) {
      const refused = await command(f, 'terminal.create', { terminalId: crypto.randomUUID(), shell });
      expect(refused.status, shell).toBe(400);
      expect(refused.body.error?.code, shell).toBe('TERMINAL_SHELL_UNKNOWN');
    }
    expect((await command(f, 'terminal.create', { terminalId: 'not-a-uuid' })).body.error?.code).toBe('TERMINAL_INPUT_INVALID');

    // An unknown terminal is not found, for a read or a write.
    const unknown = crypto.randomUUID();
    const read = await fetch(`${f.host.url}/api/resources/terminal.output?terminalId=${unknown}`, { headers: { Cookie: f.cookie } });
    expect(read.status).toBe(404);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe('TERMINAL_NOT_FOUND');
    expect((await command(f, 'terminal.write', { terminalId: unknown, data: 'aGk=' })).body.error?.code).toBe('TERMINAL_NOT_FOUND');

    // A write carries at most the bytes a request can hold, and only base64.
    const mine = crypto.randomUUID(); started.push(mine);
    expect((await command(f, 'terminal.create', { terminalId: mine, shell: '/bin/sh', cols: 80, rows: 24 })).status).toBe(200);
    expect((await command(f, 'terminal.write', { terminalId: mine, data: Buffer.alloc(40 * 1024).toString('base64') })).body.error?.code).toBe('TERMINAL_INPUT_TOO_LARGE');
    expect((await command(f, 'terminal.write', { terminalId: mine, data: 'not base64!' })).body.error?.code).toBe('TERMINAL_INPUT_INVALID');
    expect((await command(f, 'terminal.resize', { terminalId: mine, cols: 5000, rows: 24 })).body.error?.code).toBe('TERMINAL_INPUT_INVALID');
    // The same terminal is not started twice while it runs.
    expect((await command(f, 'terminal.create', { terminalId: mine })).body.error?.code).toBe('TERMINAL_EXISTS');

    // At most a bounded number run at once; the next is refused until one is closed.
    for (let count = (await (await f.query('terminal.list')).json() as { terminals: unknown[] }).terminals.length; count < 8; count++) {
      const next = crypto.randomUUID(); started.push(next);
      expect((await command(f, 'terminal.create', { terminalId: next })).status).toBe(200);
    }
    const ninth = await command(f, 'terminal.create', { terminalId: crypto.randomUUID() });
    expect(ninth.status).toBe(409);
    expect(ninth.body.error?.code).toBe('TERMINAL_LIMIT');
    const closed = await command(f, 'terminal.close', { terminalId: mine });
    expect(closed.status).toBe(200);
    // A plain command answers with its result itself.
    expect(closed.body).toMatchObject({ terminalId: mine, confirmed: true });
    const after = crypto.randomUUID(); started.push(after);
    expect((await command(f, 'terminal.create', { terminalId: after })).status).toBe(200);
    // A terminal already gone is closed as far as its caller is concerned.
    expect((await command(f, 'terminal.close', { terminalId: mine })).body).toMatchObject({ terminalId: mine, confirmed: true });
  }
  finally {
    for (const id of started) await f.command('terminal.close', { terminalId: id }).catch(() => { });
    await page.goto('about:blank').catch(() => { }); await f.close();
  }
});
