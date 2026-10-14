import { test, expect } from '@playwright/test';

test('配置保存不等待慢快照，旧快照不能覆盖后续保存', async ({ page }) => {
  // Delay only the simulated OS snapshot; database operations remain available.
  await page.route('**/src/demo.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('switch (command)', `
      const probe = window;
      if (command === 'get_snapshot') {
        probe.snapshotReads = (probe.snapshotReads || 0) + 1;
        if (probe.blockSnapshot) {
          probe.blockSnapshot = false;
          const oldSnapshot = structuredClone(snapshot());
          await new Promise(resolve => { probe.releaseSnapshot = resolve; });
          return oldSnapshot;
        }
      }
      switch (command)`);
    await route.fulfill({ response, body });
  });
  await page.goto('/?demo=1');
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('自动刷新间隔', { exact: true }).selectOption('0');
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  const initialReads = await page.evaluate(() => (window as any).snapshotReads);
  expect(initialReads).toBeGreaterThan(0);
  await page.getByLabel('选择配置 示例主机', { exact: true }).check();
  await page.getByRole('button', { name: '添加到分组', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: '测试环境', exact: true }).check();
  await page.getByRole('button', { name: '确认添加', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).snapshotReads)).toBe(initialReads);

  await page.evaluate(() => { (window as any).blockSnapshot = true; });
  for (const [name, prefix] of [['并发配置一', '203.0.113.0/24'], ['并发配置二', '198.51.100.0/24']]) {
    await page.getByRole('button', { name: '新增配置', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await page.getByRole('textbox', { name: '目标网段 / 前缀长度', exact: true }).fill(prefix);
    await page.getByRole('textbox', { name: '网关', exact: true }).fill('192.0.2.254');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSnapshot)).toBe('function');
  await page.evaluate(() => (window as any).releaseSnapshot());
  await expect(page.getByText('已连接本机')).toBeVisible();
  for (const name of ['并发配置一', '并发配置二']) {
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('未生效');
  }
  // A group-only save must not invalidate a pending route-status response when polling is off.
  await page.evaluate(() => { (window as any).blockSnapshot = true; (window as any).releaseSnapshot = null; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSnapshot)).toBe('function');
  await page.locator('.group-button').filter({ hasText: '测试环境' }).click();
  await page.getByRole('button', { name: '编辑分组', exact: true }).click();
  await page.getByRole('textbox', { name: '分组名称', exact: true }).fill('更新后的组');
  await page.getByRole('button', { name: '保存分组', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseSnapshot());
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.locator('.group-button').filter({ hasText: '更新后的组' })).toBeVisible();
  await expect(page.getByText('已连接本机')).toBeVisible();
});
