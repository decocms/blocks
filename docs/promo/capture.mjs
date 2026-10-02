import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 540, height: 760 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, colorScheme: 'light',
  recordVideo: { dir: output, size: { width: 1080, height: 1520 } },
});
const page = await context.newPage();
const recordingStart = performance.now();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(process.env.PROMO_URL ?? 'http://localhost:4173/next/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = `#promo-cursor{position:fixed;width:22px;height:22px;border:2px solid #fff;border-radius:50%;background:#d0ff5f99;box-shadow:0 0 0 2px #124723;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);left:-100px;top:-100px}.promo-ripple{position:fixed;width:36px;height:36px;border:3px solid #bbff53;border-radius:50%;z-index:2147483646;pointer-events:none;animation:promo-click .5s ease-out forwards}@keyframes promo-click{from{transform:translate(-50%,-50%) scale(.5);opacity:1}to{transform:translate(-50%,-50%) scale(2);opacity:0}}`;
  document.head.append(style);
  const cursor = document.createElement('div'); cursor.id = 'promo-cursor'; document.body.append(cursor);
});
const start = performance.now();
const clicks = [], captions = [];
const elapsed = () => (performance.now() - start) / 1000;
const until = async seconds => page.waitForTimeout(Math.max(0, seconds * 1000 - (performance.now() - start)));
const caption = (label, title) => captions.push({ at: elapsed(), label, title });
let pointer = { x: 480, y: 640 };
async function point(x, y) {
  const from = { ...pointer };
  for (let i = 1; i <= 18; i++) {
    const t = i / 18, ease = t * t * (3 - 2 * t);
    pointer = { x: from.x + (x - from.x) * ease, y: from.y + (y - from.y) * ease };
    await page.mouse.move(pointer.x, pointer.y);
    await page.evaluate(({ x, y }) => { const c = document.querySelector('#promo-cursor'); c.style.left = `${x}px`; c.style.top = `${y}px`; }, pointer);
    await page.waitForTimeout(16);
  }
}
async function click(locator, fraction = .5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Missing click target');
  const x = box.x + box.width * fraction, y = box.y + box.height / 2;
  await point(x, y);
  clicks.push(elapsed());
  await page.evaluate(({ x, y }) => {
    const r = document.createElement('div'); r.className = 'promo-ripple';
    r.style.left = `${x}px`; r.style.top = `${y}px`; document.body.append(r);
    setTimeout(() => r.remove(), 600);
  }, { x, y });
  await page.mouse.click(x, y);
}
async function scrollTo(locator, top = 95) {
  const y = await locator.evaluate((el, top) => window.scrollY + el.getBoundingClientRect().top - top, top);
  await page.evaluate(async y => {
    const from = window.scrollY, start = performance.now();
    await new Promise(resolve => {
      function frame(now) {
        const t = Math.min(1, (now - start) / 750), e = t * t * (3 - 2 * t);
        window.scrollTo(0, from + (y - from) * e);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
  }, y);
}

caption('DECO / NEXT', 'One model. Every maker.');
await until(2.6);
await scrollTo(page.getByRole('group', { name: 'From a TypeScript type to a resolved value', exact: true }).locator('..'), 90);
caption('01 / DEVELOPERS', 'Write a function.');
await until(5.0);
await click(page.locator('[data-jp="1"]'));
caption('02 / HUMANS', 'Edit it in Studio.');
await page.waitForTimeout(650);
await click(page.locator('#exp-newCheckout'), .7);
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(output, 'studio.png') });
await until(9.0);
await click(page.locator('#studio-save'));
await page.waitForTimeout(600);
await click(page.locator('[data-jp="2"]'));
caption('03 / GIT', 'Every change is a commit.');
await until(13.0);
await click(page.locator('[data-jp="3"]'));
caption('04 / RUNTIME', 'Resolve it. Make it live.');
await until(16.4);
await scrollTo(page.getByRole('heading', { name: 'Every change is a commit, whoever makes it.' }).locator('../..'), 95);
caption('DEVELOPERS + HUMANS + AI', 'Working on the same content.');
await until(21.0);
await page.screenshot({ path: path.join(output, 'final-page.png') });
const manifest = { trimStart: (start - recordingStart) / 1000, duration: elapsed(), clicks, captions, errors };
const video = page.video();
await context.close();
await video.saveAs(path.join(output, 'capture.webm'));
await browser.close();
await writeFile(path.join(output, 'timeline.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
if (errors.length) process.exitCode = 1;
