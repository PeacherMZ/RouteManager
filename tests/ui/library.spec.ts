import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.getByRole('button', { name: /配置库与分组/ }).click();
});

test('复制配置可取消，修改后生成独立副本并保留原分组', async ({ page }) => {
  const source = page.getByRole('row').filter({ has: page.getByRole('button', { name: '示例主机', exact: true }) });
  await source.getByRole('button', { name: '复制', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('示例主机（副本）');
  await expect(dialog.getByRole('combobox', { name: '网关', exact: true })).toHaveValue('192.0.2.254');
  await expect(dialog.getByRole('spinbutton')).toHaveValue('5');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.library-table .route-link')).toHaveCount(3);
  await source.getByRole('button', { name: '复制', exact: true }).click();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('路由重复');
  await dialog.getByRole('textbox', { name: '目标网段 / 前缀长度', exact: true }).fill('203.0.113.81/32');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('.group-button').filter({ hasText: '示例网络' }).click();
  await expect(page.locator('.library-table .route-link')).toHaveText(['示例网络', '示例主机', '示例主机（副本）']);
  await expect(source).toContainText('203.0.113.80/32');
  await page.getByRole('button', { name: '当前路由', exact: true }).click();
  await expect(page.getByRole('button', { name: '203.0.113.81/32', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '操作记录', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(0);
});

test('批量编辑显示筛选外选项，仅保存勾选字段并保留未选配置', async ({ page }) => {
  await expect(page.getByRole('button', { name: '批量修改', exact: true })).toBeDisabled();
  await page.getByLabel('选择配置 示例网络', { exact: true }).check();
  await expect(page.getByLabel('选择所有当前配置', { exact: true })).toBeChecked({ indeterminate: true });
  await page.getByLabel('选择配置 示例主机', { exact: true }).check();
  await page.getByLabel('搜索配置', { exact: true }).fill('示例主机');
  await expect(page.locator('.selection-count')).toContainText('含当前筛选外 1 条');
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '保存批量修改' })).toBeDisabled();
  await dialog.locator('summary').click();
  await expect(dialog.locator('.batch-targets li')).toHaveCount(2);
  await dialog.getByLabel('修改网关', { exact: true }).check();
  const gateway = dialog.getByRole('combobox', { name: '网关', exact: true });
  await gateway.fill('invalid');
  await gateway.press('ArrowDown');
  await gateway.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('IPv4 网关');
  await gateway.fill('192.0.2.1');
  await gateway.press('Tab');
  await dialog.getByLabel('修改备注', { exact: true }).check();
  await dialog.getByRole('textbox', { name: '备注', exact: true }).fill('');
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('搜索配置', { exact: true }).fill('');
  for (const [name, metric] of [['示例网络', '10'], ['示例主机', '5']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '网关', exact: true })).toHaveValue('192.0.2.1');
    await expect(dialog.getByRole('spinbutton')).toHaveValue(metric);
    await expect(dialog.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  await expect(page.getByRole('row').filter({ hasText: '测试实验室' })).toContainText('192.0.2.254');
  await page.locator('.group-button').filter({ hasText: '示例网络' }).click();
  await expect(page.locator('.library-table .route-link')).toHaveText(['示例网络', '示例主机']);
  await page.getByRole('button', { name: '当前路由', exact: true }).click();
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: '203.0.113.80/32', exact: true }) })).toContainText('192.0.2.254');
  await page.getByRole('button', { name: '操作记录', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(0);
});

test('批量编辑拒绝重复路由，取消后不保存，支持清空 metric 和接口', async ({ page }) => {
  await page.getByLabel('选择配置 示例网络', { exact: true }).check();
  await page.getByLabel('选择配置 示例主机', { exact: true }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('修改目标网段', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('路由重复');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '示例主机' })).toContainText('203.0.113.80/32');
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  await dialog.getByLabel('修改路由 metric', { exact: true }).check();
  await dialog.getByRole('spinbutton').fill('');
  await dialog.getByLabel('修改网络接口', { exact: true }).check();
  await dialog.getByRole('combobox', { name: '网络接口', exact: true }).selectOption('');
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '示例主机', exact: true }).click();
  await expect(dialog.getByRole('spinbutton')).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: '网络接口', exact: true })).toHaveValue('');
});

