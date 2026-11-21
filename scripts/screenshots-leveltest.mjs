// Screenshots of the level self-test (难度自测).  Usage: npm run build && node scripts/screenshots-leveltest.mjs
// Writes only screenshots/leveltest-*.png and never deletes anything else in the folder.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const LT = JSON.parse(readFileSync(resolve(ROOT, 'dist/data/leveltest.json'), 'utf8'));
const BAND = new Map([...Object.entries(LT.bands).flatMap(([b, ws]) => ws.map((x) => [x.w, b])), ...LT.pseudo.map((w) => [w, 'pseudo'])]);
const { server, url } = await serve(resolve(ROOT, 'dist'));
const browser = await chromium.launch();
const shots = [];
const shot = async (page, name, full = false) => { await page.screenshot({ path: `${OUT}/${name}`, fullPage: full }); shots.push(name); };
/** answer like a B2 learner: all A2–B2 words, 5/8 C1, 1/8 C2, one pseudo-word "认识"; reading B1 3, B2 2, C1 1 */
async function take(page, { onWord, onPassage } = {}) {
  await page.click('#lt-start');
  const seen = {};
  let pseudoYes = 0;
  for (let i = 0; ; i++) {
    const w = (await page.locator('#lt-word').innerText()).trim();
    const total = Number((await page.locator('#lt-count').innerText()).split('/')[1]);
    if (onWord && i === 5) await onWord();
    const b = BAND.get(w);
    seen[b] = (seen[b] ?? 0) + 1;
    const yes = b === 'pseudo' ? pseudoYes++ < 1 : b === 'C1' ? seen[b] <= 5 : b === 'C2' ? seen[b] <= 1 : true;
    await page.click(yes ? '#lt-yes' : '#lt-no');
    if (i + 1 >= total) break;
    await page.waitForFunction((k) => document.querySelector('#lt-count')?.textContent.startsWith(k + ' /'), i + 2);
  }
  const want = { B1: 3, B2: 2, C1: 1 };
  for (let k = 0; k < 3; k++) {
    await page.waitForFunction((k) => document.querySelector('h1')?.textContent.includes(`（${k + 1} / 3）`), k);
    const id = await page.locator('#lt-passage').getAttribute('data-id');
    const ps = LT.passages.find((x) => x.id === id);
    for (let q = 0; q < 3; q++) {
      const opts = ps.questions[q].options;
      const right = opts[ps.questions[q].answer];
      const pick = q < want[ps.level] ? right : opts.find((o) => o !== right);
      const labels = page.locator(`.lt-q[data-q="${q}"] .lt-opt`);
      const texts = (await labels.allInnerTexts()).map((t) => t.trim());
      await labels.nth(texts.indexOf(pick)).click();
    }
    if (onPassage && k === 0) await onPassage();
    await page.click('#lt-next');
  }
  await page.waitForSelector('#lt-result');
}

for (const [suffix, viewport, mobile] of [['', { width: 1100, height: 820 }, false], ['-mobile', { width: 375, height: 740 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript(() => { if (!localStorage.getItem('ra:v1:settings')) localStorage.setItem('ra:v1:settings', JSON.stringify({ theme: 'light', lastLevel: 'B1' })); });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#level-hint');
  await shot(page, `leveltest-home-hint${suffix}.png`); // gentle hint on the home page (no result yet)
  await page.goto(url + '#/level?seed=2026');
  await page.waitForSelector('#lt-start');
  await shot(page, `leveltest-intro${suffix}.png`);
  await take(page, {
    onWord: () => shot(page, `leveltest-word${suffix}.png`),
    onPassage: () => shot(page, `leveltest-reading${suffix}.png`, !mobile),
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `leveltest-result${suffix}.png`, !mobile);
  if (!mobile) {
    await page.click('#lt-unknown summary');
    await page.locator('#lt-unknown').scrollIntoViewIfNeeded();
    await shot(page, 'leveltest-result-details.png', true);
    // a second (older-looking) result + reading history that triggers an upgrade suggestion
    await page.evaluate(() => {
      const lt = JSON.parse(localStorage.getItem('ra:v1:levelTest'));
      lt.unshift({ ...lt[0], takenAt: lt[0].takenAt - 20 * 864e5, recommended: 'B1', estimate: 'B1', score: 48, vocab: { ...lt[0].vocab, level: 'B1', size: 3900 } });
      localStorage.setItem('ra:v1:levelTest', JSON.stringify(lt));
      const p = {}, v = {};
      for (let i = 1; i <= 9; i++) { const id = `b2-${String(i).padStart(3, '0')}`; p[id] = { status: 'read', scroll: 1, updatedAt: Date.now(), readAt: Date.now() }; for (let k = 0; k < 2; k++) v[`w${i}${k}`] = { addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: {}, ctx: [{ a: id, v: 1, p: 0, s: 'x', form: 'x', at: 1 }] }; }
      localStorage.setItem('ra:v1:progress', JSON.stringify(p));
      localStorage.setItem('ra:v1:vocab', JSON.stringify(v));
    });
    await page.goto(url + '#/level');
    await page.reload();
    await page.waitForSelector('#lt-history');
    await shot(page, 'leveltest-history-suggest.png', true);
    await page.goto(url + '#/');
    await page.waitForSelector('#level-hint');
    await shot(page, 'leveltest-home-upgrade.png');
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log('saved', shots.map((s) => 'screenshots/' + s).join('\n      '));
