import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', fullyParallel: false, use: { baseURL: 'http://127.0.0.1:6693', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' }, webServer: { command: 'node scripts/browser-host.mjs', url: 'http://127.0.0.1:6693/api/bootstrap', reuseExistingServer: false, timeout: 20_000 } });
