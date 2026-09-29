import { test, expect, readyScanner } from './capture';
import { glideTo, clickAtCursor, simulateSmoothMouse } from './cursor';

test('scan-input: choose the upload zone', async ({ page, capture }) => {
  await readyScanner(page);
  // Stop above the separate image-preview block, just like the original still.
  const input = page.locator('#previewBlock').locator('..');
  await input.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.evaluate(() => scrollBy({ top: -100, behavior: 'instant' }));
  await page.waitForTimeout(1000);
  const left = (await input.boundingBox())!;
  const right = (await page.locator('#resultPanel').boundingBox())!;
  const preview = (await page.locator('#previewBlock').boundingBox())!;
  const crop = { x: Math.floor(left.x), y: Math.floor(left.y),
    width: Math.ceil(right.x + right.width - left.x), height: Math.ceil(preview.y - left.y) };
  await capture('scan-input', crop, async () => {
    await glideTo(page, page.locator('#dropzone'));
    await page.waitForTimeout(550);
    const chooser = page.waitForEvent('filechooser');
    await clickAtCursor(page);
    await (await chooser).setFiles([]); // Dismiss the native chooser; it is outside the browser video.
    await expect(page.locator('#dropzone')).toBeVisible();
    await page.waitForTimeout(850);
    const cursor = (await page.locator('#showcase-cursor').boundingBox())!;
    await simulateSmoothMouse(page, cursor.x, cursor.y, 960, 540);
  });
});
