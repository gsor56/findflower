import type { Page, Locator } from '@playwright/test';

export async function injectCursor(page: Page, x = 960, y = 540) {
  await page.evaluate(({ x, y }) => {
    document.getElementById('showcase-cursor')?.remove();
    const cursor = document.createElement('div');
    cursor.id = 'showcase-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = `position:fixed;left:0;top:0;width:30px;height:38px;pointer-events:none;z-index:2147483647;will-change:transform;transform:translate(${x}px, ${y}px)`;
    cursor.innerHTML = '<svg width="30" height="38" viewBox="0 0 24 32" style="transform-origin:3px 2px;filter:drop-shadow(0 2px 2px #0005)"><path d="M3 2 L3 25 L8.8 19.6 L13.3 29.5 L17.3 27.7 L12.8 18 L21 18 Z" fill="#171717" stroke="white" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
    // A real page.mouse.click dispatches pointerdown. Scaling the child SVG
    // leaves the parent's translate animation undisturbed.
    document.addEventListener('pointerdown', () => {
      cursor.querySelector('svg')!.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.9)', offset: .35 },
          { transform: 'scale(.9)' }], { duration: 150, easing: 'ease-out' }
      );
    }, { capture: true });
  }, { x, y });
  await page.mouse.move(x, y);
}

export async function simulateSmoothMouse(page: Page, startX: number, startY: number,
  endX: number, endY: number, duration = 1100) {
  // Cubic Bezier with perpendicular control-point offsets: never a straight
  // interpolation. Smoothstep timing eases both ends of the curved path.
  await page.evaluate(({ startX, startY, endX, endY, duration }) => new Promise<void>(resolve => {
    const cursor = document.getElementById('showcase-cursor')!;
    const dx = endX - startX, dy = endY - startY;
    const distance = Math.hypot(dx, dy) || 1;
    const bend = Math.min(95, Math.max(22, distance * .16));
    const nx = -dy / distance, ny = dx / distance;
    const p1 = { x: startX + dx * .28 + nx * bend, y: startY + dy * .28 + ny * bend };
    const p2 = { x: startX + dx * .73 - nx * bend * .45, y: startY + dy * .73 - ny * bend * .45 };
    const started = performance.now();
    const frame = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const t = progress * progress * (3 - 2 * progress), u = 1 - t;
      const x = u ** 3 * startX + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * endX;
      const y = u ** 3 * startY + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * endY;
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      if (progress < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  }), { startX, startY, endX, endY, duration });
  // Set the actual pointer at the destination for native hover and click state.
  await page.mouse.move(endX, endY);
}

export async function glideTo(page: Page, target: Locator, duration = 1100) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Cursor target is not visible');
  const from = await page.locator('#showcase-cursor').boundingBox();
  if (!from) throw new Error('Inject cursor before choreography');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await simulateSmoothMouse(page, from.x, from.y, x, y, duration);
  return { x, y };
}

export async function clickAtCursor(page: Page) {
  const box = await page.locator('#showcase-cursor').boundingBox();
  if (!box) throw new Error('Missing ghost cursor');
  await page.mouse.click(box.x, box.y, { delay: 80 });
  await page.waitForTimeout(200);
}

export async function smoothScroll(page: Page, top: number, duration = 1400) {
  await page.evaluate(({ top, duration }) => new Promise<void>(resolve => {
    const from = scrollY, start = performance.now();
    function frame(now: number) {
      const t = Math.min(1, (now - start) / duration);
      window.scrollTo({ top: from + (top - from) * t * t * (3 - 2 * t), behavior: 'instant' });
      if (t < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  }), { top, duration });
}
