#!/usr/bin/env bash
# Linux deployment validation for the Aork workbench (ticket 19).
#
# Validates, against the real guest-built artifacts in the container:
#   1. environment/version record (guest OS, kernel, arch, systemd, node,
#      pnpm, caddy, native module builds)
#   2. systemd service lifecycle (start/stop/restart, non-root user)
#   3. network posture: Host bound to 127.0.0.1 only, Caddy the sole
#      public entry, mapped port reachable only on the Mac loopback
#   4. Caddy HTTPS with the internal CA (chain verified with curl/openssl)
#   5. Token-link login from an external client (curl on the Mac)
#   6. plugin install through the public maintenance entry (test agent)
#   7. public command flow incl. managed ACP process start/stop and its
#      cgroup membership
#   8. data persistence across service restart
#   9. control-group cleanup on service stop (agent processes reaped)
#  10. real browser (Chromium on the Mac) token login + WSS updates
#
# Usage: bash deploy/linux/validate.sh     (from the repo root, after provision.sh)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CONTAINER=aork-linux
SRC=/opt/aork/src
GUEST_NODE=/usr/local/bin/node
WORK=/tmp/aork-linux-validation

log() { printf '\n[validate] %s\n' "$*"; }
pass() { printf '[validate]   PASS %s\n' "$*"; }
run_in_guest() { docker exec "$CONTAINER" bash -c "$*"; }
# The startup access link only ever comes from the service's local output.
# Filter by the CURRENT main PID so a just-restarted unit cannot serve a
# previous process' (rotated) token, and poll: Type=exec reports active
# before the Host prints its host.listening line.
access_url() {
  local url pid
  for _ in $(seq 1 30); do
    pid=$(run_in_guest 'systemctl show -p MainPID --value aork')
    url=$(run_in_guest "journalctl -u aork _PID=$pid --no-pager 2>/dev/null | grep -o '\"accessUrl\":\"[^\"]*\"' | tail -1 | cut -d'\"' -f4")
    if [ -n "$url" ] && [ "$pid" != 0 ]; then printf '%s' "$url"; return 0; fi
    sleep 1
  done
  return 1
}

command -v docker >/dev/null || { echo "docker CLI not found" >&2; exit 1; }
mkdir -p "$WORK"

# --- 1. Environment record ----------------------------------------------------
log "1. environment record"
run_in_guest "uname --kernel-name --kernel-release --machine; cat /etc/debian_version; systemd --version | head -1; node --version; pnpm --version; caddy version" | tee "$WORK/versions.txt"
run_in_guest "cat $SRC/dist/compatibility.json" > "$WORK/compatibility.json"
run_in_guest "$GUEST_NODE -e 'const s=require(\"$SRC/node_modules/better-sqlite3\");const f=require(\"$SRC/node_modules/fs-ext\");console.log(JSON.stringify({better_sqlite3:\"loads\",fs_ext:\"loads\",sqlite_runtime:s.version,abi:process.versions.modules}))'"
pass "guest toolchain + native modules recorded"

# --- 2. systemd lifecycle -----------------------------------------------------
log "2. systemd lifecycle"
[ "$(run_in_guest 'systemctl is-active aork')" = active ] || { echo "aork not active" >&2; exit 1; }
[ "$(run_in_guest 'systemctl is-active caddy')" = active ] || { echo "caddy not active" >&2; exit 1; }
run_in_guest "systemctl restart aork"
for _ in $(seq 1 60); do [ "$(run_in_guest 'systemctl is-active aork')" = active ] && break; sleep 1; done
[ "$(run_in_guest 'systemctl is-active aork')" = active ] || { echo "aork did not restart" >&2; exit 1; }
host_pid=$(run_in_guest "pgrep -f 'dist/server/main.mjs serve' | head -1")
[ "$(run_in_guest "ps -o user= -p $host_pid" | tr -d ' ')" = aork ] || { echo "Host process not running as aork" >&2; exit 1; }
[ "$(run_in_guest 'systemctl show -p KillMode --value aork')" = control-group ] || { echo "KillMode not control-group" >&2; exit 1; }
pass "restart via systemd ok; Host runs as dedicated non-root user 'aork'; KillMode=control-group"

