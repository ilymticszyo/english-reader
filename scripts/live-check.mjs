// Smoke test against a deployed URL.
// Usage: node scripts/live-check.mjs https://user.github.io/english-reader/ [outPrefix] [classicsOutPrefix]
//   EXPECT_VERSION=0.4.0+abcd1234  require that exact deployed version (e.g. from dist/version.json)
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
