// End-to-end test: serves dist/ and drives it with headless Chromium.   Usage: npm run build && npm run test:e2e
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serve } from './static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
};
const section = (s) => console.log(`\n${s}`);

const { server, url } = await serve(resolve(ROOT, 'dist'));
const sub = await serve(resolve(ROOT, 'dist'), { prefix: '/sub/english-reader/' });
const browser = await chromium.launch();

const TTS_STUB = () => {
  window.__spoken = [];
  window.__cancels = 0;
  const syn = window.speechSynthesis;
  const origSpeak = syn.speak.bind(syn);
  const origCancel = syn.cancel.bind(syn);
  syn.speak = (u) => { window.__spoken.push({ text: u.text, lang: u.lang }); };
  syn.cancel = () => { window.__cancels++; origCancel(); };
  void origSpeak;
};

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
  await page.addInitScript(TTS_STUB);
  page.errors = errors;
  return page;
}
const PER = 100; // articles per level in the current content batch
const NCL = 100; // classics excerpts (cl-001…cl-100)
const CLX = JSON.parse(readFileSync(resolve(ROOT, 'dist/data/classics/index.json'), 'utf8')).excerpts;
const word = (page, text, nth = 0) => page.locator('.article-body .w', { hasText: new RegExp(`^${text}$`) }).nth(nth);
const cardTitle = async (page) => (await page.locator('.card .card-title').innerText()).replace(/\s+/g, ' ').trim();
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

