import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => { await page.goto('/?demo=1'); await expect(page.getByText('已连接本机')).toBeVisible(); });
test('路由总览、筛选、IPv6 只读与详情', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '当前路由', exact: true })).toBeVisible();
  await page.getByLabel('地址族', { exact: true }).selectOption('IPv6');
  await expect(page.getByRole('button', { name: '::/0', exact: true })).toBeVisible();
  await expect(page.getByLabel('选择 ::/0 经 fe80::1 接口 以太网', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '::/0', exact: true }).click();
  await expect(page.getByText('活动与持久记录')).toBeVisible();
  await page.getByLabel('关闭详情').click();
  await page.getByLabel('地址族', { exact: true }).selectOption('IPv4');
  await page.getByLabel('搜索路由', { exact: true }).fill('示例主机');
  await expect(page.getByRole('button', { name: '203.0.113.80/32', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '0.0.0.0/0', exact: true })).toHaveCount(0);
});
test('清除受管理路由保留配置并写入操作记录', async ({ page }) => {
  await page.getByRole('button', { name: '清除受管理路由', exact: true }).click();
  await expect(page.getByRole('heading', { name: /确认路由变更/ })).toBeVisible();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByRole('heading', { name: /操作结果/ })).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '203.0.113.0/25', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await expect(page.getByRole('button', { name: '示例主机', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '操作记录', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(1);
});
test('配置保存不修改系统且支持分组', async ({ page }) => {
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('界面测试');
  await page.getByRole('textbox', { name: '目标网段 / 前缀长度', exact: true }).fill('203.0.113.0/24');
  await page.getByRole('textbox', { name: '网关', exact: true }).fill('192.0.2.254');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '界面测试', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '当前路由', exact: true }).click();
  await expect(page.getByRole('button', { name: '203.0.113.0/24', exact: true })).toHaveCount(0);
});
test('深色主题与 hosts 编辑', async ({ page }) => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面主题', { exact: true }).selectOption('dark');
  await expect(page.locator('.app-provider')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'hosts 编辑', exact: true }).click();
  await expect(page.getByLabel('hosts 内容')).toBeVisible();
  await page.getByLabel('hosts 内容').fill('127.0.0.1 localhost\n');
  await page.getByRole('button', { name: '备份并保存', exact: true }).click();
  await expect(page.getByText('hosts 已备份并保存。')).toBeVisible();
});

test('分组成员选择与排序保留', async ({ page }) => {
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByRole('button', { name: '新增分组', exact: true }).click();
  await page.getByRole('textbox', { name: '分组名称', exact: true }).fill('临时组');
  await page.getByRole('checkbox', { name: '测试实验室', exact: true }).check();
  await page.getByRole('checkbox', { name: '示例主机', exact: true }).check();
  await page.getByRole('button', { name: '上移', exact: true }).nth(1).click();
  await page.getByRole('button', { name: '保存分组', exact: true }).click();
  await page.locator('.group-button').filter({ hasText: '临时组' }).click();
  await expect(page.locator('.library-table .route-link')).toHaveText(['示例主机', '测试实验室']);
});

test('全部配置批量添加到多个分组，去重并保留原成员顺序', async ({ page }) => {
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await expect(page.getByRole('button', { name: '添加到分组', exact: true })).toBeDisabled();
  await page.getByLabel('选择配置 示例主机', { exact: true }).check();
  await page.getByLabel('选择配置 测试实验室', { exact: true }).check();
  await page.getByRole('button', { name: '添加到分组', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '确认添加' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '示例网络', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '测试环境', exact: true }).check();
  await dialog.getByRole('button', { name: '确认添加' }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('.group-button').filter({ hasText: '测试环境' }).click();
  await expect(page.locator('.library-table .route-link')).toHaveText(['测试实验室', '示例主机']);
  await page.locator('.group-button').filter({ hasText: '示例网络' }).click();
  await expect(page.locator('.library-table .route-link')).toHaveText(['示例网络', '示例主机', '测试实验室']);
  await page.getByRole('button', { name: '当前路由', exact: true }).click();
  await expect(page.getByRole('button', { name: '198.51.100.0/25', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '操作记录', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(0);
});
