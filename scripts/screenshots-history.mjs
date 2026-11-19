// Screenshots of the reading history (阅读记录).  Usage: npm run build && node scripts/screenshots-history.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const { server, url } = await serve(resolve(ROOT, 'dist'));
const browser = await chromium.launch();
const T = Date.parse('2026-11-19T10:00:00Z');
const seed = {};
const read = (id, d) => (seed[id] = { status: 'read', scroll: 1, updatedAt: T - d * 864e5, readAt: T - d * 864e5 });
['b1-001', 'b1-003', 'b1-004', 'b1-007', 'b1-010', 'b1-012', 'b2-001', 'b2-002', 'b2-005', 'c1-003', 'cl-001', 'cl-004', 'cl-031', 'cl-032'].forEach((id, i) => read(id, i));
seed['b1-002'] = { status: 'reading', scroll: 0.6, updatedAt: T };
const vocab = { go: { addedAt: T, lastAt: T, count: 2, mastered: false, snap: { zh: 'vi. 去' }, ctx: [] } };
const init = (s) => { if (!localStorage.getItem('ra:v1:meta')) { localStorage.setItem('ra:v1:meta', JSON.stringify({ schema: 2, createdAt: 1 })); localStorage.setItem('ra:v1:progress', JSON.stringify(s.p)); localStorage.setItem('ra:v1:vocab', JSON.stringify(s.v)); } };

for (const [name, viewport, mobile] of [['', { width: 1280, height: 860 }, false], ['-mobile', { width: 375, height: 760 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript(init, { p: seed, v: vocab });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.card-item');
  await page.click('.tab[data-level="B1"]');
  await page.screenshot({ path: `${OUT}/history-list${name}.png` }); // read badges + four progress lines
  await page.check('#only-unread');
  await page.screenshot({ path: `${OUT}/history-list-unread${name}.png` });
  await page.uncheck('#only-unread');
  if (!mobile) {
    await page.locator('.history-summary').screenshot({ path: `${OUT}/history-progress.png` });
    await page.goto(url + '#/classics');
    await page.waitForSelector('.classic-card');
    await page.screenshot({ path: `${OUT}/history-classics.png` });
  }
  await page.goto(url + '#/settings');
  await page.waitForSelector('#settings-history .hs-row');
  await page.locator('#settings-history').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.screenshot({ path: `${OUT}/history-settings${name}.png` });
  if (!mobile) {
    writeFileSync('/tmp/er-shot-import.json', JSON.stringify({ schema: 2, app: 'english-reader', exportedAt: '2026-11-18T12:00:00.000Z', history: { 'b1-020': { status: 'read', scroll: 1, updatedAt: T, readAt: T }, 'c1-010': { status: 'reading', scroll: 0.3, updatedAt: T } }, vocab: { zebra: { addedAt: T, lastAt: T, count: 1, mastered: false, snap: { zh: 'n. 斑马' }, ctx: [] } } }));
    await page.setInputFiles('#import-file', '/tmp/er-shot-import.json');
    await page.waitForSelector('#import-dialog');
    await page.screenshot({ path: `${OUT}/history-import.png` });
    await page.click('#import-cancel');
    writeFileSync('/tmp/er-shot-old.json', JSON.stringify({ schema: 1, app: 'english-reader', exportedAt: '2026-03-01T00:00:00.000Z', vocab: { zebra: { addedAt: T, lastAt: T, count: 1, mastered: false, snap: { zh: 'n. 斑马' }, ctx: [] } } }));
    await page.setInputFiles('#import-file', '/tmp/er-shot-old.json');
    await page.waitForSelector('#import-dialog');
    await page.screenshot({ path: `${OUT}/history-import-old.png` });
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log('history screenshots saved to', OUT);
