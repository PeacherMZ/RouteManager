import { test, expect } from '@playwright/test';

test('macOS 显示按需授权和用户目录，禁用不适用的 metric', async ({ page }) => {
  await page.goto('/?demo=1&demo_platform=macos');
  await expect(page.getByText('版本 2.1.0 · macOS')).toBeVisible();
  await expect(page.getByRole('cell', { name: '不适用', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('~/Library/Application Support/com.local.route-manager（演示）', { exact: true })).toBeVisible();
  await expect(page.getByText('系统修改时请求管理员授权，助手执行后退出。')).toBeVisible();
  await expect(page.getByText('升级和卸载保留用户数据；程序安装目录与数据目录相互独立。')).toBeVisible();
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  await expect(page.getByRole('spinbutton')).toBeDisabled();
  await expect(page.getByText('macOS 不适用；保存时清除 Windows metric。')).toBeVisible();
});