test('批量保存失败保留草稿与原配置，可重试且每次只提交一次', async ({ page }) => {
  await page.route('**/src/demo.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('switch (command)', `
      if (command === 'save_library') {
        window.saveAttempts = (window.saveAttempts || 0) + 1;
        if (window.rejectSave) throw new Error('模拟保存失败');
      }
      switch (command)`);
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByLabel('选择所有当前配置', { exact: true }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('修改备注', { exact: true }).check();
  await dialog.getByRole('textbox', { name: '备注', exact: true }).fill('统一备注');
  await page.evaluate(() => { (window as any).rejectSave = true; });
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('保存失败');
  await expect(dialog.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('统一备注');
  await expect(page.locator('.config-comment')).toHaveText(['虚构文档示例网段', '虚构主机示例', '需要时应用']);
  expect(await page.evaluate(() => (window as any).saveAttempts)).toBe(1);
  await page.evaluate(() => { (window as any).rejectSave = false; });
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.config-comment')).toHaveText(['统一备注', '统一备注', '统一备注']);
  expect(await page.evaluate(() => (window as any).saveAttempts)).toBe(2);
});

test('新增及系统编辑可选择去重网关，也可手动输入且不自动改接口', async ({ page }) => {
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const gateway = dialog.getByRole('combobox', { name: '网关', exact: true });
  await gateway.click();
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option')).toHaveCount(4);
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /192\.0\.2\.254/ })).toHaveCount(1);
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /fe80/ })).toHaveCount(0);
  await page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /198\.51\.100\.129/ }).click();
  await expect(gateway).toHaveValue('198.51.100.129');
  await expect(dialog.getByRole('combobox', { name: '网络接口', exact: true })).toHaveValue('');
  await gateway.fill('192.0.2.77');
  await gateway.press('Tab');
  await expect(gateway).toHaveValue('192.0.2.77');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '当前路由', exact: true }).click();
  await page.getByRole('button', { name: '新增路由', exact: true }).click();
  await gateway.click();
  await page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /0\.0\.0\.0 · 直连/ }).click();
  await expect(gateway).toHaveValue('0.0.0.0');
});

test('快照读取失败时隐藏旧网关，刷新恢复后提供最新候选', async ({ page }) => {
  await page.route('**/src/demo.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('switch (command)', `
      if (command === 'get_snapshot' && window.failSnapshot) throw new Error('模拟快照读取失败');
      switch (command)`);
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.evaluate(() => { (window as any).failSnapshot = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('路由数据已过期')).toBeVisible();
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  const gateway = page.getByRole('combobox', { name: '网关', exact: true });
  await gateway.click();
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /192\.0\.2/ })).toHaveCount(0);
  await gateway.press('Escape');
  await page.evaluate(() => { (window as any).failSnapshot = false; });
  await page.getByRole('button', { name: '刷新网关列表', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新网关列表', exact: true })).toBeEnabled();
  await gateway.click();
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /192\.0\.2\.1/ })).toBeVisible();
});

for (const theme of ['light', 'dark']) test(`最小窗口批量弹窗与网关候选可用：${theme}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面主题', { exact: true }).selectOption(theme);
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByLabel('选择所有当前配置', { exact: true }).check();
  await expect(page.getByRole('button', { name: '批量修改', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '复制', exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: `artifacts/qa/${testInfo.project.name}/library-selected-${theme}.png` });
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '保存批量修改' })).toBeInViewport();
  await dialog.getByLabel('修改网关', { exact: true }).check();
  await dialog.getByRole('combobox', { name: '网关', exact: true }).click();
  await expect(page.getByRole('listbox', { name: '网关', exact: true }).getByRole('option', { name: /192\.0\.2\.1/ })).toBeInViewport();
  await page.screenshot({ path: `artifacts/qa/${testInfo.project.name}/batch-gateways-${theme}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1060);
});
