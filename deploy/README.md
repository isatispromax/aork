# Aork deployment — Linux validation environment

Deployment assets for the workbench Host on a real glibc Linux host, per the
spec's 部署、凭据与维护 section: systemd manages the Host under a dedicated
non-root user, the Host listens only on the machine-local interface, and Caddy
is the sole public HTTPS/WSS entry.

Two levels are provided:

1. **Local container validation (validated, this machine):** a Debian 12
   systemd container running on this Mac under Docker Desktop, driven by the
   scripts in [`deploy/linux/`](./linux/). This is what ticket
   `19-linux-remote-deployment` validated on 2026-11-17.
2. **Production shape (documented, not yet validated):** a real Linux server
   with a public domain and a public CA. See *Retained blockers* below.

## Layout

```
deploy/linux/
  Dockerfile          Debian 12 + systemd + locked Node + toolchain + Caddy
  provision.sh        Mac-side: build image, run privileged container, copy tree, setup
  guest-setup.sh      In-guest: aork user, units, Caddyfile, pnpm install + build
  aork.service        systemd unit (non-root, KillMode=control-group, hardening)
  Caddyfile           HTTPS via Caddy internal CA, reverse_proxy to 127.0.0.1:6688
  controlled-agent.mjs        ACP test agent (standalone Node process)
  test-agent-plugin/          Provider plugin registering the agent (public install)
  command-check.mjs   Public-command flow driver (runs inside the guest)
  browser-check.mjs   Real-browser token login + WSS check (runs on the Mac)
  validate.sh         Full acceptance harness (runs the checks below)
```

## Running the local validation

Prereqs: Docker Desktop running; repo dependencies installed on the Mac
(`pnpm install`) for the browser check; Playwright Chromium available
(`pnpm exec playwright install chromium` if missing).

```bash
pnpm install                 # Mac side (for @playwright/test + dev tooling)
bash deploy/linux/provision.sh
bash deploy/linux/validate.sh
```

`provision.sh` is idempotent (reuses the container and the `aork-linux-data`
volume; re-copies the working tree and rebuilds). `validate.sh` creates a new
timestamped project/session per run, so it can be re-run freely. The Host's
data directory (`/var/lib/aork`, including SQLite, managed workspaces and
installed plugins) lives on the `aork-linux-data` Docker volume and survives
container recreation.

## Service architecture (validated shape)

- **aork.service** — `node dist/server/main.mjs serve` as system user `aork`
  (nologin shell), `--host 127.0.0.1 --port 6688`, data at `/var/lib/aork`,
  artifacts from the in-guest `pnpm build` at `/opt/aork/src/dist`
  (better-sqlite3 + fs-ext are compiled/installed against the guest glibc,
  resolved from `/opt/aork/src/node_modules`). `KillMode=control-group`,
  `ProtectSystem=strict` with only `/var/lib/aork` writable.
- **caddy.service** — official package unit; `/etc/caddy/Caddyfile` serves
  `https://localhost:8443` with `tls internal` and proxies to `127.0.0.1:6688`.
  Only this port is mapped, and only to the Mac's loopback
  (`-p 127.0.0.1:8443:8443`).
- The startup access link is read from the service's local output
  (`journalctl -u aork`, the `host.listening` line) — never from a public
  diagnostic surface.
- Guest-local clients trust Caddy's internal root CA via the system trust
  store (imported by `guest-setup.sh`). macOS-level keychain trust is NOT
  modified (would need admin rights); external chain verification on the Mac
  uses `curl --cacert` with the exported root certificate, and the browser
  check launches Chromium with certificate errors ignored.

## Validated environment matrix (2026-11-17)

| Component | Version (validated) |
| --- | --- |
| Host Mac | macOS 27.2.0 (darwin), Apple silicon (arm64) |
| Virtualization | Docker Desktop, client/engine 27.5.1 (LinuxKit VM, cgroup v2) |
| Guest OS | Debian 12.15, `linux/arm64` image, glibc 2.36-9+deb12u14 |
| Guest kernel | Linux 6.12.5-linuxkit #1 SMP aarch64 |
| systemd | 252 (252.39-1~deb12u2) |
| Node | v24.22.3 (official linux-arm64 tarball, SHA256-verified; V8 13.6.233.17-node.63, ABI/modules 137) |
| pnpm | 10.30.2 |
| better-sqlite3 | 12.6.2 — compiled in the guest (`build/Release/better_sqlite3.node`, node-gyp) |
| fs-ext | 2.1.1 — compiled in the guest (`build/Release/fs_ext.node`, node-gyp) |
| Caddy | v2.11.9 (official caddy-stable apt repository) |
| Chromium (browser check) | 145.0.7632.6 via the repo Playwright toolchain |

The authoritative record of the run (exact commands and observations) is in
the ticket comment for 2026-11-17; the table above summarises it.

## Production shape (not yet validated)

On a real server, replace the local-validation specifics:

- a real domain and a **public CA**: drop `tls internal` and let Caddy use
  ACME (automatic HTTPS), with ports 80/443 reachable from the internet;
- `--public-origin https://<real-domain>` in `aork.service`;
- provisioning without Docker (the `aork.service`/`Caddyfile` apply as-is);
- firewall posture: only 80/443 open; 6688 stays loopback.

## Retained blockers (recorded in the ticket, intentionally unresolved)

- Public-internet HTTPS with a real domain and a public CA (ACME issuance).
- Acceptance from a genuinely remote browser (not on the deploying machine).
- A production host outside this Mac (the container is a stand-in for it).
- Real Claude/Codex agents on Linux (separate tickets' scope).
