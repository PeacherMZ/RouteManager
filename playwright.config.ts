import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui',
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1440, height: 960 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
  reporter: 'list',
});
