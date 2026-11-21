// 难度自测 (level self-test): item sampling, scoring with guessing correction, level estimate, recommendation,
// upgrade suggestions from reading history + lookups, result storage normalisation and merge.
// Pure functions (no DOM / localStorage) so they run in node unit tests too.
//
// Method (about 5 minutes):
//   1. Yes/no vocabulary check: VOCAB_PER_BAND real words from each CEFR band A2 / B1 / B2 / C1 / C2 (CEFR-J + Octanove
//      word lists, definitions from ECDICT) mixed with PSEUDO_N invented pseudo-words. "认识" on a pseudo-word is a
//      false alarm. Per band, the hit rate h is corrected for guessing with the false-alarm rate f:
//        corrected = (h − f) / (1 − f), clamped to 0…1   (f = 1 → 0)
//   2. Reading: one short passage (taken from the site's own articles) per level B1 / B2 / C1, 3 multiple-choice questions each.
//
// Thresholds (documented in README too):
//   vocab level   = the highest band reached by passing every band from A2 upwards, pass = corrected ≥ BAND_PASS (0.6);
//                   A2 failed → 'A1' (below A2)
//   reading level = the highest level reached by passing every level from B1 upwards, pass = ≥ READ_PASS (2) of 3 correct;
//                   B1 failed → 'A2'
//   estimate      = min(vocab, reading) — both have to hold; but if reading is ≥ 2 levels above vocab (very cautious
//                   "不认识" answers), estimate = vocab + 1. Reading tops out at C1, so C2 vocab + C1 reading = 'C1+'.
//   recommended   = estimate clamped to the site's levels B1 … C1 (below B1 → B1, C1+ → C1)
//   reliable      = false-alarm rate ≤ FA_WARN (0.25, i.e. at most 3 of 12 pseudo-words marked "认识")
//   score (0–100) = round(100 × (0.6 × mean corrected over the 5 bands + 0.4 × reading correct / total))
//   vocab size    ≈ Σ corrected(band) × words in that band of the CEFR list, + A1 words × corrected(A2) (rough)

export type Level = 'B1' | 'B2' | 'C1';
export const LEVELS: Level[] = ['B1', 'B2', 'C1'];
export type Band = 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export const BANDS: Band[] = ['A2', 'B1', 'B2', 'C1', 'C2'];
const RANK: Record<string, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const LABEL = ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export const VOCAB_PER_BAND = 8;
export const PSEUDO_N = 12;
export const BAND_PASS = 0.6;
export const READ_PASS = 2;
export const FA_WARN = 0.25;
export const MAX_RESULTS = 100;

// ---------- data (public/data/leveltest.json, built by scripts/lib/leveltest.ts) ----------
export interface BankWord { w: string; zh: string }
export interface Passage {
  id: string;
  level: Level;
  /** source article (the passage is its paragraphs `paras`) */
  article: string;
  title: string;
  paras: number[];
  text: string[];
  questions: { q: string; options: string[]; answer: number }[];
}
export interface LevelTestData {
  schema: number;
  bands: Record<Band, BankWord[]>;
  /** words per CEFR level in the source lists (for the rough vocabulary-size estimate) */
  bandSizes: Record<string, number>;
  pseudo: string[];
  passages: Passage[];
}

