import { test, expect, frame } from './capture';
import { glideTo, clickAtCursor } from './cursor';

test('dash-engine: Micro to Flash is a real preference change', async ({ page, capture }) => {
  await page.goto('/dashboard#prefsSection');
  // The dashboard shows guests a sign-in wall and never mounts its panels. Reveal
  // the signed-in view and run the app's own panel code — the engine picker and its
  // click handler are real, nothing here is drawn by hand.
  await page.waitForFunction(() => !!(window as any).ffPanels);
  await page.evaluate(async () => {
    document.getElementById('authWall')!.classList.add('hidden');
    document.getElementById('dashMain')!.classList.remove('hidden');
    document.querySelectorAll('.reveal-up').forEach(e => e.classList.add('active'));
    await (window as any).ffPanels.mount();
  });
  const micro = page.locator('[data-tier="lite"]');
  const flash = page.locator('[data-tier="standard"]');
  await expect(micro).toHaveAttribute('aria-checked', 'true');
  const crop = await frame(page, page.locator('#modelTiers').locator('..'), 14);
  const microBox = (await micro.boundingBox())!;
  await capture('dash-engine', crop, async () => {
    await glideTo(page, micro);
    await page.waitForTimeout(600);
    await glideTo(page, flash);
    await clickAtCursor(page);
    await expect(flash).toHaveAttribute('aria-checked', 'true');
    await expect(flash).toContainText('in use');
    await expect(flash).toHaveClass(/bg-sage-50/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ff_prefs')!).modelTier)).toBe('standard');
    await page.waitForTimeout(1500);
  }, { x: microBox.x + microBox.width * .45, y: microBox.y + microBox.height * .5 });
});
