# 19: 在 Linux 上运行远程工作台

**What to build:** 在选定 Linux glibc 主机部署可登录、可连接测试 Agent 的工作台，并验证服务启停与进程清理。

**Blocked by:** 14: 浏览器断线后的状态恢复

**Status:** claimed

- [ ] 使用既定 Node、原生数据库依赖、systemd、专用非 root 用户和 Caddy HTTPS，记录精确环境版本与可重复部署步骤。
- [ ] Host 仅监听本机接口，数据库、Unix socket 和 Agent stdio 不暴露公网；真实浏览器完成登录和 WSS 更新。
- [ ] 数据与配置持久化，服务重启后可查既有记录；不把开发机启动当 Linux 验收。
- [ ] 实际验证服务级控制组清理，单 Run 仍遵循未知进程保留 blocked 的边界，不承诺独立容器隔离。
- [ ] 在目标主机跑公开命令、浏览器和受管 ACP 测试进程的启停；缺少主机访问时记录实际阻塞，不能标完成。

规格用户故事：1, 2, 66, 71, 72。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 18 顺延为 19；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-17：开始本票。按用户当日决定采用“本机容器/VM 验证”范围：在本 Mac 上以真实 glibc Linux + systemd 容器验证部署、服务管理与进程清理；公网 HTTPS（真实域名 + 公共 CA）与真实远程浏览器验收保留为 blocked，不伪造、不解锁。开始实施部署资产与验证脚本。

- 2026-11-17：本机容器验证完成，`deploy/linux/validate.sh` 十项全部 PASS（脚本可重复执行，已连续两轮全绿）。部署资产已提交于 `deploy/`：`Dockerfile`（Debian 12 + systemd 252 + 校验和固定的 Node 24.22.3 + 工具链 + Caddy 官方 apt 源）、`provision.sh`（Mac 侧编排，幂等：复用容器与 `aork-linux-data` 卷）、`guest-setup.sh`（容器内：专用非 root 用户 `aork`、单元安装、在 guest 内 `pnpm install --frozen-lockfile && pnpm build`、经公开初始安装入口安装 ACP 测试 Provider）、`aork.service`（`User=aork`、`KillMode=control-group`、`ProtectSystem=strict` 仅放开 `/var/lib/aork`、Host 仅 `--host 127.0.0.1 --port 6688`）、`Caddyfile`（`tls internal` 内部 CA，`https://localhost:8443` 反代 127.0.0.1:6688）、`controlled-agent.mjs` + `test-agent-plugin/`（受管 ACP 测试进程及其 Provider 插件）、`command-check.mjs`（公开命令流）、`browser-check.mjs`（Mac 侧真实 Chromium）、`validate.sh`（验收装置）、`deploy/README.md`（版本化环境文档）。

  实际验证（`bash deploy/linux/validate.sh`，逐项观察）：1) 环境与原生依赖记录：guest 内 `uname -a`、`ldd --version`、node/pnpm/caddy 版本、`dist/compatibility.json`，`require('better-sqlite3')/require('fs-ext')` 加载成功；2) systemd 生命周期：`systemctl restart aork` 正常，Host 进程以 `aork` 用户运行（`ps -o user=`），`systemctl show -p KillMode` = control-group；3) 网络姿态：guest `ss -tlnp` 显示 Host 仅监听 `127.0.0.1:6688`，Mac 侧 6688 不可达（连接被拒），仅 Caddy 8443 映射到 Mac 回环；4) Caddy 内部 CA：Mac 侧 `curl --cacert <导出的 root.crt>` 与 `openssl s_client` 链校验 `Verify return code: 0 (ok)`，未认证请求 401；5) 外部 Token 交换：curl 打开 journalctl 中的 accessUrl 得 `HTTP/2 303` + `Set-Cookie: __Host-aork_session-…; HttpOnly; SameSite=Strict; Secure`；6) `aork plugin install`（初始部署维护入口，显式 profile）安装 linux-test-agent Provider（服务停止时执行，Host 首次启动前；注意 `profile show` 探测会在空实例上创建 SQLite 而触发 FRESH_INSTANCE_REQUIRED，脚本改用文件系统存在性判断）；7) 公开命令流：`workspace.createProject`→`agents.createProfile`(linux.test)→`sessions.create`→`sessions.startRun` 后受管 ACP 进程出现且 `/proc/<pid>/cgroup` 为 `0::/system.slice/aork.service`，`sessions.sendText` 后 workspace 的 `negotiated-wire` 记录到 `session/prompt`、Turn completed，`sessions.endRun` 后进程退出；8) 持久化：`systemctl restart aork` 后需新启动 Token，旧 Session 与已完成 Turn 仍可查询（`sessions.overview` + `sessions.timeline` 资源，turn state=completed）；9) 控制组清理：Run 存活（agent 进程在单元 cgroup 内）时 `systemctl stop aork`，Host 与受管 agent 进程全部被回收（pgrep 为空、journal `Deactivated successfully`）；10) Mac 上的真实浏览器（Playwright Chromium 145.0.7632.6）：打开 journal 中的 Token 链接后 URL Token 被 303 清除、`__Host-aork_session` Cookie（HttpOnly/SameSite=Strict/Secure）建立、工作台渲染，页面内建立 `wss://localhost:8443/api/events?...` 事件流（按协议 ACK），页面内公开命令 `workbench.savePreferences` 触发的 `workbench.preferencesChanged` 事件经 WSS 送达（游标推进至 88）。

  版本矩阵（2026-11-17 实测）：宿主 macOS 27.2.0 (darwin, arm64)；Docker Desktop client/engine 27.5.1（LinuxKit VM，cgroup v2）；guest Debian 12.15 linux/arm64，glibc 2.36-9+deb12u14，内核 Linux 6.12.5-linuxkit aarch64；systemd 252 (252.39-1~deb12u2)；Node v24.22.3（官方 linux-arm64 tarball，SHASUMS256 校验；ABI 137）；pnpm 10.30.2；better-sqlite3 12.6.2 与 fs-ext 2.1.1（均在 guest 内 node-gyp 编译，`build/Release/*.node` 存在并被 Host 加载）；Caddy v2.11.9。架构说明：规格锁定 glibc 而非 x86_64，本次在 arm64 glibc 验证，x86_64 生产主机未验。

  Mac 侧开发流检查：`pnpm build`、`pnpm typecheck` 通过（Node 24.22.3）。`pnpm test` 在本机当前高负载（load average ≈40，8 核）下出现 15s 超时类失败且逐轮数量浮动（44/11/27），同一基线 commit cd25ca8 在未含本票改动的工程仓同样失败（14 个），判定为机器负载抖动而非本票回归；抽查失败文件单独运行全部通过（auth 9/9、agent-profiles+turn-streaming 30/30）。本票改动仅新增 `deploy/` 文件，未触碰产品代码。

  保留 blockers（未伪造、不解锁）：公网 HTTPS（真实域名 + 公共 CA/ACME）；真实远程浏览器（非部署本机）验收；本 Mac 之外的生产主机（容器是替代物）；真实 Claude/Codex 在 Linux 的接入（后续票范围）。故本票维持 `claimed`，不标 resolved。
