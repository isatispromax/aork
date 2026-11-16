# Dependency advisory remediation — 2026-11-16

Scope: compatible dependency updates on accepted Host/workbench baseline `91a74f6` (including Tickets 01–18 and 22 core). Production source for the product API, authentication, persistence, Query/snapshot, Workspace Claim and external delivery remains unchanged. This is supplementary remediation within the implementation, not another product ticket or full-product acceptance.

## Inventory and selection

Official npm registry metadata and maintainer release notes were checked on 2026-11-16. Every direct declaration of Zod and Drizzle is aligned. The runtime keeps Node **24.22.3**, pnpm **10.30.2**, and ACP SDK **2.7.0**. Existing `ws@8.23.0` is retained. No audit exclusions, forced fixes, overrides, or added direct transitive dependencies are used.

| Package | Previous direct pin | Selected exact pin | Purpose / compatibility evidence |
| --- | --- | --- | --- |
| fastify | 5.7.4 | [5.12.8](https://github.com/fastify/fastify/releases/tag/v5.12.8) | Host HTTP; stays on Fastify 5. |
| ajv | 8.17.1 | [8.20.0](https://github.com/ajv-validator/ajv/releases/tag/v8.20.0) | Synchronous plugin configuration validation; stays on Ajv 8. Release explicitly adds Node 24 support. |
| drizzle-orm | 0.45.1 | [0.45.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.4) | Host and plugin SQLite repositories; stays on stable 0.45. better-sqlite3 peer remains >=7. |
| zod | 4.3.6 | [4.6.7](https://github.com/colinhacks/zod/releases/tag/v4.6.7) | Host, SDK, contracts and plugins; stays on Zod 4. |
| vite | 7.3.1 | [7.3.8](https://github.com/vitejs/vite/releases/tag/v7.3.8) | Build tooling; stays on Vite 7. Node ^20.19 or >=22.12. Vite 7.3.6+ allows esbuild 0.28. |
| vitest | 4.0.18 | [4.1.12](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12) | Test tooling; stays on Vitest 4 despite latest major 5. Node ^20 / ^22 / >=24 and Vite ^6 / ^7 / ^8. |
| esbuild | 0.27.3 | [0.28.2](https://github.com/evanw/esbuild/releases/tag/v0.28.2) | Host/plugin/shared browser bundles; patched 0.28 line required by advisory. Node >=18; existing build API is retained. |

The lockfile naturally updates the matching Vitest 4.1.12 packages, its declared `es-module-lexer` 2 / `std-env` 4 dependencies, Fastify's declared `fast-json-stringify` 7, and esbuild platform binaries. Vite resolves the same patched esbuild 0.28.2. Existing unrelated pins remain unchanged. No Query-core package is present in this accepted baseline's manifests or lockfile; its public Query/snapshot implementation remains unchanged.

## Audit result

The configured mirror does not implement the audit API. Both read-only scans used `pnpm audit --json --registry https://registry.npmjs.org`. Full responses are retained at `/tmp/aork-dependency-audit-before.json` and `/tmp/aork-dependency-audit-after.json`; registry selection metadata is at `/tmp/aork-dependency-registry-research.json`.

| Scan | Advisory records | Critical | High | Moderate | Low | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Accepted baseline, before edits | 27 | 1 | 10 | 14 | 2 | 1 |
| Updated frozen dependency graph | 0 | 0 | 0 | 0 | 0 | 0 |

The earlier Ticket 15 scan had 29 records; its two ws findings were already removed by the separately accepted ws update. Advisory records can overlap packages and conditions; they are not a count of demonstrated Aork exploits. The following exact before-scan inventory is cleared in the after scan.

| Package | Before-scan severity | Advisory | Affected range | Fixed range | Selected |
| --- | --- | --- | --- | --- | --- |
| @vitest/mocker | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | `>=2.1.0 <4.1.11` | `>=4.1.11` | 4.1.12 |
| @vitest/mocker | moderate | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) | `>=2.1.0-beta.7 <4.1.12` | `>=4.1.12` | 4.1.12 |
| ajv | moderate | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | `>=7.0.0-alpha.0 <8.18.0` | `>=8.18.0` | 8.20.0 |
| drizzle-orm | high | [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | `<0.45.2` | `>=0.45.2` | 0.45.4 |
| esbuild | low | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | `>=0.27.3 <0.28.1` | `>=0.28.1` | 0.28.2 |
| fastify | high | [GHSA-247c-9743-5963](https://github.com/advisories/GHSA-247c-9743-5963) | `>=5.3.2 <=5.8.4` | `>=5.8.5` | 5.12.8 |
| fastify | moderate | [GHSA-444r-cwp2-x5xf](https://github.com/advisories/GHSA-444r-cwp2-x5xf) | `<=5.8.2` | `>=5.8.3` | 5.12.8 |
| fastify | moderate | [GHSA-4mh8-r7rc-xpvc](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc) | `<5.12.5` | `>=5.12.5` | 5.12.8 |
| fastify | moderate | [GHSA-573f-x89g-hqp9](https://github.com/advisories/GHSA-573f-x89g-hqp9) | `>=5.7.2 <=5.8.0` | `>=5.8.1` | 5.12.8 |
| fastify | high | [GHSA-667r-xxjv-c9mm](https://github.com/advisories/GHSA-667r-xxjv-c9mm) | `<5.12.2` | `>=5.12.2` | 5.12.8 |
| fastify | high | [GHSA-9q9j-q6p8-xq58](https://github.com/advisories/GHSA-9q9j-q6p8-xq58) | `<5.12.2` | `>=5.12.2` | 5.12.8 |
| fastify | high | [GHSA-hwr6-493r-vm6h](https://github.com/advisories/GHSA-hwr6-493r-vm6h) | `<5.12.2` | `>=5.12.2` | 5.12.8 |
| fastify | high | [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7) | `>=4.0.0 <5.12.2` | `>=5.12.2` | 5.12.8 |
| fastify | moderate | [GHSA-w2qp-rph6-63g4](https://github.com/advisories/GHSA-w2qp-rph6-63g4) | `<5.12.1` | `>=5.12.1` | 5.12.8 |
| vite | moderate | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | `>=7.0.0 <=7.3.1` | `>=7.3.2` | 7.3.8 |
| vite | high | [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | `>=7.0.0 <=7.3.6` | `>=7.3.7` | 7.3.8 |
| vite | moderate | [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) | `>=7.0.0 <=7.3.6` | `>=7.3.7` | 7.3.8 |
| vite | low | [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | `>=7.0.0 <=7.3.6` | `>=7.3.7` | 7.3.8 |
| vite | moderate | [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | `>=7.0.0 <=7.3.4` | `>=7.3.5` | 7.3.8 |
| vite | high | [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583) | `>=7.0.0 <=7.3.1` | `>=7.3.2` | 7.3.8 |
| vite | moderate | [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) | `>=7.0.0 <=7.3.6` | `>=7.3.7` | 7.3.8 |
| vite | moderate | [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) | `>=7.0.0 <=7.3.6` | `>=7.3.7` | 7.3.8 |
| vite | high | [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r) | `>=7.1.0 <=7.3.1` | `>=7.3.2` | 7.3.8 |
| vite | moderate | [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) | `>=7.0.0 <=7.3.4` | `>=7.3.5` | 7.3.8 |
| vitest | critical | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | `>=4.0.0 <4.1.0` | `>=4.1.0` | 4.1.12 |
| vitest | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | `>=2.1.0 <4.1.11` | `>=4.1.11` | 4.1.12 |
| zod | high | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `<4.6.6` | `>=4.6.6` | 4.6.7 |

## Exposure and verification limits

Fastify, Ajv, Drizzle and Zod are used by the Host or its trusted plugins. The inspected transport requires authenticated identity, exact Origin and CSRF for commands; the upgrade does not substitute for those checks. The [malformed-URL Fastify advisory](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7) depends on encapsulated not-found/lifecycle conditions; no matching Aork bypass was established. Ajv configuration uses synchronous strict validation without `$data`; [upstream's fix](https://github.com/ajv-validator/ajv/releases/tag/v8.18.0) addresses dynamic pattern handling. Drizzle identifiers are static/owner-namespaced; the [maintainer advisory](https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9) distinguishes static schemas from user-controlled identifiers. Zod's [collection-bound fix](https://github.com/colinhacks/zod/pull/6652) validates size constraints before collection elements. These observations limit exploit claims and do not replace patching.

Vite, Vitest and esbuild are development/build/test tools here. The verification runs `vitest run`, not the Vitest UI server, and builds static browser assets rather than exposing a Vite or esbuild development server. [Vitest 4.1.12](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12) backports manual/redirect-mock hardening; [esbuild 0.28.1](https://github.com/evanw/esbuild/releases/tag/v0.28.1) patches Windows development-server traversal, and [Vite's 7.3 changelog](https://github.com/vitejs/vite/blob/v7.3.8/packages/vite/CHANGELOG.md) records the patch series and esbuild compatibility. A clean current registry scan is an inventory result, not proof that all vulnerabilities or platform-specific behavior are absent.

## Validation

Executed with Node 24.22.3 from `/tmp/aork-node24/bin`, pnpm 10.30.2, macOS arm64:

- Frozen install, build, typecheck, dependency boundaries and `git diff --check`: passed. No production source or API adaptations were needed; the browser harness correction below was separately reproduced and verified.
- Full Host: **26 files / 252 tests passed**, `pnpm exec vitest run --maxWorkers=2`, 193.76 seconds.
- Final full Chromium: **84/84 passed**, `AORK_BROWSER_PORT=6734 pnpm exec playwright test --workers=1`, 4.0 minutes, after Host and against the same frozen build. Final typecheck, boundaries and diff checks passed after the test-only harness correction.
- Frozen lock SHA-256: `6e451f538437311aa619d654083246ce924547e26b6280cfb4f852105213d940`. Build compatibility manifest records Node 24.22.3 / ABI 137 and retained ACP SDK 2.7.0.

Raw logs use `/tmp/aork-dependency-{frozen-install,build,typecheck,boundaries,host-tests,browser-tests}.log`; final checks use `/tmp/aork-dependency-{typecheck,boundaries,browser-tests}-final.log`. No real account, external Agent conversation, credentials, remote deployment, Linux acceptance, or full 37-ticket product acceptance is claimed. Fresh generic/TypeScript/security review remains required before integration.

### Browser harness synchronization

The first full Chromium run completed with **83 passed / 1 failed** in 4.7 minutes. The superseded-configuration case timed out at its response wait; its screenshot showed no model selector and timed-out snapshots. A no-edit, traced five-repeat run reproduced **4 failures / 1 pass**. In all four failing traces the test installed snapshot holds before the initial model view became available, then waited for a configuration response without ever sending a `sessions.configureRun` POST. The passing trace reached the command (200). This establishes a test synchronization defect; it does not establish a product or dependency vulnerability.

The existing test now waits for the public Research model selector to show its initial `research-small` value and be enabled before installing the holds. It retains both route interceptions, accepted-command/disabled-latch checks, the superseding command, applied-state checks, final value and re-enabled controls. No assertion was removed, timeout raised, or production source changed. The same traced five-repeat command after this narrow correction passed **5/5** in 17.1 seconds. The subsequent full Chromium run passed **84/84** without rebuilding the frozen Host or plugins.

First-run logs, screenshot and error context are preserved in `/tmp/aork-dependency-browser-tests.log` and `/tmp/aork-dependency-browser-first-artifacts`; their SHA-256 values and the original test source hash are in `/tmp/aork-dependency-browser-first-evidence.json`. No-edit and corrected repeat logs/traces are in `/tmp/aork-dependency-latch-{noedit,ready}.log` and matching artifact directories. A redacted chronological/command-count summary is `/tmp/aork-dependency-latch-trace-summary.json`. These harness diagnostics are distinct from the registry inventory and dependency compatibility evidence.

## Accepted native recovery integration

The dependency branch subsequently merged accepted root `234d9ac402d10006d0c1cbe23e083f18dbf7761b` (native recovery source merge `d1fc6584b1ce4913535ec699baf506f9050cc7cc`). The only conflict was `packages/contracts/package.json`: preserve all accepted exports, including `./recovery`, with the patched Zod4.6.7 pin. The lockfile is unchanged from this remediation; frozen install succeeds. Accepted production source, profiles, new native tests and Sessions migrations Inputs4 / Reconciliation5 / Replies6 / Native7 are byte-identical to root. The earlier reviewed browser readiness correction is retained. No feature source or private Ticket24 code was added by this integration.

Fresh merged checks passed: frozen install, build, typecheck, dependency boundaries, staged/unstaged diff checks and official npm audit **0 records**. Native recovery11 + structured input11 + Run lifecycle15 + Workbench8 passed **45/45** in37.31s (maxWorkers2); Chromium native recovery4 + Run lifecycle1 + reconnect2 then passed **7/7** in37.1s (workers1, port6734) against the same build. All54 distribution-file checksums stayed unchanged through those tests. The earlier full252/84 runs above apply to the pre-native-recovery baseline; this merge uses these targeted new/joint checks rather than claiming a new complete263/88 run. Logs and source-equivalence/pin evidence are saved under `/tmp/aork-dependency-native23-*`; merged audit is `/tmp/aork-dependency-native23-audit.json`. The integration delta requires fresh review before landing.