# --- 3. Network posture -------------------------------------------------------
log "3. network posture (Host on machine-local interface only)"
run_in_guest "ss --listening --tcp --numeric --processes | grep -E ':(6688|8443)\b'" | tee "$WORK/listeners.txt"
[ "$(grep -c '127.0.0.1:6688' "$WORK/listeners.txt")" -ge 1 ] || { echo "Host not listening on 127.0.0.1:6688" >&2; exit 1; }
if grep -E ':(6688)\b' "$WORK/listeners.txt" | grep -vq '127.0.0.1:6688'; then echo "Host port 6688 bound on a non-loopback interface" >&2; exit 1; fi
if curl --noproxy '*' -sS -m 2 -o /dev/null http://127.0.0.1:6688/ 2>"$WORK/direct.err"; then echo "Host 6688 reachable from the Mac; must not be exposed" >&2; exit 1; fi
pass "Host bound to 127.0.0.1:6688 only; not reachable from the Mac; Caddy 8443 is the sole mapped entry"

# --- 4. Caddy HTTPS with internal CA ------------------------------------------
log "4. Caddy TLS (internal CA)"
docker cp "$CONTAINER":/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt" >/dev/null
curl --noproxy '*' --cacert "$WORK/caddy-root.crt" -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://localhost:8443/ | tee "$WORK/tls.txt"
[ "$(cut -d' ' -f1 "$WORK/tls.txt")" != 000 ] || { echo "TLS connection failed" >&2; exit 1; }
[ "$(cut -d' ' -f2 "$WORK/tls.txt")" = 0 ] || { echo "certificate chain did not verify against Caddy root CA" >&2; exit 1; }
echo | openssl s_client -connect localhost:8443 -servername localhost -CAfile "$WORK/caddy-root.crt" 2>/dev/null | grep -E 'subject=|issuer=|Verify return code' | tee "$WORK/chain.txt"
grep -q 'Verify return code: 0 (ok)' "$WORK/chain.txt" || { echo "openssl chain verification failed" >&2; exit 1; }
pass "internal-CA chain verifies; served for CN=localhost"

# --- 5. External token exchange (Mac curl through the proxy) -------------------
log "5. token-link exchange from an external client"
TOKEN_URL=$(access_url)
[ -n "$TOKEN_URL" ] || { echo "no accessUrl in service journal" >&2; exit 1; }
curl --noproxy '*' --cacert "$WORK/caddy-root.crt" -sS -D "$WORK/headers.txt" -o /dev/null --max-redirs 0 "$TOKEN_URL"
grep -qiE '^HTTP/[0-9.]+ 303' "$WORK/headers.txt" || { echo "expected 303 clearing the URL token" >&2; exit 1; }
grep -qi '^set-cookie: __Host-aork_session-.*HttpOnly.*SameSite=Strict.*Secure' "$WORK/headers.txt" || { echo "signed Secure cookie not issued" >&2; cat "$WORK/headers.txt"; exit 1; }
pass "303 token exchange issued __Host-aork_session cookie (HttpOnly, SameSite=Strict, Secure)"

# --- 6. ACP test agent installed via the public maintenance entry -------------
log "6. ACP test agent installed via the public maintenance entry (guest-setup)"
run_in_guest "systemctl stop aork"
INSTALLED=$(run_in_guest "runuser -u aork -- $GUEST_NODE $SRC/dist/server/main.mjs profile show --data-dir /var/lib/aork --distribution-dir $SRC/dist | grep -c 'linux-test-agent' || true")
run_in_guest "systemctl start aork"
for _ in $(seq 1 60); do [ "$(run_in_guest 'systemctl is-active aork')" = active ] && break; sleep 1; done
[ "$(run_in_guest 'systemctl is-active aork')" = active ] || { echo "aork did not restart" >&2; exit 1; }
[ "$INSTALLED" -ge 1 ] || { echo "linux-test-agent not present in the applied profile (run provision.sh once with a blank data volume)" >&2; exit 1; }
pass "linux-test-agent provider present via 'aork plugin install' (initial-deployment maintenance entry)"

