#!/usr/bin/env bash
# Mac-side provisioning of the Linux validation guest.
#
# Builds the Debian/systemd image, runs it privileged (systemd needs
# cgroup v2 write access), maps only the Caddy HTTPS port onto the Mac's
# loopback, copies the current working tree in, and runs the in-guest
# setup. Safe to re-run; each stage is skipped when already done.
#
# Usage: bash deploy/linux/provision.sh   (from the repo root)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=aork-linux-systemd
CONTAINER=aork-linux
SRC=/opt/aork/src

log() { printf '[provision] %s\n' "$*"; }

command -v docker >/dev/null || { echo "docker CLI not found" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon not reachable (start Docker Desktop)" >&2; exit 1; }

cd "$REPO_ROOT"

# --- Build (or rebuild) the image --------------------------------------------
log "building image $IMAGE"
docker build -t "$IMAGE" -f deploy/linux/Dockerfile deploy/linux

# --- Run the privileged systemd container ------------------------------------
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  log "container $CONTAINER already exists (keeping it; data persists)"
else
  log "starting privileged systemd container"
  # --privileged: systemd needs cgroup v2 write access to manage unit
  # cgroups (service start/stop and control-group cleanup are exactly
  # what this environment must exercise). The cgroup namespace stays
  # private (Docker default on cgroup v2), so the guest systemd owns a
  # delegated subtree and unit paths read as /system.slice/<unit>.
  # Only Caddy's HTTPS port is mapped, and only onto the Mac's loopback.
  docker run -d --name "$CONTAINER" \
    --privileged \
    -p 127.0.0.1:8443:8443 \
    -v aork-linux-data:/var/lib/aork \
    "$IMAGE"
fi

# --- Wait for systemd ---------------------------------------------------------
log "waiting for systemd in the guest"
for _ in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  case "$state" in
    running|degraded) log "systemd is $state"; break ;;
    *) sleep 2 ;;
  esac
done
[ "${state:-}" = running ] || [ "${state:-}" = degraded ] || { echo "systemd did not come up (state: ${state:-none})" >&2; exit 1; }

# --- Copy the current working tree into the guest ------------------------------
log "copying working tree into $SRC (excluding node_modules/.git/dist)"
docker exec "$CONTAINER" mkdir -p "$SRC"
tar -C "$REPO_ROOT" \
  --exclude './node_modules' --exclude './.git' --exclude './dist' \
  --exclude './test-results' --exclude './.scratch' --exclude './.codex' \
  --exclude './apps/*/node_modules' --exclude './packages/*/node_modules' \
  --exclude './plugins/*/node_modules' \
  -cf - . | docker exec -i "$CONTAINER" tar -xf - -C "$SRC"

# --- Run the in-guest setup -----------------------------------------------------
log "running guest setup"
docker exec "$CONTAINER" bash "$SRC/deploy/linux/guest-setup.sh"

log "provisioning complete; validate with: bash deploy/linux/validate.sh"
