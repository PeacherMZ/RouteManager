import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`编辑弹窗保留页面背景及主题：${theme}`, async ({ page }, testInfo) => {
    await page.goto('/?demo=1');
    await expect(page.getByText('已连接本机')).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('界面主题', { exact: true }).selectOption(theme);
    await expect(page.locator('.app-provider[data-theme]')).toHaveAttribute('data-theme', theme);
    await expect(page.getByLabel('界面主题', { exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /配置库与分组/ }).click();
    const background = page.locator('.library-layout');
    const before = await background.boundingBox();
    const muted = await background.locator('.muted').first().evaluate(el => getComputedStyle(el).color);
    const checkOverlay = async () => {
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // A portal host must not paint an opaque sheet over the underlying workspace.
      const host = dialog.locator('..');
      await expect(host).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(dialog.locator('.muted').first()).toHaveCSS('color', muted);
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(await background.boundingBox()).toEqual(before);
    };
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await checkOverlay();
    await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('示例网络');
    await page.screenshot({ path: `artifacts/qa/${testInfo.project.name}/editor-${theme}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '新增分组', exact: true }).click();
    await checkOverlay();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '当前路由', exact: true }).click();
    await page.getByRole('button', { name: '0.0.0.0/0', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(drawer.locator('.muted').first()).toHaveCSS('color', muted);
    await page.getByLabel('关闭详情').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

for (const platform of ['windows', 'macos']) {
  for (const theme of ['light', 'dark']) {
    test(`路由表占据剩余视口并独立滚动：${platform} / ${theme}`, async ({ page }) => {
      await page.goto(`/?demo=1&demo_platform=${platform}`);
      await expect(page.getByText('已连接本机')).toBeVisible();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('界面主题', { exact: true }).selectOption(theme);
      await page.getByRole('button', { name: '当前路由', exact: true }).click();
      const card = page.getByRole('region', { name: '系统路由表' });
      const scroll = card.locator('.table-scroll');
      for (const viewport of [{ width: 1060, height: 680 }, { width: 1320, height: 860 }, { width: 1440, height: 960 }]) {
        await page.setViewportSize(viewport);
        const dimensions = await scroll.evaluate(element => ({
          height: element.clientHeight,
          pageHeight: document.documentElement.scrollHeight,
          pageWidth: document.documentElement.scrollWidth,
        }));
        expect(dimensions.pageHeight).toBeLessThanOrEqual(viewport.height);
        expect(dimensions.pageWidth).toBeLessThanOrEqual(viewport.width);
        expect(dimensions.height).toBeGreaterThan(viewport.height * 0.4);
        await expect(card.locator('.table-footer')).toBeInViewport();
        await expect(page.getByRole('button', { name: '清除受管理路由', exact: true })).toBeInViewport();
        await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.scrollLeft = element.scrollWidth; });
        const header = await card.locator('th').last().boundingBox();
        const bounds = await scroll.boundingBox();
        expect(Math.abs(header!.y - bounds!.y)).toBeLessThan(2);
        await expect(card.getByRole('button', { name: '查看 fe80::/64 详情', exact: true })).toBeInViewport();
      }
      const before = await card.boundingBox();
      await page.getByLabel('搜索路由', { exact: true }).fill('不存在的路由');
      await expect(page.getByText('没有匹配的路由')).toBeInViewport();
      expect((await card.boundingBox())!.height).toBeCloseTo(before!.height, 0);
      await expect(card.locator('.table-footer')).toContainText('显示 0 / 11 条路由');
    });
  }
}

test('最小窗口中同步失败提示与表格保持可见', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 680 });
  await page.route('**/src/demo.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('switch (command)', `
      if (command === 'get_snapshot' && window.failSnapshot) throw new Error('模拟快照读取失败');
      switch (command)`);
    await route.fulfill({ response, body });
  });
  await page.goto('/?demo=1');
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.evaluate(() => { (window as any).failSnapshot = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('路由数据已过期')).toBeInViewport();
  await expect(page.getByRole('button', { name: '新增路由', exact: true })).toBeDisabled();
  await expect(page.locator('.system-route-card .table-footer')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(680);
});

test('desktop layouts and screenshots', async ({page}, testInfo)=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?demo=1');
  await expect(page.getByText('已连接本机')).toBeVisible();
  await page.screenshot({path:`artifacts/qa/${testInfo.project.name}/routes-light.png`,fullPage:true});
  await page.getByRole('button',{name:/配置库与分组/}).click();
  await page.screenshot({path:`artifacts/qa/${testInfo.project.name}/library-light.png`,fullPage:true});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('界面主题',{exact:true}).selectOption('dark');
  await expect(page.locator('.app-provider')).toHaveAttribute('data-theme','dark');
  await page.getByRole('button',{name:'当前路由',exact:true}).click();
  await page.screenshot({path:`artifacts/qa/${testInfo.project.name}/routes-dark.png`,fullPage:true});
  await page.setViewportSize({width:1060,height:680});
  await page.screenshot({path:`artifacts/qa/${testInfo.project.name}/routes-compact.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