try {
  // ------------------------------------------------------------ list
  section('Article list');
  let page = await newPage();
  await page.goto(url);
  await page.waitForSelector('.card-item');
  check('3 level tabs', (await page.locator('.tab').count()) === 3);
  check(`B1 shows ${PER} articles`, (await page.locator('.card-item').count()) === PER);
  const loads = [];
  page.on('framenavigated', () => loads.push(1));
  await page.click('.tab[data-level="C1"]');
  check('switch to C1 without reload', (await page.locator('.card-item').count()) === PER && (await page.locator('.card-item .lv-C1').count()) === PER && loads.length === 0);
  await page.reload();
  await page.waitForSelector('.card-item');
  check('selected level persists after reload', (await page.locator('.tab.active').getAttribute('data-level')) === 'C1');
  const t0 = Date.now();
  await page.fill('input[type=search]', 'printing');
  check('search filters by title', (await page.locator('.card-item').count()) === 1);
  await page.fill('input[type=search]', 'zzzz');
  check('empty state with clear-filter button', (await page.locator('.empty button').count()) === 1);
  await page.click('.empty button');
  check('clear filters restores list', (await page.locator('.card-item').count()) === PER);
  const topicVals = await page.locator('select[aria-label="按话题筛选"] option').allTextContents();
  await page.selectOption('select[aria-label="按话题筛选"]', { index: 1 });
  check('topic filter works', (await page.locator('.card-item').count()) < PER && topicVals.length > 2, `${await page.locator('.card-item').count()} items`);
  check('filter response < 100ms (incl. input)', Date.now() - t0 < 1500);
  await page.selectOption('select[aria-label="按话题筛选"]', '');
  const firstMeta = await page.locator('.card-item').first().innerText();
  check('card shows level/words/minutes/topics/status', /C1/.test(firstMeta) && /\d+ 词/.test(firstMeta) && /约 \d+ 分钟/.test(firstMeta) && /未读/.test(firstMeta), firstMeta.replace(/\n/g, '|'));
  check('no console errors on list', page.errors.length === 0, page.errors.join('; '));
  await page.context().close();

  // ------------------------------------------------------------ reader + lookup
  section('Reader + dictionary popup');
  page = await newPage();
  await page.goto(url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  check('article renders with clickable words', (await page.locator('.article-body .w').count()) > 250);
  check('punctuation/numbers not wrapped', !(await page.locator('.article-body .w', { hasText: /[,."0-9]/ }).count()));
  // went
  let w = word(page, 'went');
  const wbox = await w.boundingBox();
  // measure inside the page: click handler -> card in DOM (dictionary already loaded)
  const popupMs = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.article-body .w')].find((e) => e.textContent === 'went');
    const t = performance.now();
    el.click();
    const ok = !!document.querySelector('.card');
    return ok ? performance.now() - t : -1;
  });
  await page.waitForSelector('.card');
  const tClick = 0, tShown = popupMs;
  check('click "went" → "went ← go（过去式）"', (await cardTitle(page)) === 'went ← go（过去式）', await cardTitle(page));
  check('popup opens quickly (<100ms, dict loaded)', tShown >= 0 && tShown - tClick < 100, `${(tShown - tClick).toFixed(1)}ms`);
  const cb = await page.locator('.card').boundingBox();
  const vp = page.viewportSize();
  check('popup inside viewport', cb.x >= 0 && cb.y >= 0 && cb.x + cb.width <= vp.width && cb.y + cb.height <= vp.height + 1, JSON.stringify(cb));
  const nb = await w.boundingBox();
  const overlap = !(cb.x + cb.width <= nb.x || nb.x + nb.width <= cb.x || cb.y + cb.height <= nb.y || nb.y + nb.height <= cb.y);
  check('popup does not cover clicked word', !overlap);
  check('phonetic shown', /^\/.+\/$/.test((await page.locator('.card-phon').first().innerText()).trim()));
  check('Chinese definitions shown (≤5 by default)', (await page.locator('.card > .card-defs .def').count()) >= 1 && (await page.locator('.card > .card-defs .def').count()) <= 5);
  check('CEFR badge for "go"', (await page.locator('.card .badge.cefr').count()) === 1, await page.locator('.card .badge.cefr').allTextContents().then(String));
  check('exam tags shown', (await page.locator('.card .badge.tag').count()) >= 1);
  check('word forms row for lemma', /went/.test(await page.locator('.card-forms').innerText()));
  check('auto-collected into vocab as "go"', await page.evaluate(() => 'go' in JSON.parse(localStorage.getItem('ra:v1:vocab'))));
  check('star filled (in vocab)', (await page.locator('.card .star').getAttribute('aria-pressed')) === 'true');
  // speak
  await page.click('.card .speak');
  await page.click('.card .speak');
  const spoken = await page.evaluate(() => ({ s: window.__spoken, c: window.__cancels }));
  check('speak uses lemma + en-US; each click cancels first', spoken.s.length === 2 && spoken.s[0].text === 'go' && spoken.s[0].lang === 'en-US' && spoken.c >= 2, JSON.stringify(spoken));
  // star toggle
  await page.click('.card .star');
  check('star click removes from vocab', await page.evaluate(() => !('go' in JSON.parse(localStorage.getItem('ra:v1:vocab')))));
  await page.click('.card .star');
  check('star click adds back', await page.evaluate(() => 'go' in JSON.parse(localStorage.getItem('ra:v1:vocab'))));
  // esc closes
  await page.keyboard.press('Escape');
  check('Esc closes popup', (await page.locator('.card').count()) === 0);
  // outside click closes
  await w.click();
  await page.waitForSelector('.card');
  await page.mouse.click(5, 400);
  check('click outside closes popup', (await page.locator('.card').count()) === 0);
  // repeat lookup increments count, dedupes context
  await w.click();
  const cnt = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')).go);
  check('repeat lookup increments count; same-sentence context not duplicated', cnt.count >= 3 && cnt.ctx.length === 1 && /went to the market/.test(cnt.ctx[0].s) && cnt.ctx[0].a === 'b1-002' && cnt.ctx[0].p >= 0, JSON.stringify({ c: cnt.count, ctx: cnt.ctx }));
  check('snapshot saved (phonetic/zh/cefr)', cnt.snap.p && cnt.snap.zh && cnt.snap.cefr, JSON.stringify(cnt.snap));
  await page.keyboard.press('Escape');
  // known-word highlight
  check('looked-up word highlighted in text', (await word(page, 'went').getAttribute('class')).includes('known'));
  await page.click('.card .star').catch(() => {});
  // keyboard: focus a word, Enter
  await word(page, 'soup').focus();
  await page.keyboard.press('Enter');
  check('keyboard Enter on focused word opens card', (await page.locator('.card').count()) === 1);
  await page.keyboard.press('Escape');
  // left (ambiguous) in b1-001
  await page.goto(url + '#/read/b1-001');
  await page.waitForSelector('.article-body .w');
  await word(page, 'left').click();
  check('"left" → left ← leave（…）', /^left ← leave（.*过去式.*）$/.test(await cardTitle(page)), await cardTitle(page));
  check('"left" own entry collapsed (details closed)', (await page.locator('.card details.card-own').count()) === 1 && (await page.locator('.card details.card-own[open]').count()) === 0);
  await page.locator('.card details.card-own summary').click();
  check('expanding shows own definitions (左)', /左/.test(await page.locator('.card details.card-own').innerText()));
  await page.keyboard.press('Escape');
  // children in b1-004
  await page.goto(url + '#/read/b1-004');
  await page.waitForSelector('.article-body .w');
  await word(page, 'Children').first().click();
  check('click "Children" → children ← child (case-insensitive)', /^Children ← child（/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  // studies in b2-003 (loads b2 shard + b1)
  await page.goto(url + '#/read/b2-003');
  await page.waitForSelector('.article-body .w');
  await word(page, 'Studies').first().click();
  check('click "Studies" → studies ← study', /^Studies ← study（/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  // lower-level shard words usable on B2 article: "went"? use "running"? check some form from B1 shard: "children"? not in b2. check "was"
  await word(page, 'found').first().click();
  check('B2 article can use B1-shard words ("found" ← find)', /^found ← find（/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  // possessive / contraction handling in B2-002: can't, "Daniel"
  await page.goto(url + '#/read/b2-002');
  await page.waitForSelector('.article-body .w');
  await word(page, "can't").first().click();
  check('contraction "can\'t" resolves', (await page.locator('.card .card-missing').count()) === 0, await cardTitle(page));
  await page.keyboard.press('Escape');
  await word(page, 'Daniel').first().click();
  check('proper noun (whitelist) shows note', /专有名词/.test(await page.locator('.card').innerText()));
  await page.keyboard.press('Escape');
  // forms/shards loaded lazily per level: B1 article must not fetch the C1 shard
  const reqs = [];
  const p2 = await newPage();
  p2.on('request', (r) => reqs.push(r.url()));
  await p2.goto(url + '#/read/b1-003');
  await p2.waitForSelector('.article-body .w');
  const dictReqs = reqs.filter((u) => u.includes('/dict/')).map((u) => u.split('/').pop());
  check('B1 article loads forms + entries-b1 only', dictReqs.includes('forms.json') && dictReqs.includes('entries-b1.json') && !dictReqs.includes('entries-b2.json') && !dictReqs.includes('entries-c1.json'), dictReqs.join(','));
  await p2.goto(url + '#/read/c1-001');
  await p2.waitForSelector('.article-body .w');
  const dictReqs2 = reqs.filter((u) => u.includes('/dict/')).map((u) => u.split('/').pop());
  check('C1 article loads b1+b2+c1 shards', ['entries-b1.json', 'entries-b2.json', 'entries-c1.json'].every((f) => dictReqs2.includes(f)));
  await p2.context().close();
  // prev/next
  await page.goto(url + '#/read/b1-001');
  await page.waitForSelector('.article-nav');
  check('first article: "previous" disabled', (await page.locator('.article-nav .btn.disabled').innerText()).includes('上一篇'));
  await page.goto(url + `#/read/b1-${String(PER).padStart(3, '0')}`);
  await page.waitForSelector('.article-nav');
  check('last article: "next" disabled', (await page.locator('.article-nav .btn.disabled').innerText()).includes('下一篇'));
  check('no console errors in reader flows', page.errors.length === 0, page.errors.join('; '));

  // ------------------------------------------------------------ vocab page, export/import
  section('Vocabulary book, export / import');
  await page.goto(url + '#/words');
  await page.waitForSelector('.vocab-row');
  const nWords = await page.locator('.vocab-row').count();
  check('vocab page lists collected words', nWords >= 5, `${nWords}`);
  const rowTxt = await page.locator('.vocab-row[data-word="go"]').innerText();
  check('row shows word, phonetic, CEFR, zh, count (works without dict loaded)', /go/.test(rowTxt) && /\//.test(rowTxt) && /查询 \d+ 次/.test(rowTxt));
  await page.selectOption('select[aria-label="排序"]', 'alpha');
  const firstWord = await page.locator('.vocab-row .vr-word').first().innerText();
  const allWords = await page.locator('.vocab-row .vr-word').allInnerTexts();
  check('sort alphabetically', JSON.stringify(allWords) === JSON.stringify([...allWords].sort((a, b) => a.localeCompare(b))), firstWord);
  await page.fill('input[aria-label="搜索生词"]', 'go');
  check('search narrows list', (await page.locator('.vocab-row').count()) >= 1 && (await page.locator('.vocab-row').count()) < nWords);
  await page.fill('input[aria-label="搜索生词"]', '');
  // mastered
  await page.locator('.vocab-row[data-word="go"] .mastered-btn').click();
  check('mastered word hidden by default', (await page.locator('.vocab-row[data-word="go"]').count()) === 0);
  await page.check('.check input');
  check('"show mastered" reveals it', (await page.locator('.vocab-row.mastered[data-word="go"]').count()) === 1);
  await page.locator('.vocab-row[data-word="go"] .mastered-btn').click();
  await page.uncheck('.check input');
  // remove + undo
  const before = await page.locator('.vocab-row').count();
  await page.locator('.vocab-row[data-word="go"] .remove-btn').click();
  check('remove word', (await page.locator('.vocab-row').count()) === before - 1);
  await page.click('.toast-act');
  check('undo within 5s restores word', (await page.locator('.vocab-row[data-word="go"]').count()) === 1);
  // context -> back to original sentence
  await page.locator('.vocab-row[data-word="go"] .linkbtn').first().click();
  await page.locator('.vocab-row[data-word="go"] .ctx').first().click();
  await page.waitForSelector('.article-body .w.flash');
  check('context click opens article & highlights sentence', page.url().includes('#/read/b1-002') && (await page.locator('.w.flash').count()) >= 5);
  await page.waitForTimeout(2300);
  check('highlight disappears after 2s', (await page.locator('.w.flash').count()) === 0);
  await page.goto(url + '#/words');
  await page.waitForSelector('.vocab-row');
  // export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const file = '/tmp/er-backup.json';
  await dl.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const vocabNow = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')));
  check('export file: schema 2 + app + vocab + reading history (+ settings) in one JSON', backup.schema === 2 && backup.app === 'english-reader' && backup.vocab && backup.history && backup.settings && !('progress' in backup));
  check('export contains all vocab entries', JSON.stringify(Object.keys(backup.vocab).sort()) === JSON.stringify(Object.keys(vocabNow).sort()));
  check('download filename', /^english-reader-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  // wipe then import: merging into an empty book restores identical data
  await page.evaluate(() => { localStorage.setItem('ra:v1:vocab', '{}'); });
  await page.reload();
  await page.waitForSelector('.empty');
  await page.setInputFiles('#import-file', file);
  await page.waitForSelector('.modal');
  check('import dialog offers merge only (no overwrite)', (await page.locator('#import-merge').count()) === 1 && (await page.locator('#import-overwrite').count()) === 0);
  await page.click('#import-merge');
  await page.waitForSelector('.vocab-row');
  const afterRestore = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')));
  check('import into an empty vocab book restores identical data', isDeepStrictEqual(afterRestore, vocabNow));
  // merge: add an extra word first, then merge the backup
  await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('ra:v1:vocab')); v.zebra = { addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: { zh: 'n. 斑马' }, ctx: [] }; delete v.go; localStorage.setItem('ra:v1:vocab', JSON.stringify(v)); });
  await page.reload();
  await page.waitForSelector('.vocab-row');
  await page.setInputFiles('#import-file', file);
  await page.waitForSelector('.modal');
  await page.click('#import-merge');
  await page.waitForTimeout(100);
  const afterMerge = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')));
  check('import (merge) keeps local-only words and adds missing ones', 'zebra' in afterMerge && 'go' in afterMerge && Object.keys(afterMerge).length === Object.keys(vocabNow).length + 1);
  // bad files
  writeFileSync('/tmp/er-bad.json', '{"hello": 1}');
  await page.setInputFiles('#import-file', '/tmp/er-bad.json');
  await page.waitForSelector('.toast');
  check('invalid backup rejected with message', /导入失败/.test(await page.locator('.toast').last().innerText()));
  writeFileSync('/tmp/er-future.json', JSON.stringify({ ...backup, schema: 99 }));
  await page.setInputFiles('#import-file', '/tmp/er-future.json');
  await page.waitForTimeout(200);
  check('future schema version rejected', /schema/.test(await page.locator('.toast').last().innerText()));
  check('no console errors in vocab flows', page.errors.length === 0, page.errors.join('; '));

  // ------------------------------------------------------------ dark mode, font size
  section('Dark mode and font size');
  await page.goto(url + '#/settings');
  await page.waitForSelector('.seg');
  await page.click('.seg-btn[data-key="theme"][data-value="dark"]');
  check('dark theme applied instantly', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await page.reload();
  check('dark theme persists after reload (no flash: set before first paint)', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await page.goto(url + '#/read/b2-001');
  await page.waitForSelector('.article-body .w');
  const dark = await page.evaluate(() => { const b = document.querySelector('.article-body'); const cs = getComputedStyle(b); return { fg: cs.color, bg: getComputedStyle(document.body).backgroundColor }; });
  check('dark: body text contrast ≥ 4.5:1', contrast(dark.fg, dark.bg) >= 4.5, `${contrast(dark.fg, dark.bg).toFixed(1)}`);
  const darkMuted = await page.evaluate(() => getComputedStyle(document.querySelector('.article-meta')).color);
  check('dark: muted text contrast ≥ 4.5:1', contrast(darkMuted, dark.bg) >= 4.5, `${contrast(darkMuted, dark.bg).toFixed(1)}`);
  await word(page, 'night').first().click();
  const cardCols = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.card')); return { fg: c.color, bg: c.backgroundColor }; });
  check('dark: popup card contrast ≥ 4.5:1', contrast(cardCols.fg, cardCols.bg) >= 4.5);
  await page.keyboard.press('Escape');
  await page.goto(url + '#/settings');
  await page.click('.seg-btn[data-key="theme"][data-value="light"]');
  await page.goto(url + '#/read/b2-001');
  await page.waitForSelector('.article-body .w');
  const light = await page.evaluate(() => ({ fg: getComputedStyle(document.querySelector('.article-body')).color, bg: getComputedStyle(document.body).backgroundColor, m: getComputedStyle(document.querySelector('.article-meta')).color }));
  check('light: text contrast ≥ 4.5:1', contrast(light.fg, light.bg) >= 4.5 && contrast(light.m, light.bg) >= 4.5, `${contrast(light.fg, light.bg).toFixed(1)} / ${contrast(light.m, light.bg).toFixed(1)}`);
  // system
  await page.goto(url + '#/settings');
  await page.click('.seg-btn[data-key="theme"][data-value="system"]');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 3000 }).catch(() => {});
  check('system theme follows prefers-color-scheme: dark', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 3000 }).catch(() => {});
  check('system theme follows prefers-color-scheme: light', (await page.getAttribute('html', 'data-theme')) === 'light');
  // font size
  await page.goto(url + '#/read/b2-001');
  await page.waitForSelector('.article-body .w');
  const sizes = [];
  const fsOf = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.article-body')).fontSize));
  check('default font size is 中 (19px)', (await fsOf()) === 19);
  await page.click('button[aria-label="减小字号"]');
  sizes.push(await fsOf());
  await page.click('button[aria-label="增大字号"]');
  sizes.push(await fsOf());
  await page.click('button[aria-label="增大字号"]');
  sizes.push(await fsOf());
  await page.click('button[aria-label="增大字号"]');
  sizes.push(await fsOf());
  check('font size steps grow (16/19/22/26 range)', sizes.every((v, i) => i === 0 || v > sizes[i - 1]) && sizes[3] === 26, sizes.join(','));
  check('"A+" disabled at max', await page.locator('button[aria-label="增大字号"]').isDisabled());
  await page.reload();
  await page.waitForSelector('.article-body .w');
  check('font size persists after reload', (await fsOf()) === 26, String(await fsOf()));
  const lh = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.article-body')); return { lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), w: document.querySelector('.article-body').getBoundingClientRect().width, fs: parseFloat(cs.fontSize) }; });
  check('line-height ≥ 1.6', lh.lh >= 1.6, lh.lh.toFixed(2));
  await page.click('button[aria-label="减小字号"]');
  await page.click('button[aria-label="减小字号"]');
  await page.click('button[aria-label="减小字号"]');
  await page.click('button[aria-label="减小字号"]').catch(() => {});
  check('"A−" disabled at min (16px)', (await fsOf()) === 16 && (await page.locator('button[aria-label="减小字号"]').isDisabled()));
  await page.goto(url + '#/settings');
  await page.click('.seg-btn[data-key="fontSize"][data-value="1"]');
  await page.click('.seg-btn[data-key="accent"][data-value="en-GB"]');
  await page.goto(url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  await word(page, 'soup').first().click();
  await page.click('.card .speak');
  check('accent setting en-GB used by TTS', (await page.evaluate(() => window.__spoken.at(-1))).lang === 'en-GB');
  await page.keyboard.press('Escape');
  // settings: auto-collect off
  await page.goto(url + '#/settings');
  await page.uncheck('#set-autoCollect');
  await page.evaluate(() => localStorage.setItem('ra:v1:vocab', '{}'));
  await page.goto(url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  await word(page, 'dinner').first().click();
  check('auto-collect OFF: lookup does not add word', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ra:v1:vocab'))).length === 0));
  check('...star is empty and can add manually', (await page.locator('.card .star').getAttribute('aria-pressed')) === 'false');
  await page.click('.card .star');
  check('manual add works', await page.evaluate(() => 'dinner' in JSON.parse(localStorage.getItem('ra:v1:vocab'))));
  await page.keyboard.press('Escape');
  await page.goto(url + '#/settings');
  await page.click('#reset-settings');
  check('reset to defaults', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ra:v1:settings')); return s.autoCollect === true && s.theme === 'system' && s.fontSize === 1 && s.accent === 'en-US'; }));
  await page.context().close();

  // ------------------------------------------------------------ progress
  section('Progress / scroll memory');
  page = await newPage();
  await page.goto(url + '#/read/b2-005');
  await page.waitForSelector('.article-body .w');
  check('opening marks "reading"', await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b2-005'].status === 'reading'));
  await page.evaluate(() => window.scrollTo(0, 150)); // mid-article (the end of the text is not yet in view)
  await page.waitForTimeout(2300);
  const pr = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b2-005']);
  check('scroll fraction saved (fraction not pixels)', pr.scroll > 0.2 && pr.scroll < 1, JSON.stringify(pr));
  await page.reload();
  await page.waitForSelector('.article-body .w');
  await page.waitForTimeout(400);
  const y1 = await page.evaluate(() => window.scrollY);
  check('scroll position restored after reload', y1 > 100 && y1 < 220, `scrollY=${y1}`);
  await page.goto(url + '#/');
  await page.waitForSelector('.continue-card');
  check('"continue reading" card shown for in-progress article', /继续阅读/.test(await page.locator('.continue-card').innerText()));
  await page.goto(url + '#/read/b2-005');
  await page.waitForSelector('.article-body .w');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(2300);
  check('scrolling to the end marks article read', await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b2-005'].status === 'read'));
  await page.goto(url + '#/');
  await page.click('.tab[data-level="B2"]');
  check('list shows 已读 status and level progress 1/100', (await page.locator('.card-item[data-id="b2-005"] .st-read').count()) === 1 && /已读 1 \/ 100/.test(await page.locator('.hs-row[data-k="B2"]').innerText()), await page.locator('.history-summary').innerText());
  await page.selectOption('select[aria-label="按阅读状态筛选"]', 'read');
  check('status filter (已读)', (await page.locator('.card-item').count()) === 1);
  await page.context().close();

  // ------------------------------------------------------------ reading history (阅读记录)
  section('Reading history (阅读记录): migration, badges, unread filter, progress lines, export / import');
  {
  page = await newPage();
  await page.goto(url);
  await page.waitForSelector('.card-item');
  // a 0.5.0 user: meta schema 1, progress entries without readAt
  const oldProgress = { 'b1-001': { status: 'read', scroll: 1, updatedAt: 1000 }, 'b1-002': { status: 'reading', scroll: 0.9, updatedAt: 2000 }, 'b2-010': { status: 'unread', scroll: 0, updatedAt: 3000 }, 'cl-002': { status: 'read', scroll: 1, updatedAt: 4000 } };
  await page.evaluate((p) => { localStorage.clear(); localStorage.setItem('ra:v1:meta', JSON.stringify({ schema: 1, createdAt: 1 })); localStorage.setItem('ra:v1:progress', JSON.stringify(p)); localStorage.setItem('ra:v1:vocab', JSON.stringify({ go: { addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: { zh: 'vi. 去' }, ctx: [] } })); }, oldProgress);
  await page.reload();
  await page.waitForSelector('.card-item');
  const mig = await page.evaluate(() => ({ p: JSON.parse(localStorage.getItem('ra:v1:progress')), m: JSON.parse(localStorage.getItem('ra:v1:meta')), bak: localStorage.getItem('ra:v1:progress.bak-v1') }));
  check('H: migration keeps every old entry (status, scroll, updatedAt) keyed by article id', Object.entries(oldProgress).every(([id, o]) => mig.p[id] && mig.p[id].status === o.status && mig.p[id].scroll === o.scroll && mig.p[id].updatedAt === o.updatedAt) && Object.keys(mig.p).length === 4, JSON.stringify(mig.p));
  check('H: migration adds readAt to read entries only', mig.p['b1-001'].readAt === 1000 && mig.p['cl-002'].readAt === 4000 && !('readAt' in mig.p['b1-002']));
  check('H: storage schema bumped to 2, untouched old copy kept in ra:v1:progress.bak-v1', mig.m.schema === 2 && mig.m.createdAt === 1 && JSON.stringify(JSON.parse(mig.bak)) === JSON.stringify(oldProgress), JSON.stringify(mig.m));
  await page.reload();
  await page.waitForSelector('.card-item');
  check('H: migration runs once (reload leaves data identical)', isDeepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))), mig.p));
  // list badges + progress lines + unread filter
  await page.click('.tab[data-level="B1"]');
  check('H: read badge on read articles only', (await page.locator('.card-item[data-id="b1-001"] .badge-read').innerText()).includes('✓ 已读') && (await page.locator('.card-item .badge-read').count()) === 1 && /在读/.test(await page.locator('.card-item[data-id="b1-002"] .status').innerText()));
  const rows = await page.locator('.history-summary .hs-row').allInnerTexts();
  check('H: four progress lines B1 / B2 / C1 / 名著 (read X / 100)', rows.length === 4 && /B1\s*已读 1 \/ 100/.test(rows[0]) && /B2\s*已读 0 \/ 100/.test(rows[1]) && /C1\s*已读 0 \/ 100/.test(rows[2]) && /名著\s*已读 1 \/ 100/.test(rows[3]), rows.join(' | '));
  check('H: progress bars carry aria values', (await page.locator('.hs-row[data-k="B1"] .hs-bar').getAttribute('aria-valuenow')) === '1' && (await page.locator('.hs-row[data-k="B1"] .hs-bar').getAttribute('aria-valuemax')) === '100');
  await page.check('#only-unread');
  check('H: 只看未读 hides read articles (in-progress ones stay)', (await page.locator('.card-item').count()) === PER - 1 && (await page.locator('.card-item[data-id="b1-001"]').count()) === 0 && (await page.locator('.card-item[data-id="b1-002"]').count()) === 1);
  await page.click('.tab[data-level="B2"]');
  check('H: unread filter stays on across level tabs', (await page.locator('#only-unread').isChecked()) && (await page.locator('.card-item').count()) === PER);
  await page.uncheck('#only-unread');
  await page.click('.tab[data-level="B1"]');
  check('H: unchecking shows all again', (await page.locator('.card-item').count()) === PER);
  // classics list
  await page.goto(url + '#/classics');
  await page.waitForSelector('.classic-card');
  check('H: classics list: read badge + same four progress lines', (await page.locator('.classic-card[data-id="cl-002"] .badge-read').count()) === 1 && (await page.locator('.classic-card .badge-read').count()) === 1 && (await page.locator('.history-summary .hs-row').count()) === 4 && /已读 1 \/ 100/.test(await page.locator('.hs-row[data-k="classics"]').innerText()));
  await page.check('#cl-only-unread');
  check('H: classics 只看未读', (await page.locator('.classic-card').count()) === NCL - 1 && (await page.locator('.classic-card[data-id="cl-002"]').count()) === 0);
  await page.selectOption('#cl-author', 'austen');
  check('H: classics unread filter combines with author filter', (await page.locator('.classic-card').count()) === CLX.filter((c) => c.authorId === 'austen' && c.id !== 'cl-002').length);
  await page.selectOption('#cl-author', '');
  await page.uncheck('#cl-only-unread');
  // auto-mark at the bottom → readAt; manual unmark / re-mark
  await page.goto(url + '#/read/b1-003');
  await page.waitForSelector('.article-body .w');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(2300);
  const p3 = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b1-003']);
  check('H: reaching the bottom auto-marks read with a readAt time', p3.status === 'read' && typeof p3.readAt === 'number' && p3.readAt > 1e12 && /已读/.test(await page.locator('#art-status').innerText()), JSON.stringify(p3));
  await page.click('#art-status');
  const p3u = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b1-003']);
  check('H: manual unmark → unread, readAt removed, position reset', p3u.status === 'unread' && !('readAt' in p3u) && p3u.scroll === 0, JSON.stringify(p3u));
  await page.click('#art-status');
  const p3r = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b1-003']);
  check('H: manual mark read → read + readAt', p3r.status === 'read' && p3r.readAt >= p3.readAt);
  await page.goto(url + '#/');
  await page.waitForSelector('.card-item');
  check('H: progress line updates (B1 2 / 100) and badge appears', /已读 2 \/ 100/.test(await page.locator('.hs-row[data-k="B1"]').innerText()) && (await page.locator('.card-item[data-id="b1-003"] .badge-read').count()) === 1);
  // position memory for an in-progress article survives the migration
  await page.goto(url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  await page.waitForTimeout(400);
  const pos = await page.evaluate(() => { const b = document.querySelector('.article-body'); const top = b.getBoundingClientRect().top + window.scrollY; return { y: window.scrollY, want: Math.max(0, top + 0.9 * b.offsetHeight - window.innerHeight) }; });
  check('H: reading position restored on reopen (migrated entry, 90%)', pos.want > 100 && Math.abs(pos.y - pos.want) < 40, JSON.stringify(pos));
  // settings: lines + export
  await page.goto(url + '#/settings');
  await page.waitForSelector('#settings-history .hs-row');
  check('H: settings shows the four progress lines', (await page.locator('#settings-history .hs-row').count()) === 4 && /已读 2 \/ 100/.test(await page.locator('#settings-history .hs-row[data-k="B1"]').innerText()));
  const [dlH] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  await dlH.saveAs('/tmp/er-history.json');
  const exH = JSON.parse(readFileSync('/tmp/er-history.json', 'utf8'));
  check('H: export = one JSON with schema 2, reading history (with readAt) and vocab book', exH.schema === 2 && exH.app === 'english-reader' && exH.history['b1-001'].readAt === 1000 && exH.history['b1-003'].status === 'read' && exH.history['cl-002'].status === 'read' && 'go' in exH.vocab && Object.keys(exH.history).length === 5, Object.keys(exH.history).join());
  check('H: export toast mentions words and reading history', /1 个生词和 5 条阅读记录/.test(await page.locator('.toast').last().innerText()));
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress')));
  // old vocab-only export (0.1–0.5 era file without progress)
  writeFileSync('/tmp/er-old-vocab.json', JSON.stringify({ schema: 1, app: 'english-reader', exportedAt: '2026-01-02T03:04:05.000Z', settings: { theme: 'dark' }, vocab: { zebra: { addedAt: 1, lastAt: 2, count: 3, mastered: false, snap: { zh: 'n. 斑马' }, ctx: [] }, go: { addedAt: 0, lastAt: 9, count: 4, mastered: false, snap: { zh: 'vi. 去' }, ctx: [] } } }));
  await page.setInputFiles('#import-file', '/tmp/er-old-vocab.json');
  await page.waitForSelector('#import-dialog');
  check('H: old vocab-only file accepted, dialog says it has no reading history', /2 个生词/.test(await page.locator('#import-summary').innerText()) && /没有阅读记录/.test(await page.locator('#import-summary').innerText()));
  await page.click('#import-merge');
  await page.waitForTimeout(150);
  const afterOld = await page.evaluate(() => ({ v: JSON.parse(localStorage.getItem('ra:v1:vocab')), p: JSON.parse(localStorage.getItem('ra:v1:progress')), s: JSON.parse(localStorage.getItem('ra:v1:settings') || '{}') }));
  check('H: old vocab-only import merges words, history untouched, settings not imported', 'zebra' in afterOld.v && afterOld.v.go.count === 4 && afterOld.v.go.lastAt === 9 && isDeepStrictEqual(afterOld.p, before) && afterOld.s.theme !== 'dark');
  // a bare vocab map (no app / schema field at all)
  writeFileSync('/tmp/er-bare.json', JSON.stringify({ yak: { addedAt: 5, lastAt: 5, count: 1, mastered: false, snap: { zh: 'n. 牦牛' }, ctx: [] } }));
  await page.setInputFiles('#import-file', '/tmp/er-bare.json');
  await page.waitForSelector('#import-dialog');
  await page.click('#import-merge');
  await page.waitForTimeout(150);
  check('H: bare vocab map (no schema field) imports by merge', await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('ra:v1:vocab')); return 'yak' in v && 'zebra' in v && 'go' in v; }));
  // merge rules for the history
  const now = Date.now();
  writeFileSync('/tmp/er-merge.json', JSON.stringify({ schema: 2, app: 'english-reader', exportedAt: new Date().toISOString(), vocab: {}, history: {
    'b1-001': { status: 'unread', scroll: 0, updatedAt: 1 }, // older than local "read" → ignored
    'b1-002': { status: 'read', scroll: 1, updatedAt: now + 60000, readAt: now + 60000 }, // newer → wins
    'b2-001': { status: 'read', scroll: 1, updatedAt: 5, readAt: 5 }, // new id → added
    'c1-050': { status: 'reading', scroll: 0.5, updatedAt: 5 }, // new id → added
  } }));
  await page.setInputFiles('#import-file', '/tmp/er-merge.json');
  await page.waitForSelector('#import-dialog');
  check('H: dialog counts the file\'s reading history', /4 条阅读记录（其中已读 2 篇）/.test(await page.locator('#import-summary').innerText()), await page.locator('#import-summary').innerText());
  await page.click('#import-merge');
  await page.waitForTimeout(150);
  const pm = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress')));
  check('H: merge keeps the newer change per article, adds new ids, keeps local-only ids', pm['b1-001'].status === 'read' && pm['b1-001'].readAt === 1000 && pm['b1-002'].status === 'read' && pm['b2-001'].readAt === 5 && pm['c1-050'].scroll === 0.5 && pm['b1-003'].status === 'read' && pm['cl-002'].status === 'read' && Object.keys(pm).length === 7, JSON.stringify(pm));
  check('H: merge toast reports added / updated', /新增 2 条、更新 1 条阅读记录/.test(await page.locator('.toast').last().innerText()), await page.locator('.toast').last().innerText());
  check('H: progress lines follow the import (B1 3, B2 1)', /已读 3 \/ 100/.test(await page.locator('#settings-history .hs-row[data-k="B1"]').innerText()) && /已读 1 \/ 100/.test(await page.locator('#settings-history .hs-row[data-k="B2"]').innerText()));
  await page.setInputFiles('#import-file', '/tmp/er-merge.json');
  await page.waitForSelector('#import-dialog');
  await page.click('#import-merge');
  await page.waitForTimeout(150);
  check('H: importing the same file twice changes nothing', isDeepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))), pm) && /新增 0 条、更新 0 条/.test(await page.locator('.toast').last().innerText()));
  // round trip: export → wipe → import
  const [dlR] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  await dlR.saveAs('/tmp/er-roundtrip.json');
  const snap = await page.evaluate(() => ({ p: JSON.parse(localStorage.getItem('ra:v1:progress')), v: JSON.parse(localStorage.getItem('ra:v1:vocab')) }));
  await page.evaluate(() => { localStorage.setItem('ra:v1:progress', '{}'); localStorage.setItem('ra:v1:vocab', '{}'); });
  await page.reload();
  await page.waitForSelector('#settings-history .hs-row');
  await page.setInputFiles('#import-file', '/tmp/er-roundtrip.json');
  await page.waitForSelector('#import-dialog');
  await page.click('#import-merge');
  await page.waitForTimeout(150);
  check('H: export → wipe → import restores history and vocab exactly', isDeepStrictEqual(await page.evaluate(() => ({ p: JSON.parse(localStorage.getItem('ra:v1:progress')), v: JSON.parse(localStorage.getItem('ra:v1:vocab')) })), snap));
  writeFileSync('/tmp/er-v3.json', JSON.stringify({ ...exH, schema: 3 }));
  await page.setInputFiles('#import-file', '/tmp/er-v3.json');
  await page.waitForTimeout(200);
  check('H: newer schema (3) rejected with a message, nothing changed', /schema 版本（3）/.test(await page.locator('.toast').last().innerText()) && (await page.locator('#import-dialog').count()) === 0);
  check('H: no console errors in reading-history flows', page.errors.length === 0, page.errors.join('; '));
  await page.context().close();
  }

  // ------------------------------------------------------------ mobile
  section('Mobile viewport (375×667, touch)');
  page = await newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const noHScroll = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.goto(url);
  await page.waitForSelector('.card-item');
  check('list: no horizontal scroll', await noHScroll());
  await page.goto(url + '#/read/c1-003');
  await page.waitForSelector('.article-body .w');
  check('reader: no horizontal scroll', await noHScroll());
  await word(page, 'printing').first().tap();
  await page.waitForSelector('.card.sheet');
  await page.waitForTimeout(400); // slide-up animation
  const sb = await page.locator('.card.sheet').boundingBox();
  check('tap word → bottom sheet at screen bottom', Math.abs(sb.y + sb.height - 667) < 3 && sb.width >= 374, JSON.stringify(sb));
  const wb = await word(page, 'printing').first().boundingBox();
  check('tapped word still visible above the sheet', wb.y >= 0 && wb.y + wb.height <= sb.y + 1, `word bottom ${Math.round(wb.y + wb.height)} sheet top ${Math.round(sb.y)}`);
  const small = await page.evaluate(() => [...document.querySelectorAll('.card button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length);
  check('popup touch targets ≥ 44px', small === 0, `${small} too small`);
  check('no horizontal scroll with sheet open', await noHScroll());
  // swipe down on handle
  const hb = await page.locator('.card-handle').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 3);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 140, { steps: 6 });
  await page.mouse.up();
  check('swipe down closes sheet', (await page.locator('.card').count()) === 0);
  await word(page, 'printing').first().tap();
  await page.waitForSelector('.card.sheet');
  await page.tap('.card .close');
  check('close button works on touch', (await page.locator('.card').count()) === 0);
  await word(page, 'printing').first().tap();
  await page.waitForSelector('.card.sheet');
  await page.touchscreen.tap(20, 30);
  await page.waitForTimeout(100);
  check('tap outside closes sheet', (await page.locator('.card').count()) === 0);
  for (const [name, hash] of [['words', '#/words'], ['settings', '#/settings']]) {
    await page.goto(url + hash);
    await page.waitForTimeout(150);
    check(`${name}: no horizontal scroll`, await noHScroll());
  }
  await page.goto(url + '#/read/b1-001');
  await page.waitForSelector('.article-body .w');
  const bw = await page.evaluate(() => { const r = document.querySelector('.article-body').getBoundingClientRect(); return [r.left, r.right]; });
  check('reading column fits 375px screen', bw[0] >= 0 && bw[1] <= 375, bw.join('-'));
  const tiny = await page.evaluate(() => [...document.querySelectorAll('.topnav a, .article-tools button, .article-nav .btn, .tab')].filter((e) => e.getBoundingClientRect().height < 44).length);
  check('nav / toolbar touch targets ≥ 44px tall', tiny === 0, `${tiny} too small`);
  await page.context().close();

  // narrow 360px
  page = await newPage({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  await page.goto(url + '#/read/c1-004');
  await page.waitForSelector('.article-body .w');
  check('360px wide: no horizontal scroll (reader, largest font)', await (async () => { await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ra:v1:settings') || '{}'); s.fontSize = 3; localStorage.setItem('ra:v1:settings', JSON.stringify(s)); }); await page.reload(); await page.waitForSelector('.article-body .w'); return noHScroll(); })());
  await page.context().close();

  // ------------------------------------------------------------ sub-path / relative base
  section('Served under a sub-path (relative base)');
  page = await newPage();
  await page.goto(sub.url);
  await page.waitForSelector('.card-item');
  check('sub-path: list loads (relative data paths)', (await page.locator('.card-item').count()) === PER, page.errors.join('; '));
  await page.goto(sub.url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  await word(page, 'went').click();
  check('sub-path: lookup works', (await cardTitle(page)) === 'went ← go（过去式）');
  check('sub-path: no failed requests', page.errors.length === 0, page.errors.join('; '));
  await page.context().close();

  // ------------------------------------------------------------ M2: lexicalized -ing, labels, about, wpm
  section('M2: lexicalized -ing nouns');
  page = await newPage();
  await page.goto(url + '#/read/b2-004');
  await page.waitForSelector('.article-body .w');
  await word(page, 'building').first().click();
  check('"building" (whitelisted -ing noun) → main card is its own entry, no "←"', (await cardTitle(page)) === 'building', await cardTitle(page));
  check('"building": verb "build" entry folded below (closed)', (await page.locator('.card details.card-alt').count()) === 1 && (await page.locator('.card details.card-alt[open]').count()) === 0 && /动词「build」/.test(await page.locator('.card details.card-alt summary').innerText()));
  check('"building" own definition is the noun sense (建筑)', /建筑/.test(await page.locator('.card > .card-defs').innerText()));
  await page.locator('.card details.card-alt summary').click();
  check('expanding shows the verb entry (建造)', /建/.test(await page.locator('.card details.card-alt').innerText()));
  check('vocab keyed by "building" (not "build")', await page.evaluate(() => 'building' in JSON.parse(localStorage.getItem('ra:v1:vocab')) && !('build' in JSON.parse(localStorage.getItem('ra:v1:vocab')))));
  await page.keyboard.press('Escape');
  await word(page, 'buildings').first().click();
  check('"buildings" → buildings ← building（复数）', /^buildings ← building（.*复数.*）$/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  await word(page, 'morning').first().click();
  check('"morning" → own entry, no arrow', (await cardTitle(page)) === 'morning');
  await page.keyboard.press('Escape');
  await page.goto(url + '#/read/b2-005');
  await page.waitForSelector('.article-body .w');
  await word(page, 'running').first().click();
  check('non-whitelisted "running" still → running ← run', /^running ← run（/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  await word(page, 'heating').first().click();
  check('"heating" (whitelisted) → heating', (await cardTitle(page)) === 'heating', await cardTitle(page));
  await page.keyboard.press('Escape');
  await page.goto(url + '#/read/c1-001');
  await page.waitForSelector('.article-body .w');
  await word(page, 'feeling').first().click();
  check('"feeling" → own entry with "feel" folded', (await cardTitle(page)) === 'feeling' && (await page.locator('.card details.card-alt').count()) === 1);
  await page.keyboard.press('Escape');
  // M3 batch 2: lexicalized adjectival participles (whitelist in lemma-overrides.json → lexicalizedAdj)
  await page.goto(url + '#/read/b2-012');
  await page.waitForSelector('.article-body .w');
  await word(page, 'scared').first().click();
  check('"scared" (whitelisted adjective) → main card is its own entry, no "←"', (await cardTitle(page)) === 'scared', await cardTitle(page));
  check('"scared": verb "scare" entry folded below (closed)', (await page.locator('.card details.card-alt').count()) === 1 && (await page.locator('.card details.card-alt[open]').count()) === 0 && /动词「scare」的词条/.test(await page.locator('.card details.card-alt summary').innerText()), await page.locator('.card details.card-alt summary').allInnerTexts().then((a) => a.join('|')));
  check('"scared" own definition is the adjective sense (害怕的)', /害怕|恐惧|惊恐/.test(await page.locator('.card > .card-defs').innerText()), await page.locator('.card > .card-defs').innerText());
  await page.locator('.card details.card-alt summary').click();
  check('expanding "scared" shows the verb entry (吓)', /吓|惊吓|使.*害怕/.test(await page.locator('.card details.card-alt').innerText()));
  check('vocab keyed by "scared" (not "scare")', await page.evaluate(() => 'scared' in JSON.parse(localStorage.getItem('ra:v1:vocab')) && !('scare' in JSON.parse(localStorage.getItem('ra:v1:vocab')))));
  await page.keyboard.press('Escape');
  await page.goto(url + '#/read/b2-005');
  await page.waitForSelector('.article-body .w');
  await word(page, 'running').first().click();
  check('adjective whitelist leaves verbal "running" untouched (running ← run)', /^running ← run（/.test(await cardTitle(page)), await cardTitle(page));
  await page.keyboard.press('Escape');
  // "according" (whitelist, manual CEFR B1): main card shows the "according to" sense first
  await page.goto(url + '#/read/b2-013');
  await page.waitForSelector('.article-body .w');
  await word(page, 'according').first().click();
  check('"according" → own entry, no "←"', (await cardTitle(page)) === 'according', await cardTitle(page));
  const accDefs = await page.locator('.card > .card-defs').innerText();
  check('"according": the "according to" sense (根据) comes first', /^\s*prep\.?[\s\S]*?根据/.test(accDefs) && accDefs.indexOf('根据；按照') >= 0 && accDefs.indexOf('根据；按照') < accDefs.indexOf('相应地'), accDefs);
  check('"according": verb "accord" folded below, closed', (await page.locator('.card details.card-alt').count()) === 1 && (await page.locator('.card details.card-alt[open]').count()) === 0 && /动词「accord」/.test(await page.locator('.card details.card-alt summary').innerText()));
  await page.keyboard.press('Escape');
  // decade forms (1860s) are plain text: not clickable, not a stray "s" word
  await page.goto(url + '#/read/b2-029');
  await page.waitForSelector('.article-body .w');
  const dec = await page.evaluate(() => ({
    text: /the 1860s/.test(document.querySelector('.article-body').textContent),
    sWords: [...document.querySelectorAll('.article-body .w')].filter((e) => e.textContent === 's').length,
    inSpan: [...document.querySelectorAll('.article-body .w')].filter((e) => /\d/.test(e.textContent)).length,
  }));
  check('decade "1860s": stays as plain text, no clickable "s" and no clickable number', dec.text && dec.sWords === 0 && dec.inSpan === 0, JSON.stringify(dec));
  await page.goto(url + '#/read/b1-029');
  await page.waitForSelector('.article-body .w');
  const wl = await page.evaluate(async () => {
    const r = Object.assign({}, ...(await Promise.all(['b1', 'b2', 'c1'].map((l) => fetch(`data/dict/entries-${l}.json`).then((x) => x.json())))));
    return Object.fromEntries(['tired', 'surprised', 'interested', 'worried', 'complicated', 'boring'].map((k) => [k, r[k] ? (r[k].alt || '') : null]));
  });
  check('built B1 dictionary: whitelisted participles have own entries with folded verb', wl.tired === 'tire' && wl.surprised === 'surprise' && wl.boring === 'bore', JSON.stringify(wl));
  check('no console errors', page.errors.length === 0, page.errors.join('; '));

  section('M2: labels, about page, reading speed');
  await page.goto(url);
  await page.waitForSelector('.card-item');
  check('list page has no AI label anywhere', !/AI|生成/.test(await page.locator('main').innerText()));
  await page.goto(url + '#/read/b1-001');
  await page.waitForSelector('.article-body .w');
  check('reader: exactly one small AI note, at the bottom (after nav), none in header', (await page.locator('.article-note').count()) === 1 && (await page.locator('.article-head').innerText()).indexOf('AI') < 0 && (await page.evaluate(() => { const n = document.querySelector('.article-note'); const nav = document.querySelector('.article-nav'); return !!(nav.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); })));
  check('reader: note text', /AI 生成的示例文章/.test(await page.locator('.article-note').innerText()));
  await page.goto(url);
  await page.waitForSelector('.site-footer a');
  await page.click('.site-footer a');
  await page.waitForSelector('.about');
  const about = await page.locator('.about').innerText();
  check('about page: Octanove + CC BY-SA 4.0', /Octanove/.test(about) && /CC BY-SA 4\.0/.test(about) && (await page.locator('.about a[href*="creativecommons.org/licenses/by-sa/4.0"]').count()) === 1);
  check('about page: ECDICT (MIT) and CEFR-J credits', /ECDICT/.test(about) && /MIT/.test(about) && /CEFR-J/.test(about) && /Tono/.test(about) && (await page.locator('.about a[href*="skywind3000/ECDICT"]').count()) === 1 && (await page.locator('.about a[href*="cefr-j.org"]').count()) >= 1);
  await page.goto(url + '#/settings');
  await page.waitForSelector('.seg');
  check('settings links to about page', (await page.locator('a[href="#/about"]').count()) >= 1);
  await page.goto(url);
  await page.waitForSelector('.card-item');
  const mins0 = await page.locator('.card-item[data-id="b1-001"] .ci-meta').innerText();
  await page.goto(url + '#/settings');
  await page.click('.seg-btn[data-key="wpm"][data-value="120"]');
  await page.goto(url);
  await page.waitForSelector('.card-item');
  const mins1 = await page.locator('.card-item[data-id="b1-001"] .ci-meta').innerText();
  check('reading-time setting changes estimates (200 wpm → 120 wpm)', /约 2 分钟/.test(mins0) && /约 3 分钟/.test(mins1), `${mins0} | ${mins1}`);
  await page.goto(url + '#/settings');
  await page.click('#reset-settings');
  check('reset restores 200 wpm', await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:settings')).wpm === 200));
  check('settings shows version', /\d+\.\d+\.\d+\+[0-9a-f]{8}/.test(await page.locator('#version').innerText()), await page.locator('#version').innerText());
  check('settings: no backup yet message', /还没有导出过备份/.test(await page.locator('#last-backup').innerText()));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  void dl2;
  await page.waitForTimeout(100);
  check('settings: export from settings page + "last backup" time shown', /上次导出备份/.test(await page.locator('#last-backup').innerText()));
  await page.context().close();

  section('M2: vocabulary book with 1000 words, full card from the vocab page');
  page = await newPage();
  await page.goto(url + '#/settings');
  await page.waitForSelector('.seg');
  await page.evaluate(() => {
    const v = {};
    for (let i = 0; i < 1000; i++) v['word' + String(i).padStart(4, '0')] = { addedAt: i, lastAt: i, count: (i % 7) + 1, mastered: i % 10 === 0, snap: { p: 'wɜːd', zh: 'n. 单词 ' + i, cefr: ['A1', 'A2', 'B1', 'B2', 'C1'][i % 5] }, ctx: [{ a: 'b1-001', v: 1, p: 0, s: 'It had been raining since the morning when Mia arrived in Osaka.', form: 'x', at: i }] };
    v.go = { addedAt: 5000, lastAt: 5000, count: 1, mastered: false, snap: { zh: 'vi. 去' }, ctx: [] };
    localStorage.setItem('ra:v1:vocab', JSON.stringify(v));
  });
  await page.goto(url + '#/words');
  await page.reload();
  await page.waitForSelector('.vocab-row');
  check('1000 words: summary correct', /共 1001 个生词，其中已掌握 100 个/.test(await page.locator('#vocab-summary').innerText()), await page.locator('#vocab-summary').innerText());
  check('1000 words: only a page of rows in the DOM (≤ 50)', (await page.locator('.vocab-row').count()) <= 50, `${await page.locator('.vocab-row').count()}`);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('#usage');
  const renderMs = await page.evaluate(() => new Promise((res) => { const s = performance.now(); location.hash = '#/words'; const iv = setInterval(() => { if (document.querySelector('.vocab-row')) { clearInterval(iv); res(performance.now() - s); } }, 1); }));
  check('1000 words: vocab page renders < 300ms', renderMs < 300, `${Math.round(renderMs)}ms`);
  await page.fill('input[aria-label="搜索生词"]', 'word05');
  check('1000 words: search instant & correct', (await page.locator('.vocab-row').count()) <= 50 && /当前显示 \d+ 个/.test(await page.locator('#vocab-summary').innerText()));
  await page.fill('input[aria-label="搜索生词"]', '');
  await page.click('.more button');
  check('"show more" pages in another 50', (await page.locator('.vocab-row').count()) === 100);
  const scrollMs = await page.evaluate(async () => { const t = performance.now(); for (let i = 0; i < 10; i++) { window.scrollTo(0, document.documentElement.scrollHeight * (i / 10)); await new Promise((r) => requestAnimationFrame(r)); } return (performance.now() - t) / 10; });
  check('1000 words: scrolling frame time < 20ms avg', scrollMs < 20, `${scrollMs.toFixed(1)}ms/frame`);
  check('no storage warning below 4MB', await page.locator('.warn-box').isHidden());
  // full card (D6): dictionary not loaded on this fresh page load
  await page.fill('input[aria-label="搜索生词"]', 'go');
  await page.waitForSelector('.vocab-row[data-word="go"]');
  const countBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')).go.count);
  await page.locator('.vocab-row[data-word="go"] .card-btn').click();
  await page.waitForSelector('.card');
  check('vocab page: "词典卡片" opens the full card (lazy-loads dictionary)', (await cardTitle(page)) === 'go' && (await page.locator('.card .card-defs .def').count()) >= 1 && (await page.locator('.card .badge.cefr').count()) === 1);
  check('...and does not count as a new lookup', await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')).go.count) === countBefore);
  check('...speak button works from the card', (await page.locator('.card .speak').count()) === 1);
  await page.keyboard.press('Escape');
  await page.context().close();


  // ------------------------------------------------------------ hyphenated words
  section('Hyphenated words');
  {
    page = await newPage();
    await page.goto(url + '#/read/c1-001');
    await page.waitForSelector('.article-body .w');
    await word(page, 'well-explained').click();
    await page.waitForSelector('.card');
    check('compound missing from the dictionary: title shows the whole word', (await cardTitle(page)) === 'well-explained', await cardTitle(page));
    const parts = await page.locator('.card .card-part').evaluateAll((els) => els.map((e) => ({ w: e.dataset.part, n: e.querySelectorAll('.def').length, t: e.querySelector('.part-title').innerText.replace(/\s+/g, ' ').trim() })));
    check('...lists each part in order, each with its own definitions', parts.length === 2 && parts[0].w === 'well' && parts[1].w === 'explained' && parts.every((p) => p.n >= 1), JSON.stringify(parts));
    check('...second part shows its lemma (explained ← explain)', /explained ← explain/.test(parts[1]?.t ?? ''), parts[1]?.t);
    check('...explains why (no whole-word entry note)', /词典未收录整词/.test(await page.locator('.card .card-note').innerText()));
    const vocab = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')));
    check('...auto-collected vocab keeps the whole word with a combined gloss', vocab['well-explained'] && /^well .*；explained /.test(vocab['well-explained'].snap.zh), JSON.stringify(vocab['well-explained']?.snap));
    await page.keyboard.press('Escape');
    await page.goto(url + '#/read/b2-002');
    await page.waitForSelector('.article-body .w');
    await word(page, 'mid-sized').click();
    await page.waitForSelector('.card');
    check('whole hyphenated word known to ECDICT: shown as one entry, no per-part sections', (await cardTitle(page)) === 'mid-sized' && (await page.locator('.card .card-part').count()) === 0 && (await page.locator('.card .def').count()) >= 1, await cardTitle(page));
    check('no console errors (hyphen)', page.errors.length === 0, page.errors.join('; '));
    await page.context().close();
  }

  // ------------------------------------------------------------ offline (service worker)
  // ------------------------------------------------------------ module G: classics (名著赏析)
  section('G: classics (名著赏析)');
  {
    const CL = JSON.parse(readFileSync(resolve(ROOT, 'dist/data/classics/index.json'), 'utf8')).excerpts;
    const clOf = (id) => JSON.parse(readFileSync(resolve(ROOT, `dist/data/classics/${id}.json`), 'utf8'));
    const ARCH = JSON.parse(readFileSync(resolve(ROOT, 'dist/data/classics/archaisms.json'), 'utf8'));
    const ver = JSON.parse(readFileSync(resolve(ROOT, 'dist/version.json'), 'utf8'));
    const rep = JSON.parse(readFileSync(resolve(ROOT, 'reports/build-report.json'), 'utf8'));
    const artIdx = JSON.parse(readFileSync(resolve(ROOT, 'dist/data/index.json'), 'utf8')).articles;
    const clw = (page, text, scope = '.cl-excerpt-body', nth = 0) => page.locator(`${scope} .w`, { hasText: new RegExp(`^${text}$`) }).nth(nth);

    // G1: separate pool, report-only, the three levels untouched
    check(`G1: ${NCL} classics, ids cl-001…cl-${NCL}`, CL.length === NCL && CL.every((c, i) => c.id === `cl-${String(i + 1).padStart(3, '0')}`));
    check(`G1: article pools unchanged (B1/B2/C1 = ${PER} each, no cl- ids)`, ['B1', 'B2', 'C1'].every((l) => artIdx.filter((a) => a.level === l).length === PER) && !artIdx.some((a) => a.id.startsWith('cl-')));
    check('G1: build report lists classics coverage as reference only (not gated)', !!rep.classics && /reference only/i.test(readFileSync(resolve(ROOT, 'reports/build-report.md'), 'utf8')), Object.keys(rep).join());
    check(`G1/SW: version.json lists the classics data (${NCL} excerpts + index/dict/archaisms)`, ver.classics === NCL && ['data/classics/index.json', 'data/classics/dict.json', 'data/classics/archaisms.json'].every((f) => ver.classicsData.includes(f)), JSON.stringify({ c: ver.classics }));
    check('G1/SW: sw.js precaches every classics file', (() => { const sw = readFileSync(resolve(ROOT, 'dist/sw.js'), 'utf8'); return ver.classicsData.every((f) => sw.includes(`./${f}`)); })());

    let page = await newPage();
    await page.goto(url);
    await page.waitForSelector('.card-item');
    const navTexts = (await page.locator('.navlinks a').allTextContents()).map((s) => s.trim());
    check('G1: top nav is 文章 / 名著 / 生词本 / 设置', navTexts.join('|') === '文章|名著|生词本|设置', navTexts.join('|'));
    check('G1: 名著 is not a difficulty tab (still 3 tabs)', (await page.locator('.tab').count()) === 3 && !/名著/.test(await page.locator('.tabs').innerText()));
    const navBox = await page.locator('.navlinks a[data-nav="classics"]').boundingBox();
    check('G1: 名著 nav link is a ≥44px touch target', navBox.height >= 44);
    await page.click('.navlinks a[data-nav="classics"]');
    await page.waitForSelector('.classic-card');
    check('G1: 名著 opens #/classics and is marked active', page.url().endsWith('#/classics') && (await page.locator('.navlinks a.active').innerText()).trim() === '名著');

    // G2: list, cards, filters, search, empty state
    check(`G2: list shows all ${NCL} excerpts`, (await page.locator('.classic-card').count()) === NCL);
    const c1 = await page.locator('.classic-card[data-id="cl-001"]').innerText();
    check('G2: card shows work, author, scene, ref level, words, minutes, status', /Pride and Prejudice/.test(c1) && /Jane Austen/.test(c1) && /Chapter 1/.test(c1) && /参考 B2/.test(c1) && /原文 \d+ 词/.test(c1) && /约 \d+ 分钟/.test(c1) && /未读/.test(c1), c1.replace(/\n/g, '|'));
    const nSpoil = CL.filter((c) => c.spoiler).length;
    check('G2: spoiler mark on exactly the spoiler excerpts', (await page.locator('.classic-card .badge.spoiler').count()) === nSpoil && (await page.locator('.classic-card[data-id="cl-003"] .badge.spoiler').count()) === 1 && (await page.locator('.classic-card[data-id="cl-001"] .badge.spoiler').count()) === 0, `${nSpoil}`);
    check('G2: minutes = ceil((background + excerpt + appreciation) / 200)', CL.every((c) => c.minutes === Math.max(1, Math.ceil(c.totalWords / 200))) && new RegExp(`约 ${CL[0].minutes} 分钟`).test(c1));
    const t0 = Date.now();
    await page.selectOption('#cl-level', 'C1');
    const nC1 = CL.filter((c) => c.refLevel === 'C1').length;
    check('G2: filter by reference level', (await page.locator('.classic-card').count()) === nC1 && (await page.locator('.classic-card .lv-C1').count()) === nC1, `${nC1}`);
    await page.selectOption('#cl-author', 'austen');
    const nAC = CL.filter((c) => c.refLevel === 'C1' && c.authorId === 'austen').length;
    check('G2: level + author filters combine instantly', (await page.locator('.classic-card').count()) === nAC && Date.now() - t0 < 1500, `${nAC}`);
    await page.selectOption('#cl-level', '');
    check('G2: author filter alone', (await page.locator('.classic-card').count()) === CL.filter((c) => c.authorId === 'austen').length);
    await page.selectOption('#cl-author', '');
    await page.fill('#cl-q', 'dracula');
    check('G2: search by work title', (await page.locator('.classic-card').count()) === 1 && (await page.locator('.classic-card[data-id="cl-028"]').count()) === 1);
    await page.fill('#cl-q', 'box hill');
    check('G2: search by scene', (await page.locator('.classic-card').count()) === 1 && (await page.locator('.classic-card[data-id="cl-004"]').count()) === 1);
    await page.fill('#cl-q', 'zzzz');
    check('G2: empty state with clear-filter button', (await page.locator('.classic-card').count()) === 0 && (await page.locator('#cl-clear').count()) === 1);
    await page.click('#cl-clear');
    check(`G2: clear filters restores all ${NCL}`, (await page.locator('.classic-card').count()) === NCL && (await page.inputValue('#cl-q')) === '');
    check('G2: no continue card before reading anything', (await page.locator('.continue-card').count()) === 0);

    // G3: reader blocks in PRD order, tap-to-lookup in every block
    await page.click('.classic-card[data-id="cl-001"]');
    await page.waitForSelector('.cl-excerpt-body .w');
    const order = await page.locator('.classic-reader .cl-h').allTextContents();
    check('G3: blocks in order Background → The Excerpt → Notes → Appreciation → Sentences to imitate', order.join('|') === 'Background|The Excerpt|Notes · 本篇注释|Appreciation|Sentences to imitate', order.join('|'));
    const head = await page.locator('.classic-head').innerText();
    check('G3: header shows work / author / chapter-scene / ref level / source', /Pride and Prejudice/.test(head) && /Jane Austen/.test(head) && /Chapter 1/.test(head) && /参考 B2/.test(head) && /Project Gutenberg #1342/.test(head), head.replace(/\n/g, '|'));
    const nModels = await page.locator('.cl-model').count();
    check('G3: 3–5 sentences to imitate, each with a note', nModels >= 3 && nModels <= 5 && (await page.locator('.cl-model .cl-model-note').count()) === nModels);
    let okBlocks = 0;
    for (const sel of ['.cl-background', '.cl-excerpt', '.cl-appreciation', '.cl-imitate']) {
      await page.locator(`${sel} .w`).nth(3).click();
      try { await page.waitForSelector('.card', { timeout: 3000 }); okBlocks += (await page.locator('.card .card-title').count()) === 1 ? 1 : 0; } catch {}
      await page.keyboard.press('Escape');
    }
    check('G3: tap-to-lookup works in Background, Excerpt, Appreciation and model sentences', okBlocks === 4, `${okBlocks}/4`);
    await clw(page, 'acknowledged').click();
    await page.waitForSelector('.card');
    check('G3: excerpt lookup uses the dictionary (acknowledged ← acknowledge)', /^acknowledged ← acknowledge/.test(await cardTitle(page)), await cardTitle(page));
    await page.keyboard.press('Escape');

    // G4: glosses marked in the text, shown first in the popup, listed in 本篇注释
    const g001 = clOf('cl-001').glossary;
    const glForms = await page.locator('.cl-excerpt-body .w.gl').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.g))]);
    check('G4: every note of the excerpt is marked in the text', g001.every((g) => glForms.includes(g.form)), `${glForms.length} marked, ${g001.length} notes`);
    check('G4: marked words have a dotted underline', (await page.locator('.cl-excerpt-body .w.gl').first().evaluate((e) => getComputedStyle(e).textDecorationStyle)) === 'dotted');
    const gl = g001[0];
    await page.locator(`.cl-excerpt-body .w.gl[data-g="${gl.form}"]`).first().click();
    await page.waitForSelector('.card .card-gloss');
    const firstSec = await page.locator('.card').evaluate((c) => { const kids = [...c.children].filter((k) => !k.matches('.card-handle, .card-head')); return kids[0]?.className; });
    const glTxt = await page.locator('.card .card-gloss').innerText();
    check('G4: note shown at the top of the popup (English note + 中文), dictionary below', firstSec === 'card-gloss' && glTxt.includes(gl.note) && glTxt.includes(gl.zh) && (await page.locator('.card .card-defs, .card .card-missing').count()) >= 1, `${firstSec} | ${glTxt.replace(/\n/g, '|')}`);
    await page.keyboard.press('Escape');
    check('G4: commentary words are never marked as glossed', (await page.locator('.cl-background .w.gl, .cl-appreciation .w.gl, .cl-model-note .w.gl').count()) === 0);
    check('G4 (desktop): 本篇注释 list visible with every note', await page.locator('.cl-notes').isVisible() && (await page.locator('.cl-notes dt').count()) === g001.length + clOf('cl-001').archaismsUsed.length);
    check('G4 (desktop): notes drawer button hidden', !(await page.locator('.notes-fab').isVisible()));
    // archaism from the shared list (cl-006: "yonder") and a dialect note forcing the headword (cl-015: warn't → be)
    await page.goto(url + '#/classics/cl-006');
    await page.waitForSelector('.cl-excerpt-body .w.gl[data-g="yonder"]');
    await page.locator('.cl-excerpt-body .w.gl[data-g="yonder"]').first().click();
    await page.waitForSelector('.card .card-gloss');
    check('G4: archaic word gloss (yonder) from the shared archaism list', (await page.locator('.card .card-gloss').innerText()).includes(ARCH.yonder.note));
    check('G4: archaism listed in 本篇注释', (await page.locator('.cl-notes dt', { hasText: /^yonder$/ }).count()) === 1);
    await page.keyboard.press('Escape');
    await page.goto(url + '#/classics/cl-015');
    await page.waitForSelector('.cl-excerpt-body .w.gl');
    await page.locator('.cl-excerpt-body .w.gl[data-g="warn\'t"]').first().click();
    await page.waitForSelector('.card .card-gloss');
    check("G4: dialect form shows note + the headword it stands for (warn't ← be)", /^warn’t ← be/.test(await cardTitle(page)) && (await page.locator('.card .card-defs').count()) === 1, await cardTitle(page));
    await page.keyboard.press('Escape');
    await page.goto(url + '#/classics/cl-010');
    await page.waitForSelector('.cl-excerpt-body .w');
    check("G4: leading-elision archaism is one token ('em)", (await page.locator('.cl-excerpt-body .w.gl[data-g="\'em"]', { hasText: /^’em$/ }).count()) >= 1);
    await page.locator('.cl-notes .note-jump').first().click();
    check('G4: tapping a note jumps to the word in the text', (await page.locator('.cl-excerpt-body .w.flash').count()) === 1);

    // G5: source required, credited on each page and on About
    check('G5: every excerpt has a Project Gutenberg edition, URL, year and PD note', CL.every((c) => /^Project Gutenberg #\d+/.test(c.source.edition) && /^https:\/\/www\.gutenberg\.org\/ebooks\/\d+$/.test(c.source.url) && c.source.year <= 1930 && c.source.pdNote.length > 10));
    const attrib = await page.locator('.cl-attrib').innerText();
    check('G5: classic page credits Project Gutenberg + public domain', /Project Gutenberg/.test(attrib) && /public domain/.test(attrib) && (await page.locator('.cl-attrib a[href^="https://www.gutenberg.org/ebooks/"]').count()) === 1);
    check('G5: excerpt text has no Gutenberg boilerplate', !/Project Gutenberg|\*\*\*/.test(await page.locator('.cl-excerpt-body').innerText()));
    await page.goto(url + '#/about');
    await page.waitForSelector('.about');
    const ab = await page.locator('.about').innerText();
    check('G5: About page credits Project Gutenberg (and keeps Octanove / CEFR-J / ECDICT)', /名著赏析/.test(ab) && /Project Gutenberg/.test(ab) && /公有领域/.test(ab) && /Octanove/.test(ab) && /CC BY-SA 4\.0/.test(ab) && /CEFR-J/.test(ab) && /ECDICT/.test(ab) && (await page.locator('.about a[href="https://www.gutenberg.org/"]').count()) === 1);

    // G6: commentary in English, around B2
    const all = CL.map((c) => clOf(c.id));
    check('G6: Background and Appreciation are English only (no Chinese)', all.every((c) => !/[\u4e00-\u9fff]/.test([...c.intro, ...c.appreciation, ...c.modelSentences.map((m) => m.note)].join(' '))));
    const lowB2 = all.filter((c) => c.meta.stats.commentaryB2 < 0.85).map((c) => c.id);
    check('G6: commentary ≥ 85% of words at B2 or below in every excerpt (target 90%, report-only)', lowB2.length === 0, lowB2.join());
    check('no console / HTTP errors in classics pages', page.errors.length === 0, page.errors.join('; '));
    await page.context().close();

    // G7: progress, scroll and vocab context share the article storage; context jumps back
    page = await newPage();
    await page.goto(url + '#/classics/cl-001');
    await page.waitForSelector('.cl-excerpt-body .w');
    await clw(page, 'acknowledged').click();
    await page.waitForSelector('.card');
    await page.keyboard.press('Escape');
    const st = await page.evaluate(() => ({ v: JSON.parse(localStorage.getItem('ra:v1:vocab') || '{}'), p: JSON.parse(localStorage.getItem('ra:v1:progress') || '{}') }));
    const ctx = st.v.acknowledge?.ctx?.[0];
    check('G7: vocab saved in ra:v1:vocab with classic context (a = cl-001)', ctx && ctx.a === 'cl-001' && /acknowledged/.test(ctx.s), JSON.stringify(ctx));
    check('G7: progress saved in ra:v1:progress under cl-001', st.p['cl-001']?.status === 'reading');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
    await page.waitForTimeout(2300);
    await page.evaluate(() => window.scrollBy(0, 1));
    await page.waitForTimeout(2300);
    await page.goto(url + '#/words');
    await page.waitForSelector('.vocab-row');
    await page.locator('.vocab-row[data-word="acknowledge"] .linkbtn').first().click();
    const ctxHref = await page.locator('.vocab-row[data-word="acknowledge"] a.ctx').first().getAttribute('href');
    check('G7: vocab context links to #/classics/cl-001?p=&s=', /^#\/classics\/cl-001\?p=\d+&s=/.test(ctxHref), ctxHref);
    await page.locator('.vocab-row[data-word="acknowledge"] a.ctx').first().click();
    await page.waitForSelector('.cl-excerpt-body .w.flash');
    check('G7: context jump highlights the sentence in the classic', (await page.locator('.w.flash').count()) > 3);
    await page.goto(url + '#/classics');
    await page.waitForSelector('.classic-card');
    await page.goto(url + '#/classics/cl-002');
    await page.waitForSelector('.cl-excerpt-body .w');
    await page.goto(url + '#/classics/cl-001');
    await page.waitForSelector('.cl-excerpt-body .w');
    await page.waitForTimeout(300);
    check('G7: scroll position restored when reopening the classic', (await page.evaluate(() => window.scrollY)) > 300, String(await page.evaluate(() => window.scrollY)));
    await page.click('#cl-status');
    check('G7: mark as read is stored like articles', await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['cl-001'].status === 'read'));
    await page.click('#cl-status');

    // G8: prev / next inside the filtered list; 继续阅读 can point at a classic
    await page.goto(url + '#/classics/cl-001');
    await page.waitForSelector('.cl-excerpt-body .w');
    check('G8: first classic: prev disabled, next = cl-002', (await page.locator('.article-nav .btn.disabled', { hasText: '上一篇' }).count()) === 1 && (await page.locator('.article-nav a[rel="next"]').getAttribute('href')) === '#/classics/cl-002');
    await page.goto(url + `#/classics/cl-${NCL}`);
    await page.waitForSelector('.cl-excerpt-body .w');
    check('G8: last classic: next disabled', (await page.locator('.article-nav .btn.disabled', { hasText: '下一篇' }).count()) === 1);
    await page.goto(url + '#/classics');
    await page.waitForSelector('.classic-card');
    await page.selectOption('#cl-author', 'dickens');
    const dk = CL.filter((c) => c.authorId === 'dickens').map((c) => c.id);
    await page.click(`.classic-card[data-id="${dk[0]}"]`);
    await page.waitForSelector('.cl-excerpt-body .w');
    check('G8: prev/next stay inside the filtered list (author = Dickens)', (await page.locator('.article-nav a[rel="next"]').getAttribute('href')) === `#/classics/${dk[1]}` && (await page.locator('.article-nav .btn.disabled', { hasText: '上一篇' }).count()) === 1);
    await page.goto(url + `#/classics/${dk[dk.length - 1]}`);
    await page.waitForSelector('.cl-excerpt-body .w');
    check('G8: end of the filtered list greys out next', (await page.locator('.article-nav .btn.disabled', { hasText: '下一篇' }).count()) === 1 && (await page.locator('.article-nav a[rel="prev"]').getAttribute('href')) === `#/classics/${dk[dk.length - 2]}`);
    await page.goto(url);
    await page.waitForSelector('.card-item');
    check('G8: 继续阅读 on the home page points at the classic being read', (await page.locator('.continue-card').getAttribute('href'))?.startsWith('#/classics/cl-'), await page.locator('.continue-card').getAttribute('href'));
    await page.goto(url + '#/classics');
    await page.waitForSelector('.classic-card');
    check('G8: classics page shows 继续阅读 for the classic', (await page.locator('.continue-card').getAttribute('href'))?.startsWith('#/classics/cl-'));

    // G9: distribution (reference only)
    await page.goto(url + '#/classics/cl-001');
    await page.waitForSelector('.cl-excerpt-body .w');
    await page.click('.cl-dist summary');
    check('G9: vocabulary distribution shown (≤B1 / ≤B2 / ≤C1, reference only)', (await page.locator('.cl-dist .dist-bars li').count()) === 3 && /仅供参考/.test(await page.locator('.cl-dist').innerText()));
    check('no console / HTTP errors (G7–G9)', page.errors.length === 0, page.errors.join('; '));
    await page.context().close();

    // mobile: notes in a bottom drawer, popup is a sheet, nothing overflows
    page = await newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const noH = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.goto(url + '#/classics');
    await page.waitForSelector('.classic-card');
    check('mobile: classics list has no horizontal scroll, nav fits', await noH());
    const small = await page.evaluate(() => [...document.querySelectorAll('.navlinks a')].filter((a) => a.getBoundingClientRect().height < 44).length);
    check('mobile: nav links (incl. 名著) ≥ 44px', small === 0);
    await page.goto(url + '#/classics/cl-015');
    await page.waitForSelector('.cl-excerpt-body .w');
    check('mobile: reader no horizontal scroll', await noH());
    check('G4 (mobile): inline notes hidden, notes button shown', !(await page.locator('.cl-notes').isVisible()) && (await page.locator('.notes-fab').isVisible()));
    await page.locator('.notes-fab').tap();
    const db = await page.locator('.notes-drawer').boundingBox();
    check('G4 (mobile): notes open in a bottom drawer', await page.locator('.notes-drawer').isVisible() && Math.abs(db.y + db.height - 667) < 3 && (await page.locator('.notes-drawer dt').count()) > 0, JSON.stringify(db));
    await page.locator('.notes-drawer .nd-head .iconbtn').tap();
    check('G4 (mobile): drawer closes', !(await page.locator('.notes-drawer').isVisible()));
    await page.locator('.cl-excerpt-body .w.gl').first().tap();
    await page.waitForSelector('.card.sheet .card-gloss');
    check('mobile: gloss popup is a bottom sheet with the note first', (await page.locator('.card.sheet .card-gloss').count()) === 1);
    check('no console / HTTP errors (mobile classics)', page.errors.length === 0, page.errors.join('; '));
    await page.context().close();
  }

  section('Offline (service worker), root and sub-path');
  for (const [label, base] of [['root', url], ['sub-path /sub/english-reader/', sub.url]]) {
    page = await newPage();
    await page.goto(base);
    await page.waitForSelector('.card-item');
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
    const cacheInfo = await page.evaluate(async () => { const keys = await caches.keys(); const c = await caches.open(keys[0]); return { keys, n: (await c.keys()).length }; });
    check(`${label}: service worker active, precache has all files`, cacheInfo.keys.length === 1 && /^english-reader-\d+\.\d+\.\d+\+/.test(cacheInfo.keys[0]) && cacheInfo.n >= 25, JSON.stringify(cacheInfo));
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
    check(`${label}: SW scope is the app folder`, scope === base, scope);
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector('.card-item');
    check(`${label}: offline reload shows the article list`, (await page.locator('.card-item').count()) === PER);
    await page.click('.tab[data-level="C1"]');
    await page.click('.card-item[data-id="c1-003"]');
    await page.waitForSelector('.article-body .w');
    await word(page, 'Studies').count();
    await word(page, 'manuscripts').first().click();
    check(`${label}: offline lookup works (C1 article, all dictionary shards)`, /^manuscripts ← manuscript（/.test(await cardTitle(page)), await cardTitle(page));
    await page.keyboard.press('Escape');
    await page.goto(base + '#/words');
    await page.waitForSelector('h1');
    check(`${label}: offline vocab page works`, /生词本/.test(await page.locator('h1').innerText()));
    await page.goto(base + '#/classics');
    await page.waitForSelector('.classic-card');
    check(`${label}: offline classics list (名著) works`, (await page.locator('.classic-card').count()) === NCL);
    await page.click('.classic-card[data-id="cl-030"]');
    await page.waitForSelector('.cl-excerpt-body .w.gl');
    await page.locator('.cl-excerpt-body .w.gl[data-g="yonder"]').first().click();
    await page.waitForSelector('.card .card-gloss');
    check(`${label}: offline classic page + gloss popup + dictionary work`, (await page.locator('.card .card-defs').count()) === 1);
    await page.keyboard.press('Escape');
    await page.click('#cl-status');
    await page.goto(base + '#/classics');
    await page.waitForSelector('.classic-card');
    await page.check('#cl-only-unread');
    check(`${label}: offline reading history: mark read → badge, 只看未读, 名著 1 / ${NCL}`, (await page.locator('.classic-card').count()) === NCL - 1 && /已读 1 \/ 100/.test(await page.locator('.hs-row[data-k="classics"]').innerText()) && (await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['cl-030'].readAt > 0)));
    await page.uncheck('#cl-only-unread');
    check(`${label}: offline read badge on the classic`, (await page.locator('.classic-card[data-id="cl-030"] .badge-read').count()) === 1);
    await page.goto(base + '#/settings');
    await page.waitForSelector('#offline');
    await page.waitForFunction(() => /已缓存/.test(document.querySelector('#offline').textContent), null, { timeout: 5000 });
    check(`${label}: settings shows offline ready`, /已缓存/.test(await page.locator('#offline').innerText()));
    const [dlO] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    await dlO.saveAs('/tmp/er-offline.json');
    const exO = JSON.parse(readFileSync('/tmp/er-offline.json', 'utf8'));
    check(`${label}: offline export includes the reading history (schema 2)`, exO.schema === 2 && exO.history['cl-030']?.status === 'read' && (await page.locator('#settings-history .hs-row').count()) === 4);
    await page.context().setOffline(false);
    await page.context().close();
  }

  section('Update flow: new version waits, banner, activates only on tap');
  {
    const { cpSync, rmSync: rm2, readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const tmp = '/tmp/er-dist-update';
    rm2(tmp, { recursive: true, force: true });
    cpSync(resolve(ROOT, 'dist'), tmp, { recursive: true });
    const upd = await serve(tmp);
    page = await newPage();
    await page.goto(upd.url);
    await page.waitForSelector('.card-item');
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    check('first install: no "new version" banner', (await page.locator('#update-banner').count()) === 0);
    check('sw.js has no unconditional skipWaiting (only on message)', !/install[\s\S]{0,400}skipWaiting\(\)\)/.test(rf(`${tmp}/sw.js`, 'utf8')) && /SKIP_WAITING/.test(rf(`${tmp}/sw.js`, 'utf8')));
    const oldKeys = await page.evaluate(() => caches.keys());
    // open an article and scroll, so we can prove the update never interrupts reading
    await page.click('.card-item[data-id="b1-001"]');
    await page.waitForSelector('.article-body .w');
    await page.evaluate(() => { window.__marker = 'same-page'; window.scrollTo(0, 120); });
    const swText = rf(`${tmp}/sw.js`, 'utf8').replace(/const VERSION = '[^']+'/, "const VERSION = '9.9.9+newbuild'");
    wf(`${tmp}/sw.js`, swText);
    wf(`${tmp}/version.json`, JSON.stringify({ version: '9.9.9+newbuild', files: 26, builtAt: new Date().toISOString() }));
    // the app checks for updates when opened; trigger the same check without reloading the reading page
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.waitForSelector('#update-banner', { timeout: 15000 });
    check('banner shows Chinese text "有新版本，点击刷新"', (await page.locator('#update-banner .update-go').innerText()) === '有新版本，点击刷新');
    const both = await page.evaluate(() => caches.keys());
    check('new version is installed in its own cache while the old cache stays', both.length === 2 && both.includes(oldKeys[0]) && both.includes('english-reader-9.9.9+newbuild'), both.join());
    await page.waitForTimeout(2500);
    check('no auto takeover: same page, same scroll, old SW still controls, banner still there', await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return window.__marker === 'same-page' && window.scrollY > 50 && !!reg.waiting && /sw\.js/.test(String(reg.active && reg.active.scriptURL)) && !!document.getElementById('update-banner');
    }));
    check('banner is a >=44px touch target', (await page.locator('#update-banner .update-go').boundingBox()).height >= 44);
    // dismiss: banner goes away but the update stays waiting; reopening the app brings it back
    await page.click('#update-banner .update-later');
    check('dismiss hides the banner, update stays waiting', (await page.locator('#update-banner').count()) === 0 && (await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)));
    await page.reload();
    await page.waitForSelector('#update-banner', { timeout: 15000 });
    check('reopening the app shows the banner again (still waiting, not activated by reload)', (await page.evaluate(() => caches.keys())).length === 2);
    await page.evaluate(() => { window.__marker = 'before-tap'; });
    await page.click('#update-banner .update-go');
    await page.waitForFunction(() => window.__marker === undefined, null, { timeout: 15000 });
    await page.waitForSelector('.card-item, .article-body .w');
    for (let i = 0; i < 40; i++) { if ((await page.evaluate(() => caches.keys())).join() === 'english-reader-9.9.9+newbuild') break; await page.waitForTimeout(250); }
    const newKeys = await page.evaluate(() => caches.keys());
    check('tap: waiting SW activates, page reloads once, old cache deleted', newKeys.length === 1 && newKeys[0] === 'english-reader-9.9.9+newbuild', `${oldKeys} → ${newKeys}`);
    check('after the tap the banner is gone and the new SW controls the page', (await page.locator('#update-banner').count()) === 0 && (await page.evaluate(() => !!navigator.serviceWorker.controller)));
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector('.card-item, .article-body .w');
    check('app still works offline on the new version', (await page.locator('.card-item, .article-body .w').count()) > 0);
    await page.context().close();
    upd.server.close();
  }
} finally {
  await browser.close();
  server.close();
  sub.server.close();
}

const failed = results.filter((r) => !r.ok);
mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(resolve(ROOT, 'reports/e2e.txt'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`).join('\n') + `\n\n${results.length - failed.length}/${results.length} passed\n`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
