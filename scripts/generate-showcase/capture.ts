import { test as base, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, baseURL, recordVideo } from './playwright.config';
import { injectCursor } from './cursor';

export { expect };
export type Crop = { x: number; y: number; width: number; height: number };
type Capture = (name: string, crop: Crop, action: () => Promise<void>, start?: { x: number; y: number }) => Promise<void>;

export const test = base.extend<{ capture: Capture }>({
  // A fresh context per asset isolates local preferences, scan history and feedback.
  context: async ({ browser }, use) => {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
      baseURL, recordVideo, serviceWorkers: 'block', colorScheme: 'light',
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      // No FindFlower, inference, authentication or challenge traffic leaves localhost.
      if (/findflower|workers\.dev|auth0|cloudflare|huggingface/.test(url.hostname)) return route.abort();
      return route.continue();
    });
    await context.addInitScript(() => {
      localStorage.setItem('ff_prefs', JSON.stringify({ modelTier: 'lite', recordHistory: false, keepPhotos: false }));
      localStorage.setItem('ff_coach_try', '1');
      const style = document.createElement('style');
      style.textContent = '::-webkit-scrollbar { display: none; } html { scrollbar-width: none; } * { cursor: none !important; }';
      // addInitScript runs before <head> exists on some navigations.
      document.addEventListener('DOMContentLoaded', () => document.head.append(style), { once: true });
    });
    await use(context);
    await context.close();
  },
  capture: async ({ page }, use, testInfo) => {
    let recording: { name: string; crop: Crop; duration: number; raw: string } | undefined;
    // A failed rerun must not leave a previous manifest looking successful.
    const assetName = path.basename(testInfo.file, '.spec.ts');
    await fs.mkdir(recordVideo.dir, { recursive: true });
    await fs.rm(path.join(recordVideo.dir, `${assetName}.json`), { force: true });
    await use(async (name, crop, action, start = { x: 960, y: 540 }) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700); // Let layout and reveal transitions settle.
      await injectCursor(page, start.x, start.y);
      const started = Date.now();
      await page.waitForTimeout(650);
      await action();
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(recordVideo.dir, `${name}-review.png`) });
      const duration = (Date.now() - started) / 1000;
      const video = page.video();
      if (!video) throw new Error('Video capture is disabled');
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > 1920 || crop.y + crop.height > 1080) {
        throw new Error('Choreography crop extends beyond the recorded viewport');
      }
      await page.close(); // Flush before copying, no zero-byte success files.
      const raw = path.join(recordVideo.dir, `${name}.webm`);
      await video.saveAs(raw);
      await video.delete();
      recording = { name, crop, duration, raw: path.relative(root, raw).replace(/\\/g, '/') };
    });
    if (testInfo.status === 'passed' && recording) {
      await fs.writeFile(path.join(recordVideo.dir, `${recording.name}.json`), JSON.stringify(recording, null, 2) + '\n');
    }
  },
});

export async function readyScanner(page: Page, completed = false) {
  await page.goto('/try');
  await expect(page.locator('#engineName')).toHaveText('Flora-Micro');
  await expect(page.locator('#modelStatusText')).toContainText('Flora-Micro ready', { timeout: 120_000 });
  await page.locator('[data-mode="upload"]').click();
  if (completed) {
    const photo = process.env.SHOWCASE_PHOTO || path.join(__dirname, 'fixtures/cc0-bird-b.jpg');
    await page.locator('#fileInput').setInputFiles(photo);
    await expect(page.locator('#identifyBtn')).toBeEnabled();
    await page.locator('#identifyBtn').click();
    await expect(page.locator('#resContent')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#resConfVal')).toHaveText('98.4%');
    await expect(page.locator('#resAltsList > div')).toHaveCount(3);
    for (const value of ['0.9%', '0.3%', '0.1%']) {
      await expect(page.locator('#resAltsList')).toContainText(value);
    }
  }
}

export async function frame(page: Page, locator: Locator, padding = 20): Promise<Crop> {
  await locator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(1000);
  const box = await locator.boundingBox();
  if (!box) throw new Error('Capture element is not visible');
  const x = Math.max(0, Math.floor((box.x - padding) / 2) * 2);
  const y = Math.max(0, Math.floor((box.y - padding) / 2) * 2);
  const width = Math.min(1920 - x, Math.ceil((box.width + padding * 2) / 2) * 2);
  const height = Math.min(1080 - y, Math.ceil((box.height + padding * 2) / 2) * 2);
  if (box.y < 64 || box.y + box.height > 1080) throw new Error('Capture region exceeds the visible viewport');
  return { x, y, width, height };
}

export function cropCenter(crop: Crop) {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}