# --- 7. Public command flow + managed ACP process -----------------------------
log "7. public commands: Session/Run lifecycle and managed ACP process"
TOKEN_URL=$(access_url)
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs setup '$TOKEN_URL'"
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs open" | tee "$WORK/open.json"
for _ in $(seq 1 50); do AGENT_PIDS=$(run_in_guest "pgrep -f 'controlled-agen[t].mjs' | tr '\n' ' ' || true"); [ -n "$AGENT_PIDS" ] && break; sleep 1; done
[ -n "$AGENT_PIDS" ] || { echo "managed ACP agent process did not start" >&2; exit 1; }
run_in_guest "for pid in $AGENT_PIDS; do echo \"pid \$pid cgroup \$(cat /proc/\$pid/cgroup | tr '\n' ' ')\"; done" | tee "$WORK/agent-cgroup.txt"
grep -q 'aork.service' "$WORK/agent-cgroup.txt" || { echo "ACP agent process not in the aork.service control group" >&2; exit 1; }
pass "sessions.startRun spawned the ACP agent inside the aork.service control group"
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs complete" | tee "$WORK/complete.json"
for _ in $(seq 1 50); do LEFT=$(run_in_guest "pgrep -f 'controlled-agen[t].mjs' | head -1 || true"); [ -z "$LEFT" ] && break; sleep 1; done
[ -z "$LEFT" ] || { echo "ACP agent still running after endRun: $LEFT" >&2; exit 1; }
run_in_guest "find /var/lib/aork/workspaces -name negotiated-wire | head -n 3 | xargs -r tail -n 2" | tee "$WORK/wire.txt"
grep -q 'session/prompt' "$WORK/wire.txt" || { echo "agent wire log shows no session/prompt" >&2; exit 1; }
pass "sendText reached the agent (wire log), turn completed, endRun stopped the managed process"

# --- 8. Data persistence across service restart --------------------------------
log "8. data persistence across restart"
BEFORE=$(run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs overview")
run_in_guest "systemctl restart aork"
for _ in $(seq 1 60); do [ "$(run_in_guest 'systemctl is-active aork')" = active ] && break; sleep 1; done
TOKEN_URL=$(access_url)
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs query '$TOKEN_URL'" | tee "$WORK/query.json"
SESSION_ID=$(run_in_guest "$GUEST_NODE -e 'console.log(JSON.parse(require(\"fs\").readFileSync(\"/tmp/aork-command-state.json\")).sessionId)'")
AFTER=$(run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs overview")
grep -q "$SESSION_ID" <<<"$AFTER" || { echo "session $SESSION_ID missing after restart" >&2; exit 1; }
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE -e 'const s=JSON.parse(require(\"fs\").readFileSync(\"/tmp/aork-command-state.json\"));fetch(\"https://localhost:8443/api/resources/sessions.timeline?sessionId=\"+s.sessionId,{headers:{Cookie:s.cookie}}).then(r=>r.json()).then(t=>{const turn=t.turns.at(-1);if(turn?.state!==\"completed\")throw new Error(\"last turn not completed after restart: \"+JSON.stringify(turn).slice(0,200));console.log(\"timeline turn after restart:\",turn.state)})'"
pass "prior Session and completed Turn remain queryable after systemctl restart (fresh startup Token required)"

# --- 9. Control-group cleanup on service stop ----------------------------------
log "9. control-group cleanup (spec: service stop reaps the whole cgroup)"
run_in_guest "runuser -u aork -- env NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aork-caddy-local-root.crt $GUEST_NODE $SRC/deploy/linux/command-check.mjs open" >/dev/null
for _ in $(seq 1 50); do AGENT_PIDS=$(run_in_guest "pgrep -f 'controlled-agen[t].mjs' | tr '\n' ' ' || true"); [ -n "$AGENT_PIDS" ] && break; sleep 1; done
[ -n "$AGENT_PIDS" ] || { echo "agent process did not start for cgroup test" >&2; exit 1; }
HOST_PID=$(run_in_guest "pgrep -f 'dist/server/main.mjs serve' | head -1")
run_in_guest "systemctl stop aork"
for _ in $(seq 1 60); do [ "$(run_in_guest 'systemctl is-active aork')" = inactive ] && break; sleep 1; done
LEFT=$(run_in_guest "pgrep -f 'controlled-agen[t].mjs' | head -1 || true")
[ -z "$LEFT" ] || { echo "agent processes survived service stop: $LEFT" >&2; exit 1; }
run_in_guest "ps -p $HOST_PID >/dev/null 2>&1" && { echo "Host process survived service stop" >&2; exit 1; } || true
run_in_guest "systemctl status aork --no-pager | tail -3" | tee "$WORK/stop-status.txt" || true
pass "systemctl stop reaped Host + managed agent processes via the control group"
run_in_guest "systemctl start aork"
for _ in $(seq 1 60); do [ "$(run_in_guest 'systemctl is-active aork')" = active ] && break; sleep 1; done

# --- 10. Real browser on the Mac -------------------------------------------------
log "10. real browser (Chromium on macOS): token login + WSS through the mapped port"
TOKEN_URL=$(access_url)
( cd "$REPO_ROOT" && node deploy/linux/browser-check.mjs "$TOKEN_URL" ) | tee "$WORK/browser.json"
pass "browser completed token login, rendered the workbench and received WSS events"

log "ALL CHECKS PASSED"
printf 'summary: %s\n' "$(cat "$WORK/browser.json")"
