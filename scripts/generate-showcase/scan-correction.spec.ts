import { test, expect, readyScanner, frame, cropCenter } from './capture';
import { glideTo, clickAtCursor } from './cursor';

test('scan-correction: open the optional correction field', async ({ page, capture }) => {
  await readyScanner(page, true);
  const crop = await frame(page, page.locator('#feedbackBox'), 24);
  await capture('scan-correction', crop, async () => {
    await glideTo(page, page.locator('#fbNo'));
    await page.waitForTimeout(400);
    await clickAtCursor(page);
    await expect(page.locator('#fbCorrection')).toBeVisible();
    await glideTo(page, page.locator('#fbInput'));
    await clickAtCursor(page);
    await expect(page.locator('#fbInput')).toBeFocused();
    await expect(page.locator('#fbInput')).toHaveAttribute('placeholder', /optional/);
    await page.waitForTimeout(1400);
  }, cropCenter(crop));
});
