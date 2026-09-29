import { test, expect } from '@playwright/test';
import { assets } from './assets';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => {
    if (/findflower|workers\.dev|auth0|cloudflare|huggingface/.test(new URL(route.request().url()).hostname)) return route.abort();
    return route.continue();
  });
});

for (const width of [1280, 390]) {
  test(`five demos decode and play at ${width}px; lower clips remain unfetched`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    page.on('request', request => { if (/\.mp4(?:\?|$)/.test(request.url())) requests.push(request.url()); });
    await page.goto('/how');
    await expect(page.locator('video[data-showcase]')).toHaveCount(5);
    await page.waitForTimeout(600);
    for (const asset of assets.slice(2)) {
      expect(requests.some(url => url.includes(asset.name))).toBe(false);
      await expect(page.locator(`video[data-src*="${asset.name}"]`)).not.toHaveAttribute('src');
    }
    for (const asset of assets) {
      const video = page.locator(`video[data-src*="${asset.name}"]`);
      await video.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
      expect(await video.evaluate((el: HTMLVideoElement) => ({ width: el.videoWidth, height: el.videoHeight })))
        .toEqual({ width: asset.width, height: asset.height });
      const initial = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
      await page.waitForTimeout(350);
      const after = await video.evaluate((el: HTMLVideoElement) => ({ time: el.currentTime, paused: el.paused, muted: el.muted, loop: el.loop, inline: el.playsInline }));
      expect(after.paused).toBe(false);
      expect(after.time).not.toBe(initial);
      expect(after.muted && after.loop && after.inline).toBe(true);
      expect(await video.getAttribute('class')).toBe('w-full rounded-lg border border-neutral-200 bg-white');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `public/assets/how-playback-${width}.png`, fullPage: true });
  });
}

test('router navigation reinstates lazy playback without reloading the document', async ({ page }) => {
  await page.goto('/pricing');
  await page.evaluate(() => { (window as any).__showcaseRouteMarker = true; });
  await page.locator('a[href="/how"]').first().click();
  await expect(page).toHaveURL(/\/how$/);
  expect(await page.evaluate(() => (window as any).__showcaseRouteMarker)).toBe(true);
  const video = page.locator('video[data-showcase]').nth(2);
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2)).toBe(true);
  await page.locator('a[href="/pricing"]').first().click();
  await expect(page).toHaveURL(/\/pricing$/);
  await page.locator('a[href="/how"]').first().click();
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2)).toBe(true);
});

test('reduced motion keeps posters; the pause control can enable and stop playback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/how');
  const video = page.locator('video[data-showcase]').first();
  await video.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await expect(video).not.toHaveAttribute('src');
  await expect(page.locator('[data-showcase-toggle]')).toHaveText('Play demonstrations');
  await page.locator('[data-showcase-toggle]').click();
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2)).toBe(true);
  await page.locator('[data-showcase-toggle]').click();
  await expect.poll(() => page.locator('video[data-showcase]').evaluateAll(nodes => nodes.every(el => (el as HTMLVideoElement).paused))).toBe(true);
});
