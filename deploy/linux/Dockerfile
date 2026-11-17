# Linux guest for validating the Aork workbench deployment on this Mac.
#
# Real glibc userspace (Debian 12) with systemd as PID 1 so service
# management and control-group cleanup behave like the production host.
# The image is built for the Docker default platform (linux/arm64 on this
# Apple-silicon Mac); the spec pins glibc, not a CPU architecture.
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

# systemd, toolchain for native Node modules (better-sqlite3, fs-ext),
# and observability tools (ss, pgrep, journalctl).
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv \
      build-essential python3 \
      ca-certificates curl xz-utils gnupg \
      procps iproute2 less \
    && rm -rf /var/lib/apt/lists/*

# Trim units that make no sense without a real console.
RUN find /lib/systemd/system/sysinit.target.wants -type l \
      ! -name systemd-tmpfiles-setup.service -delete || true; \
    rm -f /lib/systemd/system/multi-user.target.wants/getty.target \
          /lib/systemd/system/multi-user.target.wants/getty@.service || true; \
    systemctl set-default multi-user.target

# Node pinned to the locked runtime version, checksum-verified from the
# official SHASUMS256.txt (arch detected from the image platform).
# NOTE: shell variables are \$-escaped because BuildKit substitutes
# unescaped ${...} against ARG/ENV (undefined ones become empty).
ARG NODE_VERSION=24.22.3
RUN arch="$(dpkg --print-architecture)" \
    && tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    && curl -fsSLo "/tmp/${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" \
    && echo "$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}\$" | cut -d' ' -f1)  /tmp/${tarball}" > /tmp/node.sha256 \
    && (cd /tmp && sha256sum -c node.sha256) \
    && tar -xJf "/tmp/${tarball}" -C /usr/local --strip-components=1 \
    && rm -f "/tmp/${tarball}" /tmp/node.sha256 \
    && node --version

# pnpm pinned to the version recorded in the root package.json.
RUN npm install -g pnpm@10.30.2 && pnpm --version

# Caddy from the official stable apt repository (provides its own
# non-root systemd unit). The exact installed version is recorded by
# deploy/linux/validate.sh into the ticket/deploy notes.
RUN set -eu; \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends caddy; \
    rm -rf /var/lib/apt/lists/*

# NOTE: source, build artifacts and deploy scripts are copied in at
# provision time (deploy/linux/provision.sh), so the image itself stays
# reusable across rebuilds of the workbench.

CMD ["/sbin/init"]
