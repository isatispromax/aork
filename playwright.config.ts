import { defineConfig } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.AORK_BROWSER_TEST_PORT ?? '6693'}`;
export default defineConfig({ testDir: './tests/browser', fullyParallel: false, use: { baseURL: origin, viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' }, webServer: { command: 'node scripts/browser-host.mjs', url: `${origin}/api/bootstrap`, reuseExistingServer: false, timeout: 20_000 } });
