import { test, expect } from '@playwright/test';
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
