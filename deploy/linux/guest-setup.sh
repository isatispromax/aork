#!/usr/bin/env bash
# In-guest provisioning for the Aork Linux validation container.
# Idempotent: safe to re-run after `provision.sh` copies a fresh source tree.
#
# Expects the repo working tree (including deploy/) at /opt/aork/src.
set -euo pipefail
SRC=/opt/aork/src
DATA=/var/lib/aork
AGENT_DIR=/opt/aork/test-agent

log() { printf '[guest-setup] %s\n' "$*"; }

# --- Dedicated non-root service user ---------------------------------------
if ! id aork >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin aork
  log "created system user aork (no login shell)"
fi
install -d -o aork -g aork "$DATA"

# --- pnpm (image already pins it; keep the version visible) ----------------
pnpm --version

# --- Install workspace-locked dependencies and build in the guest ----------
# Native modules (better-sqlite3, fs-ext) are compiled/downloaded for THIS
# glibc/arm64 userspace; dist/server/main.mjs externalises them and Node
# resolves them from /opt/aork/src/node_modules at runtime.
cd "$SRC"
pnpm install --frozen-lockfile
pnpm build
log "built dist/server/main.mjs in the guest"

# --- Deploy the ACP test agent used by validation ---------------------------
install -d -o aork -g aork "$AGENT_DIR"
install -o aork -g aork -m 0755 "$SRC/deploy/linux/controlled-agent.mjs" "$AGENT_DIR/controlled-agent.mjs"

# --- Install units, start Caddy, then the Host ------------------------------
install -m 0644 "$SRC/deploy/linux/aork.service" /etc/systemd/system/aork.service
install -m 0644 "$SRC/deploy/linux/Caddyfile" /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/lib/caddy
systemctl daemon-reload
systemctl enable aork.service caddy.service >/dev/null
systemctl restart caddy.service

# --- Install the ACP test-agent provider via the public maintenance entry ---
# `plugin install` is the initial-deployment entry: it requires the Host not
# to have started on this data directory yet, so run it before the first
# start. Skip when the package is already on disk. (Do NOT probe with
# `profile show` here: opening storage would create the SQLite database and
# thereby turn a blank instance into an existing one.)
systemctl stop aork.service 2>/dev/null || true
if [ -d "$DATA/plugins/linux-test-agent" ]; then
  log "linux-test-agent already installed; skipping initial install"
else
  cd "$SRC"
  /usr/local/bin/node scripts/plugin-build.mjs --dir deploy/linux/test-agent-plugin --out /tmp/linux-test-agent.aork-plugin
  /usr/local/bin/node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("dist/profiles/personal-server.json"));p.plugins.push({id:"linux-test-agent",version:"0.1.0",enabled:true});fs.writeFileSync("/tmp/linux-agent-profile.json",JSON.stringify(p))'
  runuser -u aork -- /usr/local/bin/node "$SRC/dist/server/main.mjs" plugin install /tmp/linux-test-agent.aork-plugin \
    --data-dir "$DATA" --distribution-dir "$SRC/dist" --profile /tmp/linux-agent-profile.json
  log "installed linux-test-agent provider via the public initial-install entry"
fi
systemctl restart aork.service

# --- Trust Caddy's internal CA system-wide (guest-local clients only) -------
ROOT_CRT=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for _ in $(seq 1 30); do [ -f "$ROOT_CRT" ] && break; sleep 1; done
if [ -f "$ROOT_CRT" ]; then
  install -m 0644 "$ROOT_CRT" /usr/local/share/ca-certificates/aork-caddy-local-root.crt
  update-ca-certificates >/dev/null 2>&1 || true
  log "imported Caddy internal root CA into the guest trust store"
else
  log "WARN: Caddy root CA not found at $ROOT_CRT"
fi

systemctl --no-pager --lines=0 status aork.service caddy.service | sed -n '1,20p'
log "guest setup complete"
