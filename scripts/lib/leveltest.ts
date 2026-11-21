// Build step for 难度自测 (level self-test): public/data/leveltest.json
//   bands:   per CEFR band A2…C2, a fixed bank of real words (CEFR-J / Octanove lists) with a short ECDICT definition
//   pseudo:  invented, English-looking pseudo-words (checked against the full ECDICT word list + every form it lists)
//   passages: reading passages = paragraphs of the site's own articles + the original questions in content/leveltest/reading.json
// Everything is deterministic (hash order / seeded PRNG) so identical inputs give an identical file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, makeEntry, parseExchange } from './ecdict.ts';
import type { Db } from './ecdict.ts';
import { BANDS, LEVELS, PSEUDO_N, VOCAB_PER_BAND, rng } from '../../src/shared/leveltest.ts';
import type { Band, LevelTestData, Passage } from '../../src/shared/leveltest.ts';

export const BANK_PER_BAND = 120;
export const PSEUDO_BANK = 120;
const BAD = ['fuck', 'shit', 'cunt', 'dick', 'cock', 'nig', 'fag', 'rape', 'slut', 'whore', 'piss', 'tit', 'sex', 'porn', 'anal', 'anus', 'kill', 'nazi', 'poo', 'butt', 'damn', 'hell', 'bitch', 'bum', 'gay', 'jew', 'die'];
const hash = (s: string) => createHash('sha1').update('leveltest:' + s).digest('hex');

function shortZh(d: { pos: string; zh: string }[]): string {
  const first = d.find((x) => x.zh && !/人名|地名|姓氏|缩写|abbr/i.test(x.zh + x.pos));
  if (!first) return '';
  const parts = first.zh.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join('，');
  return `${first.pos ? first.pos + ' ' : ''}${parts}`.slice(0, 32);
}

/** a deterministic edit-distance ≤ 1 test */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

export interface LevelTestBuild { data: LevelTestData; flags: string[] }

