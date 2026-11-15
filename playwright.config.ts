import { defineConfig } from '@playwright/test';
const port = process.env.AORK_BROWSER_PORT ?? '6693';
export default defineConfig({ testDir: './tests/browser', fullyParallel: false, use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' }, webServer: { command: 'node scripts/browser-host.mjs', url: `http://127.0.0.1:${port}/api/bootstrap`, reuseExistingServer: false, timeout: 20_000 } });
