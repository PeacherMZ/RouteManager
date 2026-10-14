import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const port = Number(process.argv[2] ?? 9223);
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
let page;
try {
  const pages = browser.contexts().flatMap(context => context.pages());
  page = pages.find(candidate => candidate.url().includes('tauri.localhost')) ?? pages[0];
  assert(page, 'Tauri WebView page was not found');
  await page.getByText('已连接本机').waitFor({ timeout: 60_000 });
  const report = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const library = await invoke('get_library');
    const snapshot = await invoke('get_snapshot');
    const settings = await invoke('get_settings');
    return {
      url: location.href,
      config_routes: library.routes.length,
      groups: library.groups.length,
      logical_routes: snapshot.routes.length,
      managed: snapshot.routes.filter(r => r.ownership === 'managed').length,
      ambiguous_configs: snapshot.matches.filter(m => m.state === 'ambiguous').length,
      data_dir: settings.data_dir,
      captured_at: snapshot.captured_at,
    };
  });
  assert(Number.isInteger(report.config_routes) && report.config_routes >= 0);
  assert(Number.isInteger(report.groups) && report.groups >= 0);
  assert(report.logical_routes > 0);
  assert.equal(await page.getByText(/演示模式 · 以下/).count(), 0);
  await mkdir('artifacts/qa', { recursive: true });
  await page.screenshot({ path: 'artifacts/qa/desktop-native.png', fullPage: true });
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  assert.equal(await page.locator('.library-table tbody tr').count(), report.config_routes);
  await page.screenshot({ path: 'artifacts/qa/desktop-native-library.png', fullPage: true });
  await writeFile('artifacts/qa/desktop-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Close only the desktop instance explicitly started for this smoke test.
  if (page) {
    try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' })); }
    catch { /* Destroying the WebView can close the CDP connection before replying. */ }
  }
  await browser.close().catch(() => {});
}