export function buildLevelTest(opts: { db: Db; cefr: Record<string, string>; articles: { id: string; level: string; title: string; paragraphs: string[] }[]; err: (m: string) => void }): LevelTestBuild {
  const { db, cefr, articles, err } = opts;
  const flags: string[] = [];
  // ---- real-word banks
  const bandSizes: Record<string, number> = {};
  const byBand = new Map<string, string[]>();
  for (const [w, lv] of Object.entries(cefr)) {
    if (!/^[a-z]+$/.test(w)) continue;
    bandSizes[lv] = (bandSizes[lv] ?? 0) + 1;
    if (!byBand.has(lv)) byBand.set(lv, []);
    byBand.get(lv)!.push(w);
  }
  const bands = {} as LevelTestData['bands'];
  for (const b of BANDS) {
    const words = (byBand.get(b) ?? []).filter((w) => w.length >= 3 && w.length <= 14).sort((x, y) => (hash(x) < hash(y) ? -1 : 1));
    const out: { w: string; zh: string }[] = [];
    for (const w of words) {
      const row = db.rows.get(w);
      if (!row || !row.translation) continue;
      if (/的(过去式|过去分词|复数|现在分词|比较级|最高级)|的第三人称/.test(row.translation)) continue;
      const zh = shortZh(makeEntry(row, cefr, w).d);
      if (!zh) continue;
      out.push({ w, zh });
      if (out.length >= BANK_PER_BAND) break;
    }
    out.sort((x, y) => x.w.localeCompare(y.w));
    bands[b as Band] = out;
    if (out.length < VOCAB_PER_BAND * 3) err(`leveltest: only ${out.length} usable ${b} words`);
  }
  // ---- pseudo-words
  const real = Object.keys(cefr).filter((w) => /^[a-z]{4,10}$/.test(w));
  const realSet = new Set(real);
  const tri = new Set<string>();
  const bi = new Map<string, number>();
  for (const w of real) {
    const x = `^${w}$`;
    for (let i = 0; i + 3 <= x.length; i++) tri.add(x.slice(i, i + 3));
    for (let i = 0; i + 2 <= x.length; i++) bi.set(x.slice(i, i + 2), (bi.get(x.slice(i, i + 2)) ?? 0) + 1);
  }
  const isWord = (s: string) => db.rows.has(s) || db.reverse.has(s) || realSet.has(s);
  const derived = (s: string) => {
    for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers', 'ly', 'y', 'ness', 'ment', 'ful', 'less', 'able', 'al', 'ion', 'ist', 'ism', 'ize', 'ise', 'ity']) {
      if (!s.endsWith(suf) || s.length - suf.length < 3) continue;
      const stem = s.slice(0, -suf.length);
      if (isWord(stem) || isWord(stem + 'e') || (stem.length > 3 && stem.at(-1) === stem.at(-2) && isWord(stem.slice(0, -1))) || (stem.endsWith('i') && isWord(stem.slice(0, -1) + 'y'))) return true;
    }
    for (const pre of ['un', 're', 'in', 'im', 'dis', 'mis', 'non', 'over', 'under', 'pre', 'out', 'sub', 'de', 'co', 'anti', 'inter', 'trans', 'super', 'semi']) if (s.startsWith(pre) && s.length - pre.length >= 3 && isWord(s.slice(pre.length))) return true;
    return false;
  };
  // words a learner might mistake a pseudo-word for: CEFR words + all their inflected forms + any reasonably common ECDICT word
  const common = new Set<string>(Object.keys(cefr).filter((w) => /^[a-z]+$/.test(w)));
  for (const [k, r] of db.rows) if (/^[a-z]{3,11}$/.test(k) && ((r.frq > 0 && r.frq <= 30000) || (r.bnc > 0 && r.bnc <= 30000))) common.add(k);
  for (const w of [...common]) { const row = db.rows.get(w); if (row?.exchange) for (const f of Object.values(parseExchange(row.exchange))) if (/^[a-z]+$/.test(f)) common.add(f); }
  const byLen = new Map<number, string[]>();
  for (const w of common) { if (!byLen.has(w.length)) byLen.set(w.length, []); byLen.get(w.length)!.push(w); }
  const nearCommon = (c: string) => [c.length - 1, c.length, c.length + 1].some((L) => (byLen.get(L) ?? []).some((w) => near(w, c)));
  const src = real.filter((w) => ['B1', 'B2', 'C1'].includes(cefr[w])).sort();
  const rand = rng(20261121);
  const pseudo: string[] = [];
  const seen = new Set<string>();
  for (let tries = 0; tries < 400000 && pseudo.length < PSEUDO_BANK; tries++) {
    const a = src[Math.floor(rand() * src.length)], b = src[Math.floor(rand() * src.length)];
    if (a === b) continue;
    const i = 2 + Math.floor(rand() * (a.length - 3));
    const j = 1 + Math.floor(rand() * (b.length - 2));
    const c = a.slice(0, i) + b.slice(j);
    if (c.length < 5 || c.length > 9 || seen.has(c)) continue;
    seen.add(c);
    if (!/[aeiou]/.test(c) || /(.)\1\1/.test(c) || /[^aeiouy]{4}/.test(c) || /[aeiou]{3}/.test(c)) continue;
    const x = `^${c}$`;
    let okTri = true;
    for (let k = 0; k + 3 <= x.length; k++) if (!tri.has(x.slice(k, k + 3))) { okTri = false; break; }
    if (!okTri) continue;
    if ((bi.get(a[i - 1] + b[j]) ?? 0) < 40) continue;
    if (isWord(c) || derived(c)) continue;
    if (BAD.some((s) => c.includes(s))) continue;
    if (c.startsWith(a.slice(0, Math.max(i, 4))) && a.length - i <= 1) continue; // almost the whole first word
    if (nearCommon(c)) continue;
    pseudo.push(c);
  }
  pseudo.sort();
  if (pseudo.length < PSEUDO_N * 3) err(`leveltest: only ${pseudo.length} pseudo-words generated`);
  // ---- passages
  const raw = JSON.parse(readFileSync(resolve(ROOT, 'content/leveltest/reading.json'), 'utf8'));
  const byId = new Map(articles.map((a) => [a.id, a]));
  const passages: Passage[] = [];
  const ids = new Set<string>();
  for (const p of raw.passages ?? []) {
    const at = `content/leveltest/reading.json ${p.id}`;
    if (!p.id || ids.has(p.id)) { err(`${at}: missing / duplicate id`); continue; }
    ids.add(p.id);
    if (!(LEVELS as string[]).includes(p.level)) { err(`${at}: bad level ${p.level}`); continue; }
    const a = byId.get(p.article);
    if (!a) { err(`${at}: article ${p.article} not found`); continue; }
    if (a.level !== p.level) err(`${at}: level ${p.level} but article ${a.id} is ${a.level}`);
    if (!Array.isArray(p.paras) || !p.paras.length || p.paras.some((i: number) => !Number.isInteger(i) || i < 0 || i >= a.paragraphs.length)) { err(`${at}: bad paragraph indexes`); continue; }
    const text = p.paras.map((i: number) => a.paragraphs[i]);
    if (!p.anchor || !text.join(' ').includes(p.anchor)) err(`${at}: anchor "${p.anchor}" not found in ${a.id} paragraphs ${p.paras} (article changed? re-check the questions)`);
    if (!Array.isArray(p.questions) || p.questions.length !== 3) err(`${at}: needs exactly 3 questions`);
    for (const [k, q] of (p.questions ?? []).entries()) {
      if (!q.q || !Array.isArray(q.options) || q.options.length !== 4 || new Set(q.options).size !== 4) err(`${at} q${k + 1}: needs 4 different options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options?.length ?? 0)) err(`${at} q${k + 1}: bad answer index`);
    }
    const words = text.join(' ').split(/\s+/).length;
    if (words > 130) flags.push(`${p.id}: passage has ${words} words (keep it short, ≤ 130)`);
    passages.push({ id: p.id, level: p.level, article: a.id, title: a.title, paras: p.paras, text, questions: p.questions.map((q: any) => ({ q: q.q, options: q.options, answer: q.answer })) });
  }
  for (const lv of LEVELS) if (!passages.some((p) => p.level === lv)) err(`leveltest: no reading passage for ${lv}`);
  return { data: { schema: 1, bands, bandSizes, pseudo, passages }, flags };
}
