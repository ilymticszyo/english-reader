import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const { server, url } = await serve(resolve(ROOT, 'dist'));
const browser = await chromium.launch();
const word = (page, t, n = 0) => page.locator('.article-body .w', { hasText: new RegExp(`^${t}$`) }).nth(n);

// 1. list (desktop, light)
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
let page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector('.card-item');
await page.click('.tab[data-level="B2"]');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/01-list-desktop.png` });

// 2. reading page with popup (desktop, light)
await page.goto(url + '#/read/b1-002');
await page.waitForSelector('.article-body .w');
for (const w of ['market', 'soup']) { await word(page, w).first().click(); await page.keyboard.press('Escape'); }
await word(page, 'went').first().click();
await page.waitForSelector('.card');
await page.evaluate(() => window.scrollTo(0, 120));
await page.waitForTimeout(250);
await word(page, 'went').first().click();
await page.waitForSelector('.card');
await page.screenshot({ path: `${OUT}/02-reader-popup-desktop.png` });

// 2b. lexicalized -ing noun: "building" with the verb folded below
await page.goto(url + '#/read/b2-004');
await page.waitForSelector('.article-body .w');
await word(page, 'building').first().scrollIntoViewIfNeeded();
await word(page, 'building').first().click();
await page.waitForSelector('.card');
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/03-lexicalized-ing-building.png` });
await page.keyboard.press('Escape');
// 2c. about + settings
await page.goto(url + '#/about');
await page.waitForSelector('.about');
await page.screenshot({ path: `${OUT}/04-about.png`, fullPage: false });
await page.goto(url + '#/settings');
await page.waitForSelector('#version');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/05-settings-desktop.png`, fullPage: true });
await ctx.close();

// 3. mobile, dark, bottom sheet
ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
page = await ctx.newPage();
await page.goto(url + '#/read/b1-004');
await page.waitForSelector('.article-body .w');
await word(page, 'library').first().tap();
await page.keyboard.press('Escape').catch(() => {});
await word(page, 'Children').first().tap();
await page.waitForSelector('.card.sheet');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/06-reader-mobile-dark-sheet.png` });

// 4. vocab page (mobile dark)
await page.goto(url + '#/words');
await page.waitForSelector('.vocab-row');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/07-vocab-mobile-dark.png` });
await ctx.close();
await browser.close();
server.close();
console.log('screenshots saved to', OUT);
