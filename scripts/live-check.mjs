// Smoke test against a deployed URL.
// Usage: node scripts/live-check.mjs https://user.github.io/english-reader/ [outPrefix] [classicsOutPrefix]
//   EXPECT_VERSION=0.6.0+abcd1234  require that exact deployed version (e.g. from dist/version.json)
//   PROFILE=/tmp/er-live-profile    reuse a browser profile: run once before the deploy (WARM=1 only caches the old
//                                   version and exits), then again after it to check the update banner + takeover.
import { chromium } from 'playwright';
const url = process.argv[2];
const out = process.argv[3] || 'screenshots/live';
const clOut = process.argv[4] || 'screenshots/live-classics';
let fails = 0, n = 0;
const check = (name, ok, d = '') => { n++; if (!ok) fails++; console.log(`${ok ? '✓' : '✗'} ${name}${d ? '  → ' + d : ''}`); };
const PROFILE = process.env.PROFILE;
const browser = PROFILE ? null : await chromium.launch();
const ctx = PROFILE ? await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1280, height: 800 } }) : await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const swVersion = () => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('english-reader-')).map((k) => k.slice('english-reader-'.length)));
if (PROFILE && process.env.WARM) {
  await page.goto(url);
  await page.waitForSelector('.card-item');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(8000);
  console.log('warmed profile with version', (await swVersion()).join());
  await ctx.close();
  process.exit(0);
}
if (PROFILE) {
  // ---- update flow: the old version controls the page, the new one waits for the banner tap
  await page.goto(url);
  const live = (await (await fetch(new URL('version.json', url), { cache: 'no-store' })).json()).version; // from the server, not the SW cache
  const before = await swVersion();
  if (before.some((v) => v !== live)) { // an older version controls the page (the new one may already be installed and waiting)
    await page.waitForSelector('#update-banner', { timeout: 30000 }).catch(() => {});
    check('update: banner "有新版本，点击刷新" shown, no auto takeover', (await page.locator('#update-banner').count()) === 1 && /有新版本/.test(await page.locator('#update-banner').innerText()), `${before} → ${live}`);
    await page.click('#update-banner .update-go');
    await page.waitForTimeout(4000);
    await page.waitForSelector('.card-item, .article-body .w');
    let after = [];
    for (let i = 0; i < 40; i++) { after = await swVersion(); if (after.join() === live) break; await page.waitForTimeout(250); }
    check('update: tap activates the new version, old cache removed', after.join() === live, `${before} → ${after}`);
  } else {
    check('update: profile had an older cached version to update from', false, `cached ${before.join() || 'none'}, live ${live}`);
  }
}
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
const resp = await page.goto(url);
check('home HTTP 200 over https', resp.status() === 200 && url.startsWith('https://'), String(resp.status()));
await page.waitForSelector('.card-item');
check('B1 list shows 100 articles', (await page.locator('.card-item').count()) === 100, String(await page.locator('.card-item').count()));
await page.screenshot({ path: `${out}-01-list.png` });
await page.goto(url + '#/read/b1-001');
await page.waitForSelector('.article-body .w');
await page.locator('.article-body .w').nth(5).click();
await page.waitForSelector('.card .card-title');
const title = (await page.locator('.card .card-title').innerText()).replace(/\s+/g, ' ').trim();
const cardText = (await page.locator('.card').innerText());
check('tapping a word shows a definition', /[\u4e00-\u9fff]/.test(cardText), title);
await page.screenshot({ path: `${out}-02-popup.png` });
await page.keyboard.press('Escape');
// C1 shard
await page.goto(url + '#/read/c1-001');
await page.waitForSelector('.article-body .w');
await page.locator('.article-body .w').nth(8).click();
await page.waitForSelector('.card .card-title');
check('C1 article word lookup works', /[\u4e00-\u9fff]/.test(await page.locator('.card').innerText()));
await page.keyboard.press('Escape');
// SW
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForSelector('.article-body .w');
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { state: r?.active?.state, scope: r?.scope, controlled: !!navigator.serviceWorker.controller }; });
check('Service Worker active and controlling after reload', sw.state === 'activated' && sw.controlled, JSON.stringify(sw));
const ver = await (await fetch(new URL('version.json', url), { cache: 'no-store' })).json(); // from the server, not the SW cache
const active = await swVersion();
check('Service Worker cache is the deployed version', active.length === 1 && active[0] === ver.version, `${active} vs ${ver.version}`);
check('version.json readable', !!ver.version, JSON.stringify({ version: ver.version, files: ver.files, classics: ver.classics }));
if (process.env.EXPECT_VERSION) check('deployed version is the expected build', ver.version === process.env.EXPECT_VERSION, `${ver.version} vs ${process.env.EXPECT_VERSION}`);
check('version.json lists 100 classics', ver.classics === 100 && (ver.classicsData || []).includes('data/classics/dict.json'));
// wait for precache complete then test offline
await page.waitForTimeout(8000);
await ctx.setOffline(true);
await page.goto(url + '#/read/b2-010');
await page.reload();
await page.waitForSelector('.article-body .w', { timeout: 15000 });
await page.locator('.article-body .w').nth(5).click();
await page.waitForSelector('.card .card-title');
check('offline: reload + article + word lookup work', /[\u4e00-\u9fff]/.test(await page.locator('.card').innerText()));
const cached = await page.evaluate(async () => { const k = (await caches.keys()).find((x) => x.startsWith('english-reader-')); const c = await caches.open(k); return (await c.keys()).map((r) => r.url).filter((u) => u.includes('/data/classics/')).length; });
check('offline: Service Worker precached the classics data', cached >= 33, `${cached} files`);
await page.goto(url + '#/classics');
await page.waitForSelector('.classic-card', { timeout: 15000 });
check('offline: classics list loads', (await page.locator('.classic-card').count()) === 100);
await page.goto(url + '#/classics/cl-015');
await page.waitForSelector('.cl-excerpt-body .w.gl', { timeout: 15000 });
await page.locator('.cl-excerpt-body .w.gl').first().click();
await page.waitForSelector('.card .card-gloss');
check('offline: classic page + gloss + dictionary work', /[\u4e00-\u9fff]/.test(await page.locator('.card .card-gloss').innerText()) && (await page.locator('.card .card-defs').count()) === 1);
await page.screenshot({ path: `${clOut}-04-offline.png` });
await page.keyboard.press('Escape');
await ctx.setOffline(false);
// ---- classics (名著赏析)
await page.goto(url);
await page.waitForSelector('.card-item');
check('nav: 文章 / 名著 / 生词本 / 设置', (await page.locator('.navlinks a').allTextContents()).map((x) => x.trim()).join('|') === '文章|名著|生词本|设置');
await page.click('.navlinks a[data-nav="classics"]');
await page.waitForSelector('.classic-card');
check('classics: 名著 nav opens #/classics with 100 excerpts', page.url().endsWith('#/classics') && (await page.locator('.classic-card').count()) === 100, String(await page.locator('.classic-card').count()));
await page.screenshot({ path: `${clOut}-01-list.png` });
await page.click('.classic-card[data-id="cl-001"]');
await page.waitForSelector('.cl-excerpt-body .w');
check('classics: reader blocks in order', (await page.locator('.classic-reader .cl-h').allTextContents()).join('|') === 'Background|The Excerpt|Notes · 本篇注释|Appreciation|Sentences to imitate');
await page.locator('.cl-excerpt-body .w', { hasText: /^acknowledged$/ }).first().click();
await page.waitForSelector('.card .card-title');
check('classics: tap-to-lookup in the excerpt', /acknowledge/.test(await page.locator('.card .card-title').innerText()) && /[\u4e00-\u9fff]/.test(await page.locator('.card').innerText()));
await page.screenshot({ path: `${clOut}-02-reader.png` });
await page.keyboard.press('Escape');
const attrib = await page.locator('.cl-attrib').innerText();
check('classics: Project Gutenberg attribution on the page', /Project Gutenberg/.test(attrib) && /public domain/.test(attrib) && (await page.locator('.cl-attrib a[href="https://www.gutenberg.org/ebooks/1342"]').count()) === 1);
await page.goto(url + '#/classics/cl-030');
await page.waitForSelector('.cl-excerpt-body .w.gl[data-g="yonder"]');
const yon = page.locator('.cl-excerpt-body .w.gl[data-g="yonder"]').first();
await yon.scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -150));
await yon.click();
await page.waitForSelector('.card .card-gloss');
check('classics: archaic-word gloss (yonder) shown first in the popup', /over there/.test(await page.locator('.card .card-gloss').innerText()));
await page.screenshot({ path: `${clOut}-03-gloss.png` });
await page.keyboard.press('Escape');
// ---- reading history (阅读记录), in a separate clean browser so the checks do not depend on earlier state
{
  const hb = await chromium.launch();
  const hctx = await hb.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const hp = await hctx.newPage();
  hp.on('pageerror', (e) => errors.push(String(e)));
  await hp.goto(url);
  await hp.waitForSelector('.card-item');
  // a 0.5.0-era store: meta schema 1, entries without readAt → migrated on load without loss
  const old = { 'b1-001': { status: 'read', scroll: 1, updatedAt: 1000 }, 'b1-002': { status: 'reading', scroll: 0.9, updatedAt: 2000 }, 'cl-002': { status: 'read', scroll: 1, updatedAt: 3000 } };
  await hp.evaluate((p) => { localStorage.clear(); localStorage.setItem('ra:v1:meta', JSON.stringify({ schema: 1, createdAt: 1 })); localStorage.setItem('ra:v1:progress', JSON.stringify(p)); }, old);
  await hp.reload();
  await hp.waitForSelector('.card-item');
  const mig = await hp.evaluate(() => ({ p: JSON.parse(localStorage.getItem('ra:v1:progress')), m: JSON.parse(localStorage.getItem('ra:v1:meta')) }));
  check('history: old progress migrated without loss (schema 2, readAt added)', mig.m.schema === 2 && Object.keys(old).every((id) => mig.p[id]?.status === old[id].status && mig.p[id].updatedAt === old[id].updatedAt) && mig.p['b1-001'].readAt === 1000, JSON.stringify(mig.m));
  const rows = await hp.locator('.history-summary .hs-row').allInnerTexts();
  check('history: four progress lines B1 / B2 / C1 / 名著', rows.length === 4 && /已读 1 \/ 100/.test(rows[0]) && /名著\s*已读 1 \/ 100/.test(rows[3]), rows.join(' | '));
  await hp.goto(url + '#/read/b1-004');
  await hp.waitForSelector('.article-body .w');
  await hp.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await hp.waitForTimeout(2300);
  check('history: reaching the bottom auto-marks the article read', await hp.evaluate(() => { const p = JSON.parse(localStorage.getItem('ra:v1:progress'))['b1-004']; return p?.status === 'read' && p.readAt > 0; }));
  await hp.goto(url + '#/');
  await hp.waitForSelector('.card-item');
  await hp.click('.tab[data-level="B1"]');
  check('history: read badges + B1 line 2 / 100', (await hp.locator('.card-item .badge-read').count()) === 2 && /已读 2 \/ 100/.test(await hp.locator('.hs-row[data-k="B1"]').innerText()));
  await hp.check('#only-unread');
  check('history: 只看未读 filter', (await hp.locator('.card-item').count()) === 98 && (await hp.locator('.card-item[data-id="b1-004"]').count()) === 0);
  await hp.screenshot({ path: `${out}-history-01-list.png` });
  await hp.goto(url + '#/classics');
  await hp.waitForSelector('.classic-card');
  await hp.check('#cl-only-unread');
  check('history: classics badge + 只看未读', (await hp.locator('.classic-card').count()) === 99);
  await hp.goto(url + '#/settings');
  await hp.waitForSelector('#settings-history .hs-row');
  const [dl] = await Promise.all([hp.waitForEvent('download'), hp.click('#export-btn')]);
  const ex = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
  check('history: export = one JSON, schema 2, reading history + vocab', ex.schema === 2 && ex.app === 'english-reader' && ex.history['b1-004']?.status === 'read' && ex.vocab && typeof ex.vocab === 'object');
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/er-live-old-vocab.json', JSON.stringify({ schema: 1, app: 'english-reader', exportedAt: '2026-01-01T00:00:00.000Z', vocab: { zebra: { addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: { zh: 'n. 斑马' }, ctx: [] } } }));
  await hp.setInputFiles('#import-file', '/tmp/er-live-old-vocab.json');
  await hp.waitForSelector('#import-dialog');
  await hp.click('#import-merge');
  await hp.waitForTimeout(200);
  check('history: old vocab-only file imports by merge, history kept', await hp.evaluate(() => 'zebra' in JSON.parse(localStorage.getItem('ra:v1:vocab')) && JSON.parse(localStorage.getItem('ra:v1:progress'))['b1-004'].status === 'read'));
  await hctx.close();
  await hb.close();
}
// About
await page.goto(url + '#/about');
await page.waitForTimeout(800);
const about = await page.locator('body').innerText();
check('About: Octanove + CC BY-SA 4.0', /Octanove/.test(about) && /CC BY-SA 4\.0/.test(about));
check('About: CEFR-J', /CEFR-J/.test(about));
check('About: ECDICT', /ECDICT/.test(about));
check('About: Project Gutenberg / public-domain credit', /Project Gutenberg/.test(about) && /公有领域/.test(about));
await page.screenshot({ path: `${out}-03-about.png`, fullPage: true });
check('no console/page/HTTP errors', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(`\n${n - fails}/${n} passed`);
await ctx.close();
await browser?.close();
process.exit(fails ? 1 : 0);