// ---------- seeded random ----------
/** mulberry32: small, fast, deterministic PRNG → [0, 1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const sample = <T>(arr: readonly T[], n: number, rand: () => number) => shuffle(arr, rand).slice(0, n);

// ---------- one test ----------
export interface VocabItemT { w: string; band: Band | 'pseudo'; zh?: string }
export interface ReadingItem { passage: Passage; questions: { q: string; options: string[]; answer: number }[] }
export interface TestPlan { seed: number; vocab: VocabItemT[]; reading: ReadingItem[] }

/** A fresh random test: same seed → same test. Options of every question are shuffled too (answer index follows). */
export function makePlan(data: LevelTestData, seed: number, perBand = VOCAB_PER_BAND, pseudoN = PSEUDO_N): TestPlan {
  const rand = rng(seed);
  const items: VocabItemT[] = [];
  for (const b of BANDS) for (const x of sample(data.bands[b] ?? [], perBand, rand)) items.push({ w: x.w, band: b, zh: x.zh });
  for (const w of sample(data.pseudo, pseudoN, rand)) items.push({ w, band: 'pseudo' });
  const reading: ReadingItem[] = [];
  for (const lv of LEVELS) {
    const ps = data.passages.filter((p) => p.level === lv);
    if (!ps.length) continue;
    const p = ps[Math.floor(rand() * ps.length)];
    reading.push({
      passage: p,
      questions: p.questions.map((q) => {
        const order = shuffle(q.options.map((_, i) => i), rand);
        return { q: q.q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
      }),
    });
  }
  return { seed, vocab: shuffle(items, rand), reading };
}

// ---------- scoring ----------
export interface Tally { yes: number; n: number }
export interface LevelResult {
  /** record format version */
  v: 1;
  takenAt: number;
  seed: number;
  durationMs: number;
  vocab: {
    bands: Record<Band, Tally>;
    pseudo: Tally;
    falseAlarm: number;
    corrected: Record<Band, number>;
    /** 'A1' (below A2) … 'C2' */
    level: string;
    size: number;
  };
  reading: { levels: Record<Level, { correct: number; n: number }>; /** 'A2' (below B1) … 'C1' */ level: string };
  score: number;
  /** 'A2' (A2 or below) | 'B1' | 'B2' | 'C1' | 'C1+' */
  estimate: string;
  recommended: Level;
  reliable: boolean;
  /** real words answered "不认识" (shown on the result page with their meaning) */
  unknown: string[];
  /** pseudo-words answered "认识" */
  pseudoYes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
/** Guessing correction: (h − f) / (1 − f), clamped to 0…1. */
export function correct(h: number, f: number): number {
  if (f >= 1) return 0;
  return Math.max(0, Math.min(1, (h - f) / (1 - f)));
}
/** Highest band passed consecutively from A2 (pass = corrected ≥ BAND_PASS); none → 'A1'. */
export function vocabLevel(corrected: Record<Band, number>): string {
  let lv = 'A1';
  for (const b of BANDS) {
    if ((corrected[b] ?? 0) >= BAND_PASS) lv = b;
    else break;
  }
  return lv;
}
/** Highest level passed consecutively from B1 (pass = ≥ READ_PASS correct, or all if fewer questions); none → 'A2'. */
export function readingLevel(levels: Partial<Record<Level, { correct: number; n: number }>>): string {
  let lv = 'A2';
  for (const l of LEVELS) {
    const x = levels[l];
    if (x && x.n > 0 && x.correct >= Math.min(READ_PASS, x.n)) lv = l;
    else break;
  }
  return lv;
}
/** Combine the two (see the header comment). */
export function estimateOf(vocab: string, reading: string): { estimate: string; recommended: Level } {
  const v = RANK[vocab] ?? 1, r = RANK[reading] ?? 2;
  let e = Math.min(v, r);
  if (r - v >= 2) e = v + 1;
  const estimate = v >= 6 && r >= 5 ? 'C1+' : e <= 2 ? 'A2' : LABEL[Math.min(5, e)];
  const recommended = LABEL[Math.max(3, Math.min(5, e))] as Level;
  return { estimate, recommended };
}
export function vocabSize(corrected: Record<Band, number>, sizes: Record<string, number>): number {
  let n = (sizes.A1 ?? 0) * (corrected.A2 ?? 0);
  for (const b of BANDS) n += (sizes[b] ?? 0) * (corrected[b] ?? 0);
  return Math.round(n / 50) * 50;
}

export interface Answers {
  /** word → answered "认识" */
  vocab: Record<string, boolean>;
  /** per reading item, per question: chosen option index (−1 / missing = no answer) */
  reading: number[][];
}
export function scoreTest(plan: TestPlan, ans: Answers, sizes: Record<string, number>, takenAt: number, durationMs: number): LevelResult {
  const bands = Object.fromEntries(BANDS.map((b) => [b, { yes: 0, n: 0 }])) as Record<Band, Tally>;
  const pseudo: Tally = { yes: 0, n: 0 };
  const unknown: string[] = [], pseudoYes: string[] = [];
  for (const it of plan.vocab) {
    const yes = !!ans.vocab[it.w];
    if (it.band === 'pseudo') { pseudo.n++; if (yes) { pseudo.yes++; pseudoYes.push(it.w); } }
    else { bands[it.band].n++; if (yes) bands[it.band].yes++; else unknown.push(it.w); }
  }
  const f = pseudo.n ? pseudo.yes / pseudo.n : 0;
  const corrected = Object.fromEntries(BANDS.map((b) => [b, r2(correct(bands[b].n ? bands[b].yes / bands[b].n : 0, f))])) as Record<Band, number>;
  const levels = Object.fromEntries(LEVELS.map((l) => [l, { correct: 0, n: 0 }])) as Record<Level, { correct: number; n: number }>;
  plan.reading.forEach((ri, i) => {
    const t = levels[ri.passage.level];
    ri.questions.forEach((q, j) => { t.n++; if (ans.reading[i]?.[j] === q.answer) t.correct++; });
  });
  const vl = vocabLevel(corrected), rl = readingLevel(levels);
  const { estimate, recommended } = estimateOf(vl, rl);
  const meanV = BANDS.reduce((s, b) => s + corrected[b], 0) / BANDS.length;
  const rc = LEVELS.reduce((s, l) => s + levels[l].correct, 0), rn = LEVELS.reduce((s, l) => s + levels[l].n, 0);
  const score = Math.round(100 * (0.6 * meanV + 0.4 * (rn ? rc / rn : 0)));
  return {
    v: 1, takenAt, seed: plan.seed, durationMs: Math.max(0, Math.round(durationMs)),
    vocab: { bands, pseudo, falseAlarm: r2(f), corrected, level: vl, size: vocabSize(corrected, sizes) },
    reading: { levels, level: rl },
    score, estimate, recommended, reliable: f <= FA_WARN, unknown, pseudoYes,
  };
}

// ---------- upgrade suggestions (latest result + reading history + lookups) ----------
// Per level L (articles b1-… / b2-… / c1-…):  read(L) = articles marked read;
//   lookups(L) = saved (word, read article of L) pairs in the vocab book; rate(L) = lookups(L) / read(L).
// Rules, evaluated at the level the user actually reads ("current"): the highest level with ≥ MIN_READ read
//   articles, or the recommended level if none has that many yet.
//   read < MIN_READ                         → 'more'  (keep reading; advice after N more)
//   read ≥ UP_READ and rate ≤ UP_RATE       → 'up'    (try the next level; at C1: try 名著)
//   rate ≥ DOWN_RATE and level above B1     → 'down'  (step back one level for a while)
//   rate ≥ DOWN_RATE at B1                  → 'stay'  (stay, review the saved words)
//   otherwise                               → 'stay'
//   reading clearly below the recommendation (current < recommended, rate ≤ UP_RATE) → 'up' to the recommended level
// Retake: latest test older than RETAKE_DAYS and ≥ RETAKE_READ articles finished since → retake = true.
export const MIN_READ = 5;
export const UP_READ = 8;
export const UP_RATE = 3;
export const DOWN_RATE = 10;
export const RETAKE_DAYS = 30;
export const RETAKE_READ = 10;

export interface LevelStats { read: number; lookups: number; rate: number }
interface ProgressLike { status: string; readAt?: number; updatedAt?: number }
interface VocabLike { ctx: { a: string }[] }
const levelOfArticle = (id: string): Level | '' => { const m = /^(b1|b2|c1)-/.exec(id); return m ? (m[1].toUpperCase() as Level) : ''; };

export function levelStats(progress: Record<string, ProgressLike>, vocab: Record<string, VocabLike>): Record<Level, LevelStats> {
  const out = Object.fromEntries(LEVELS.map((l) => [l, { read: 0, lookups: 0, rate: 0 }])) as Record<Level, LevelStats>;
  for (const [id, p] of Object.entries(progress)) { const l = levelOfArticle(id); if (l && p.status === 'read') out[l].read++; }
  for (const it of Object.values(vocab)) {
    const seen = new Set<string>();
    for (const c of it.ctx ?? []) {
      const l = levelOfArticle(c.a);
      if (!l || seen.has(c.a) || progress[c.a]?.status !== 'read') continue;
      seen.add(c.a);
      out[l].lookups++;
    }
  }
  for (const l of LEVELS) out[l].rate = out[l].read ? Math.round((out[l].lookups / out[l].read) * 10) / 10 : 0;
  return out;
}

export interface Suggestion {
  kind: 'test' | 'more' | 'up' | 'stay' | 'down';
  /** the level the advice is about (current reading level) */
  level?: Level;
  /** where to go next (up / down / more) */
  target?: Level | 'classics';
  /** articles still to read before advice (kind 'more') */
  need?: number;
  retake: boolean;
  stats: Record<Level, LevelStats>;
  text: string;
}
const next = (l: Level): Level | 'classics' => (l === 'B1' ? 'B2' : l === 'B2' ? 'C1' : 'classics');
const prev = (l: Level): Level => (l === 'C1' ? 'B2' : 'B1');
const tname = (t: Level | 'classics') => (t === 'classics' ? '名著赏析' : `${t} 文章`);

export function suggest(latest: LevelResult | undefined, progress: Record<string, ProgressLike>, vocab: Record<string, VocabLike>, now: number): Suggestion {
  const stats = levelStats(progress, vocab);
  if (!latest) return { kind: 'test', retake: false, stats, text: '还没做过难度自测：花 5 分钟测一下，知道该从 B1、B2 还是 C1 读起。' };
  const readSince = Object.entries(progress).filter(([id, p]) => levelOfArticle(id) && p.status === 'read' && (p.readAt ?? p.updatedAt ?? 0) > latest.takenAt).length;
  const retake = now - latest.takenAt > RETAKE_DAYS * 864e5 && readSince >= RETAKE_READ;
  const rec = latest.recommended;
  const reading = [...LEVELS].reverse().find((l) => stats[l].read >= MIN_READ);
  const L = reading ?? rec;
  const s = stats[L];
  const rateTxt = `${L} 已读 ${s.read} 篇，平均每篇收录 ${s.rate} 个生词`;
  const tail = retake ? ` 距上次自测已超过 ${RETAKE_DAYS} 天、又读完 ${readSince} 篇，可以重测一次。` : '';
  if (reading && LEVELS.indexOf(L) < LEVELS.indexOf(rec) && s.rate <= UP_RATE)
    return { kind: 'up', level: L, target: rec, retake, stats, text: `${rateTxt}，读得很轻松；自测建议的是 ${rec}，可以试试 ${rec} 文章。` + tail };
  if (s.read < MIN_READ) {
    const need = MIN_READ - s.read;
    return { kind: 'more', level: L, target: L, need, retake, stats, text: `先从 ${L} 读起。再读完 ${need} 篇 ${L} 文章后，这里会根据你的查词量给出升降级建议。` + tail };
  }
  if (s.read >= UP_READ && s.rate <= UP_RATE) {
    const t = next(L);
    return { kind: 'up', level: L, target: t, retake, stats, text: `${rateTxt}，生词很少——可以挑战 ${tname(t)}了。` + tail };
  }
  if (s.rate >= DOWN_RATE) {
    if (L !== 'B1') return { kind: 'down', level: L, target: prev(L), retake, stats, text: `${rateTxt}，查词偏多。可以先回到 ${prev(L)} 读一阵，读起来更顺再回来。` + tail };
    return { kind: 'stay', level: L, retake, stats, text: `${rateTxt}，查词偏多。继续在 B1 多读，并用「复习生词」巩固收录的词。` + tail };
  }
  return { kind: 'stay', level: L, retake, stats, text: `${rateTxt}，难度合适，继续保持。` + (s.read < UP_READ ? `（读满 ${UP_READ} 篇且每篇生词 ≤ ${UP_RATE} 个时会建议升级）` : '') + tail };
}

// ---------- storage / backup ----------
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
/** A stored / imported result → a clean record, or null for junk (needs a finite takenAt and a valid recommended level). */
export function normalizeResult(x: unknown): LevelResult | null {
  if (!isObj(x)) return null;
  const takenAt = num(x.takenAt, NaN);
  if (!Number.isFinite(takenAt) || takenAt <= 0) return null;
  if (!(LEVELS as string[]).includes(x.recommended)) return null;
  const tally = (t: unknown): Tally => ({ yes: Math.max(0, Math.round(num(isObj(t) ? t.yes : 0))), n: Math.max(0, Math.round(num(isObj(t) ? t.n : 0))) });
  const v = isObj(x.vocab) ? x.vocab : {};
  const rd = isObj(x.reading) ? x.reading : {};
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string').slice(0, 200) : []);
  return {
    v: 1,
    takenAt,
    seed: Math.round(num(x.seed)),
    durationMs: Math.max(0, num(x.durationMs)),
    vocab: {
      bands: Object.fromEntries(BANDS.map((b) => [b, tally(isObj(v.bands) ? v.bands[b] : null)])) as Record<Band, Tally>,
      pseudo: tally(v.pseudo),
      falseAlarm: Math.max(0, Math.min(1, num(v.falseAlarm))),
      corrected: Object.fromEntries(BANDS.map((b) => [b, Math.max(0, Math.min(1, num(isObj(v.corrected) ? v.corrected[b] : 0)))])) as Record<Band, number>,
      level: typeof v.level === 'string' && v.level in RANK ? v.level : 'A1',
      size: Math.max(0, Math.round(num(v.size))),
    },
    reading: {
      levels: Object.fromEntries(LEVELS.map((l) => { const t = isObj(rd.levels) ? rd.levels[l] : null; return [l, { correct: Math.max(0, Math.round(num(isObj(t) ? t.correct : 0))), n: Math.max(0, Math.round(num(isObj(t) ? t.n : 0))) }]; })) as Record<Level, { correct: number; n: number }>,
      level: typeof rd.level === 'string' && rd.level in RANK ? rd.level : 'A2',
    },
    score: Math.max(0, Math.min(100, Math.round(num(x.score)))),
    estimate: typeof x.estimate === 'string' ? x.estimate.slice(0, 4) : x.recommended,
    recommended: x.recommended,
    reliable: x.reliable !== false,
    unknown: strs(x.unknown),
    pseudoYes: strs(x.pseudoYes),
  };
}
/** Any stored value → sorted (oldest first) list, one record per takenAt, at most MAX_RESULTS (newest kept). */
export function normalizeResults(raw: unknown): LevelResult[] {
  if (!Array.isArray(raw)) return [];
  return mergeResults([], raw.map(normalizeResult).filter((r): r is LevelResult => !!r)).list;
}
/** Union by takenAt (a result is immutable once taken; on a duplicate the local copy is kept). Sorted oldest first. */
export function mergeResults(local: LevelResult[], incoming: LevelResult[]): { list: LevelResult[]; added: number } {
  const map = new Map<number, LevelResult>();
  for (const r of local) if (!map.has(r.takenAt)) map.set(r.takenAt, r);
  let added = 0;
  for (const r of incoming) if (!map.has(r.takenAt)) { map.set(r.takenAt, r); added++; }
  const list = [...map.values()].sort((a, b) => a.takenAt - b.takenAt).slice(-MAX_RESULTS);
  return { list, added };
}
