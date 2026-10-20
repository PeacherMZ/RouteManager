import { test, expect } from '@playwright/test';
import packageInfo from '../../package.json' with { type: 'json' };

test('macOS 显示按需授权和用户目录，禁用不适用的 metric', async ({ page }) => {
  await page.goto('/?demo=1&demo_platform=macos');
  await expect(page.getByText(`版本 ${packageInfo.version} · macOS`)).toBeVisible();
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

test('macOS 批量编辑保留未勾选字段，临时接口禁止持久路由', async ({ page }) => {
  await page.goto('/?demo=1&demo_platform=macos');
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.getByRole('button', { name: /配置库与分组/ }).click();
  await page.getByLabel('选择配置 示例网络', { exact: true }).check();
  await page.getByLabel('选择配置 示例主机', { exact: true }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('修改路由 metric', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('spinbutton')).toBeDisabled();
  await dialog.getByLabel('修改网络接口', { exact: true }).check();
  await dialog.getByRole('combobox', { name: '网络接口', exact: true }).selectOption('macos:utun0:-');
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('没有唯一网络服务');
  await dialog.getByLabel('修改持久路由', { exact: true }).check();
  await dialog.getByRole('switch', { name: '持久路由 重启后保留', exact: true }).uncheck();
  await dialog.getByLabel('修改路由作用域', { exact: true }).check();
  await dialog.getByRole('combobox', { name: '路由作用域', exact: true }).selectOption('scoped');
  await dialog.getByRole('button', { name: '保存批量修改' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '示例主机', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '持久路由 重启后保留', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('combobox', { name: '路由作用域', exact: true })).toHaveValue('scoped');
  await expect(dialog.getByRole('combobox', { name: '网络接口', exact: true })).toHaveValue('macos:utun0:-');
});
