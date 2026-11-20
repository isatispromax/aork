#!/usr/bin/env node
// Public-command flow driver for the Linux deployment validation (ticket 19).
// Runs INSIDE the Linux guest (the Caddy internal root CA is imported into
// the guest trust store by guest-setup.sh), speaking only the public
// HTTPS surface at https://localhost:8443 exactly like an outside client.
//
// Modes (state persists in /tmp/aork-command-state.json so steps can be
// interleaved with systemd/process observation from the shell):
//   setup <accessUrl>    exchange the startup Token for a signed Cookie
//   open                 create Project + Agent profile + Session, start Run,
//                        wait until ready (managed ACP process is running)
//   complete             send a prompt, wait for the completed Turn, end Run
//   query <accessUrl>    exchange a fresh Token (e.g. after service restart)
//                        and verify prior data is still queryable
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://localhost:8443';
const STATE_FILE = '/tmp/aork-command-state.json';
const [mode, accessUrl] = process.argv.slice(2, 4);
if (!mode || (['setup', 'query'].includes(mode) && !accessUrl)) {
  console.error('Usage: command-check.mjs <setup|open|complete|query> [accessUrl]');
  process.exit(2);
}

const state = mode === 'setup' ? {} : JSON.parse(await readFile(STATE_FILE, 'utf8'));
const save = () => writeFile(STATE_FILE, JSON.stringify(state));
const out = value => console.log(JSON.stringify(value));

async function exchange(url) {
  const response = await fetch(url, { redirect: 'manual' });
  const [cookie] = response.headers.getSetCookie() ?? [];
  if (response.status !== 303 || !cookie) throw new Error(`token exchange failed: ${response.status} ${JSON.stringify(response.headers.getSetCookie())}`);
  const location = response.headers.get('location');
  if (!['/', '', './'].includes(location)) throw new Error(`unexpected redirect target: ${location}`);
  return cookie.split(';')[0];
}

async function bootstrap(cookie) {
  const response = await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: cookie } });
  if (response.status !== 200) throw new Error(`bootstrap failed: ${response.status}`);
  return response.json();
}

async function command(cookie, csrf, graph, name, payload) {
  const response = await fetch(`${BASE}/api/commands/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: cookie, 'X-Aork-CSRF': csrf },
    body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: graph, payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) throw new Error(`command ${name} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function overview(cookie) {
  const response = await fetch(`${BASE}/api/queries/sessions.overview`, { headers: { Cookie: cookie } });
  if (response.status !== 200) throw new Error(`overview failed: ${response.status}`);
  return response.json();
}

async function waitFor(cookie, accept, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await overview(cookie);
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(value).slice(0, 400)}`);
}
// Earlier validation runs leave older sessions first in the overview; always
// observe the session this run created, not whatever is listed first.
const own = (value, id) => value.sessions.find(entry => entry.session.id === id);

if (mode === 'setup' || mode === 'query') {
  state.cookie = await exchange(accessUrl);
  const info = await bootstrap(state.cookie);
  if (info.access.state !== 'authenticated') throw new Error(`not authenticated after exchange: ${JSON.stringify(info.access)}`);
  state.csrf = info.access.csrfToken;
  state.graph = info.pluginGraphHash;
  state.epoch = info.hostEpoch;
  await save();
  out({ mode, authenticated: true, epoch: info.hostEpoch, plugins: info.plugins.length, cookieName: state.cookie.split('=')[0] });
} else if (mode === 'open') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const project = (await command(state.cookie, state.csrf, state.graph, 'workspace.createProject', { name: `Linux validation ${stamp}`, workspace: { name: 'validation', management: 'managed' } })).result;
  const profile = (await command(state.cookie, state.csrf, state.graph, 'agents.createProfile', { name: 'Linux validation agent profile', providerId: 'linux.test', parameters: { model: 'linux-validation-model' }, versionRequirement: '^1.0.0', authentication: 'none' })).result;
  const session = (await command(state.cookie, state.csrf, state.graph, 'sessions.create', { name: 'Linux validation session', projectId: project.project.id, workspaceId: project.workspace.id, profileId: profile.id })).result;
  await command(state.cookie, state.csrf, state.graph, 'sessions.startRun', { sessionId: session.id });
  const ready = await waitFor(state.cookie, value => own(value, session.id)?.execution.state === 'ready', 'run ready');
  state.sessionId = session.id;
  state.runId = own(ready, session.id).execution.runId;
  state.workspaceDirectory = project.workspace.directory;
  await save();
  out({ mode, sessionId: session.id, runId: state.runId, execution: own(ready, session.id).execution.state, workspaceDirectory: project.workspace.directory });
} else if (mode === 'complete') {
  const receipt = await command(state.cookie, state.csrf, state.graph, 'sessions.sendText', { sessionId: state.sessionId, text: 'linux deployment validation prompt' });
  await waitFor(state.cookie, value => own(value, state.sessionId)?.currentTurn?.state === 'completed', 'turn completed', 60000);
  await command(state.cookie, state.csrf, state.graph, 'sessions.endRun', { runId: state.runId });
  await waitFor(state.cookie, value => ['stopped', 'terminated'].includes(own(value, state.sessionId)?.execution.state), 'run stopped', 60000);
  const timeline = await (await fetch(`${BASE}/api/resources/sessions.timeline?sessionId=${state.sessionId}`, { headers: { Cookie: state.cookie } })).json();
  const turn = timeline.turns.at(-1);
  out({ mode, acceptedTurn: receipt.result.state ?? 'accepted', turnState: turn?.state, replySummary: JSON.stringify(turn?.reply ?? turn ?? {}).slice(0, 300) });
} else if (mode === 'overview') {
  const value = await overview(state.cookie);
  out({ mode, sessions: value.sessions.map(entry => ({ id: entry.session.id, execution: entry.execution?.state })) });
} else throw new Error(`unknown mode ${mode}`);
