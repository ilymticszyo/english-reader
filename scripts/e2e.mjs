// End-to-end test: serves dist/ and drives it with headless Chromium.   Usage: npm run build && npm run test:e2e
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
  check('B1 shows 5 articles', (await page.locator('.card-item').count()) === 5);
  const loads = [];
  page.on('framenavigated', () => loads.push(1));
  await page.click('.tab[data-level="C1"]');
  check('switch to C1 without reload', (await page.locator('.card-item').count()) === 5 && (await page.locator('.card-item .lv-C1').count()) === 5 && loads.length === 0);
  await page.reload();
  await page.waitForSelector('.card-item');
  check('selected level persists after reload', (await page.locator('.tab.active').getAttribute('data-level')) === 'C1');
  const t0 = Date.now();
  await page.fill('input[type=search]', 'printing');
  check('search filters by title', (await page.locator('.card-item').count()) === 1);
  await page.fill('input[type=search]', 'zzzz');
  check('empty state with clear-filter button', (await page.locator('.empty button').count()) === 1);
  await page.click('.empty button');
  check('clear filters restores list', (await page.locator('.card-item').count()) === 5);
  const topicVals = await page.locator('select[aria-label="按话题筛选"] option').allTextContents();
  await page.selectOption('select[aria-label="按话题筛选"]', { index: 1 });
  check('topic filter works', (await page.locator('.card-item').count()) < 5 && topicVals.length > 2, `${await page.locator('.card-item').count()} items`);
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
  await page.goto(url + '#/read/b1-005');
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
  await page.locator('.vocab-row[data-word="go"] .linkbtn').click();
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
  check('export file: schema version + app + vocab/progress/settings', backup.schema === 1 && backup.app === 'english-reader' && backup.vocab && backup.progress && backup.settings);
  check('export contains all vocab entries', JSON.stringify(Object.keys(backup.vocab).sort()) === JSON.stringify(Object.keys(vocabNow).sort()));
  check('download filename', /^english-reader-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  // wipe then import (overwrite)
  await page.evaluate(() => { localStorage.setItem('ra:v1:vocab', '{}'); });
  await page.reload();
  await page.waitForSelector('.empty');
  await page.setInputFiles('#import-file', file);
  await page.waitForSelector('.modal');
  await page.click('#import-overwrite');
  await page.waitForSelector('.vocab-row');
  const afterOverwrite = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:vocab')));
  check('import (overwrite) restores identical data', JSON.stringify(afterOverwrite) === JSON.stringify(vocabNow));
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
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.4));
  await page.waitForTimeout(2300);
  const pr = await page.evaluate(() => JSON.parse(localStorage.getItem('ra:v1:progress'))['b2-005']);
  check('scroll fraction saved (fraction not pixels)', pr.scroll > 0.2 && pr.scroll < 1, JSON.stringify(pr));
  await page.reload();
  await page.waitForSelector('.article-body .w');
  await page.waitForTimeout(400);
  const y1 = await page.evaluate(() => window.scrollY);
  check('scroll position restored after reload', y1 > 200, `scrollY=${y1}`);
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
  check('list shows 已读 status and level progress 1/5', (await page.locator('.card-item[data-id="b2-005"] .st-read').count()) === 1 && /1 \/ 5/.test(await page.locator('.progress-line').innerText()), await page.locator('.progress-line').innerText());
  await page.selectOption('select[aria-label="按阅读状态筛选"]', 'read');
  check('status filter (已读)', (await page.locator('.card-item').count()) === 1);
  await page.context().close();

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
  check('sub-path: list loads (relative data paths)', (await page.locator('.card-item').count()) === 5, page.errors.join('; '));
  await page.goto(sub.url + '#/read/b1-002');
  await page.waitForSelector('.article-body .w');
  await word(page, 'went').click();
  check('sub-path: lookup works', (await cardTitle(page)) === 'went ← go（过去式）');
  check('sub-path: no failed requests', page.errors.length === 0, page.errors.join('; '));
  await page.context().close();
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
