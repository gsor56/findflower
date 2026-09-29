import { test, expect, readyScanner, frame, cropCenter } from './capture';
import { glideTo, simulateSmoothMouse } from './cursor';

test('scan-ranking: confidence and nonzero runners-up', async ({ page, capture }) => {
  await readyScanner(page, true);
  const region = page.locator('#resConfVal').locator('../..');
  await frame(page, region);
  const top = (await region.boundingBox())!;
  const alts = (await page.locator('#resAlts').boundingBox())!;
  const crop = { x: Math.floor(top.x - 20), y: Math.floor(top.y - 20),
    width: Math.ceil(top.width + 40), height: Math.ceil(alts.y + alts.height - top.y + 40) };
  const start = cropCenter(crop);
  await capture('scan-ranking', crop, async () => {
    await glideTo(page, page.locator('#resConfBar'));
    await page.waitForTimeout(850);
    for (const value of ['0.9%', '0.3%', '0.1%']) {
      const row = page.locator('#resAltsList > div').filter({ hasText: value });
      await expect(row).toBeVisible();
      await glideTo(page, row);
      await page.waitForTimeout(750);
    }
    const from = (await page.locator('#showcase-cursor').boundingBox())!;
    await simulateSmoothMouse(page, from.x, from.y, start.x, start.y);
  }, start);
});
