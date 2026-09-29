import { test, expect, frame, cropCenter } from './capture';
import { glideTo, smoothScroll } from './cursor';
import catalog from '../../trefle-data.json';

test('species-fields: black-eyed Susan missing-data states', async ({ page, capture }) => {
  // Freeze the existing catalogue record through the app's ordinary session
  // cache. The video shows real render logic, without live external services.
  const record = catalog['rudbeckia hirta'];
  await page.addInitScript(record => {
    sessionStorage.setItem('ff_species_rudbeckia hirta', JSON.stringify({
      title: 'Rudbeckia hirta', binomial: 'Rudbeckia hirta', found: true,
      family: record.family, growthHabit: 'Forb or herb', sunlight: record.sunlight,
      moistureUse: record.moistureUse, range: '', grow: '', toxic: '',
      summary: '', image: '', related: [], _enriched: true,
      articleUrl: 'https://en.wikipedia.org/wiki/Rudbeckia_hirta',
      attribution: record.source,
    }));
  }, record);
  await page.goto('/species?name=Rudbeckia%20hirta');
  await expect(page.locator('#spName')).toHaveText('Rudbeckia hirta');
  const fields = page.locator('#spContent > div.mt-10');
  const crop = await frame(page, fields, 24);
  // Leave enough room above the fields for a short, smooth real page scroll.
  const scrollStart = await page.evaluate(() => scrollY);
  const distance = Math.min(65, crop.y - 80);
  if (distance <= 0) throw new Error('Not enough room for species scroll');
  crop.y -= distance;
  crop.height += distance;
  await capture('species-fields', crop, async () => {
    await smoothScroll(page, scrollStart + distance);
    for (const id of ['factRange', 'factWater', 'factGrow', 'factToxic']) {
      const field = page.locator('#' + id);
      await expect(field).toContainText('Not documented');
      await glideTo(page, field);
      await page.waitForTimeout(750);
    }
    await smoothScroll(page, scrollStart);
  }, cropCenter(crop));
});
