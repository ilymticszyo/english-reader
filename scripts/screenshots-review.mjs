// Screenshots of the vocabulary review (生词复习).  Usage: npm run build && node scripts/screenshots-review.mjs
// Writes only screenshots/review-*.png and never deletes anything else in the folder.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const { server, url } = await serve(resolve(ROOT, 'dist'));
const browser = await chromium.launch();
const day = (off) => { const d = new Date(Date.now() + off * 864e5); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const cx = (a, p, s, form) => ({ a, v: 1, p, s, form, at: 1 });
const W = (o) => ({ addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: {}, ctx: [], ...o });
const vocab = {
  market: W({ addedAt: 1, count: 3, snap: { p: "'mɑ:kit", zh: 'n. 市场, 集市', cefr: 'A1' }, ctx: [cx('b1-002', 1, 'On Saturday morning I went to the market.', 'market')] }),
  manuscript: W({ addedAt: 2, snap: { zh: 'n. 手稿', cefr: 'C1' }, ctx: [cx('c1-003', 0, 'Printing did not instantly replace manuscripts, nor did it immediately make books affordable to ordinary people.', 'manuscripts'), cx('c1-003', 1, 'As a result, two manuscripts of the same work could differ significantly, and scholars had to travel considerable distances to compare versions.', 'manuscripts')] }),
  yonder: W({ addedAt: 3, snap: { zh: 'adv. 那边' }, ctx: [cx('cl-030', 3, 'Nothing will content them but the extremest limit of the land; loitering under the shady lee of yonder warehouses will not suffice.', 'yonder')] }),
  soup: W({ addedAt: 4, snap: { zh: 'n. 汤', cefr: 'A1' }, ctx: [cx('b1-002', 4, 'The soup was a bit too salty, but everyone said it was good.', 'soup')] }),
  salty: W({ addedAt: 5, snap: { zh: 'a. 咸的', cefr: 'B1' }, ctx: [cx('b1-002', 4, 'The soup was a bit too salty, but everyone said it was good.', 'salty')] }),
  affordable: W({ addedAt: 6, snap: { zh: 'a. 买得起的', cefr: 'B2' }, ctx: [cx('c1-003', 0, 'Printing did not instantly replace manuscripts, nor did it immediately make books affordable to ordinary people.', 'affordable')] }),
};
const rec = (due, interval, reps) => ({ due, interval, ease: 2.5, reps, lapses: 0, lastGrade: 2, updatedAt: Date.now() - 864e5, firstDay: day(-10) });
const review = { manuscript: rec(day(-1), 3, 2), market: rec(day(0), 1, 1), yonder: rec(day(5), 6, 2) };
const progress = { 'b1-002': { status: 'read', scroll: 1, updatedAt: Date.now(), readAt: Date.now() } };
const init = (s) => { if (!localStorage.getItem('ra:v1:meta')) { localStorage.setItem('ra:v1:meta', JSON.stringify({ schema: 3, createdAt: 1 })); localStorage.setItem('ra:v1:settings', JSON.stringify({ theme: 'light', lastLevel: 'B1' })); localStorage.setItem('ra:v1:progress', JSON.stringify(s.p)); localStorage.setItem('ra:v1:vocab', JSON.stringify(s.v)); localStorage.setItem('ra:v1:review', JSON.stringify(s.r)); } };
const shots = [];
const shot = async (target, name) => { await target.screenshot({ path: `${OUT}/${name}` }); shots.push(name); };

for (const [suffix, viewport, mobile] of [['', { width: 1100, height: 820 }, false], ['-mobile', { width: 375, height: 740 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, acceptDownloads: true });
  await ctx.addInitScript(init, { p: progress, v: vocab, r: review });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#due-home');
  await shot(page, `review-home-due${suffix}.png`); // 「今日待复习 N 个」 on the home page
  await page.goto(url + '#/review');
  await page.waitForSelector('.rv-card');
  await shot(page, `review-front${suffix}.png`);
  await page.click('#rv-flip');
  await page.waitForFunction(() => !/词典加载中/.test(document.querySelector('.rv-defs').textContent));
  if (!mobile) await page.locator('.rv-more summary').click().catch(() => {});
  await shot(page, `review-back${suffix}.png`);
  if (!mobile) {
    await page.goto(url + '#/words');
    await page.waitForSelector('#due-words');
    await shot(page, 'review-words-due.png');
    await page.goto(url + '#/review?pool=B1');
    await page.reload();
    await page.waitForSelector('.rv-card');
    await page.selectOption('#rv-article', 'b1-002');
    await shot(page, 'review-filters.png');
    await page.goto(url + '#/review?pool=C1&cefr=A1');
    await page.reload();
    await page.waitForSelector('#rv-done');
    await shot(page, 'review-filters-empty.png');
    // finish a session → done screen
    await page.goto(url + '#/review');
    await page.reload();
    await page.waitForSelector('.rv-card');
    for (let i = 0; i < 20 && (await page.locator('.rv-card').count()); i++) { await page.keyboard.press('Space'); await page.keyboard.press(i === 1 ? '1' : '3'); }
    await page.waitForSelector('#rv-done');
    await shot(page, 'review-done.png');
    // export (schema 3) + the file it produced
    await page.goto(url + '#/words');
    await page.waitForSelector('#export-btn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    await dl.saveAs('/tmp/er-shot-review-export.json');
    await page.waitForSelector('.toast');
    await shot(page, 'review-export.png');
    const json = JSON.parse(readFileSync('/tmp/er-shot-review-export.json', 'utf8'));
    const p2 = await ctx.newPage();
    const brief = { ...json, history: { 'b1-002': json.history['b1-002'] }, vocab: { market: json.vocab.market, '…': `（共 ${Object.keys(json.vocab).length} 个生词）` } };
    await p2.setContent(`<meta charset="utf-8"><body style="margin:0;font:13px/1.45 ui-monospace,Menlo,monospace;background:#fbfaf7;color:#1d1f23"><div style="padding:10px 16px;font:600 14px system-ui;background:#e4eefb;color:#1f5fbf">${dl.suggestedFilename()} — schema ${json.schema}</div><pre style="padding:12px 16px;margin:0;white-space:pre-wrap">${JSON.stringify(brief, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body>`);
    await shot(p2, 'review-export-json.png');
    await p2.close();
    await page.setInputFiles('#import-file', '/tmp/er-shot-review-export.json');
    await page.waitForSelector('#import-dialog');
    await shot(page, 'review-import.png');
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log(`review screenshots saved to ${OUT}:\n  ${shots.join('\n  ')}`);
