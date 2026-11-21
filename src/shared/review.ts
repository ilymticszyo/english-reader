// Vocabulary review (生词复习): spaced-repetition scheduling, due counting, filters, review-data merge.
// Pure functions (no DOM / localStorage) so they run in node unit tests too.
//
// Storage: localStorage `ra:v1:review` = { [word key (same key as ra:v1:vocab)]: ReviewRecord }
//   A vocab word without a record is a "new" card. Records of words that are no longer in the vocab book are
//   ignored by every count and pruned on load / import / export (removeWord deletes the record, undo restores it).
//
// Scheduling: simplified SM-2, day-granular. `due` is a local calendar day 'YYYY-MM-DD' (not a timestamp), so a card
// due "tomorrow" becomes due at local midnight wherever the device is, and DST / time-zone changes never shift it
// by a few hours into the previous / next day.

export type Grade = 0 | 1 | 2 | 3; // 忘了 / 模糊 / 记得 / 简单
export const GRADES: { g: Grade; label: string; key: string }[] = [
  { g: 0, label: '忘了', key: '1' },
  { g: 1, label: '模糊', key: '2' },
  { g: 2, label: '记得', key: '3' },
  { g: 3, label: '简单', key: '4' },
];

export interface ReviewRecord {
  /** local day the card is next due, 'YYYY-MM-DD' */
  due: string;
  /** days until the next review (0 = again today) */
  interval: number;
  ease: number;
  /** successful reviews in a row since the last lapse */
  reps: number;
  /** times a learned card (reps > 0) was forgotten */
  lapses: number;
  lastGrade: Grade;
  updatedAt: number;
  /** local day of the very first review (used for the daily new-card limit) */
  firstDay?: string;
}
export type ReviewMap = Record<string, ReviewRecord>;

export const EASE_START = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const EASE_STEP = { again: -0.2, hard: -0.15, good: 0, easy: 0.15 } as const;
export const HARD_FACTOR = 1.2;
export const EASY_BONUS = 1.3;
export const MAX_INTERVAL = 365;
/** new (never reviewed) words introduced per day; due reviews are never capped */
export const NEW_PER_DAY = 20;

const DAY = 864e5;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Local calendar day of a timestamp. `tzOffsetMin` is Date#getTimezoneOffset() (minutes, UTC − local); defaults to the device zone. */
export function dayKey(ts: number, tzOffsetMin = new Date(ts).getTimezoneOffset()): string {
  return new Date(ts - tzOffsetMin * 60000).toISOString().slice(0, 10);
}
/** Calendar arithmetic on 'YYYY-MM-DD' (done in UTC, so no DST hour can move it to another day). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}
/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / DAY);
}

export const newRecord = (today: string): ReviewRecord => ({ due: today, interval: 0, ease: EASE_START, reps: 0, lapses: 0, lastGrade: 0, updatedAt: 0 });

/** Days until the next review for a grade (the number shown on the grade buttons). */
export function nextInterval(rec: ReviewRecord | undefined, g: Grade): number {
  const r = rec ?? newRecord('1970-01-01');
  const prev = Math.max(1, r.interval);
  const ease = clamp(r.ease + [EASE_STEP.again, EASE_STEP.hard, EASE_STEP.good, EASE_STEP.easy][g], EASE_MIN, EASE_MAX);
  let iv: number;
  if (g === 0) iv = 0; // lapse: back to the start, seen again in this session
  else if (r.reps === 0) iv = g === 3 ? 4 : 1; // first success (new card or right after a lapse)
  else if (r.reps === 1) iv = g === 1 ? 2 : g === 2 ? 3 : 6;
  else if (g === 1) iv = Math.max(prev + 1, Math.round(prev * HARD_FACTOR));
  else if (g === 2) iv = Math.max(prev + 1, Math.round(prev * ease));
  else iv = Math.max(prev + 1, Math.round(prev * ease * EASY_BONUS));
  return Math.min(MAX_INTERVAL, iv);
}

/** Apply one grade. Returns a new record (input untouched). */
export function schedule(rec: ReviewRecord | undefined, g: Grade, now: number, today = dayKey(now)): ReviewRecord {
  const r = rec ?? newRecord(today);
  const interval = nextInterval(r, g);
  const ease = round2(clamp(r.ease + [EASE_STEP.again, EASE_STEP.hard, EASE_STEP.good, EASE_STEP.easy][g], EASE_MIN, EASE_MAX));
  const out: ReviewRecord = {
    due: addDays(today, interval),
    interval,
    ease,
    reps: g === 0 ? 0 : r.reps + 1,
    lapses: r.lapses + (g === 0 && r.reps > 0 ? 1 : 0),
    lastGrade: g,
    updatedAt: now,
    firstDay: r.firstDay ?? (rec && rec.updatedAt ? dayKey(rec.updatedAt) : today),
  };
  return out;
}

export const isDue = (rec: ReviewRecord, today: string) => rec.due <= today;
export const fmtInterval = (d: number) => (d <= 0 ? '今天' : d === 1 ? '1 天' : d < 30 ? `${d} 天` : d < 365 ? `${Math.round(d / 30)} 个月` : `${Math.round((d / 365) * 10) / 10} 年`);

// ---------- what to review ----------
/** minimal view of a vocab item (src/shared/history.ts VocabItem) */
export interface VocabLike {
  mastered: boolean;
  addedAt: number;
  snap: { cefr?: string };
  ctx: { a: string }[];
}
export interface ReviewFilter {
  /** '' all | 'B1' | 'B2' | 'C1' (articles of that level) | 'classics' (名著) — a word matches if any saved sentence comes from there */
  pool?: string;
  /** '' all | 'A1'…'C2' | '-' (no CEFR level) — the word's own level from the dictionary */
  cefr?: string;
  /** '' all | an article / classic id — the word was saved from that text */
  article?: string;
}
export const POOLS = ['B1', 'B2', 'C1', 'classics'] as const;
export function poolOf(articleId: string): string {
  if (articleId.startsWith('cl-')) return 'classics';
  const m = /^(b1|b2|c1)-/.exec(articleId);
  return m ? m[1].toUpperCase() : '';
}
export function matchesFilter(it: VocabLike, f: ReviewFilter): boolean {
  if (f.cefr && (f.cefr === '-' ? !!it.snap?.cefr : it.snap?.cefr !== f.cefr)) return false;
  if (f.pool && !it.ctx.some((c) => poolOf(c.a) === f.pool)) return false;
  if (f.article && !it.ctx.some((c) => c.a === f.article)) return false;
  return true;
}

export interface DueInfo {
  /** learned cards due today or earlier (oldest due first) */
  review: string[];
  /** never-reviewed words offered today (oldest saved first), within the daily new-card limit */
  fresh: string[];
  /** never-reviewed words beyond today's limit */
  freshLeft: number;
  /** review.length + fresh.length = 「今日待复习」 */
  total: number;
}
/** Today's queue. Mastered words and records without a vocab word are skipped. The new-card limit is shared by all
 *  filters (it counts every new word first reviewed today). */
export function dueToday(vocab: Record<string, VocabLike>, review: ReviewMap, today: string, f: ReviewFilter = {}, newPerDay = NEW_PER_DAY): DueInfo {
  const rev: [string, string][] = [];
  const fresh: [string, number][] = [];
  let startedToday = 0;
  for (const [w, r] of Object.entries(review)) if (r.firstDay === today && vocab[w]) startedToday++;
  for (const [w, it] of Object.entries(vocab)) {
    if (it.mastered) continue;
    const r = review[w];
    if (!matchesFilter(it, f)) continue;
    if (!r) fresh.push([w, it.addedAt]);
    else if (isDue(r, today)) rev.push([w, r.due]);
  }
  rev.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0].localeCompare(b[0])));
  fresh.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const quota = Math.max(0, newPerDay - startedToday);
  const freshOut = fresh.slice(0, quota).map((x) => x[0]);
  return { review: rev.map((x) => x[0]), fresh: freshOut, freshLeft: fresh.length - freshOut.length, total: rev.length + freshOut.length };
}

// ---------- storage / backup ----------
export function normalizeRecord(v: unknown): ReviewRecord | null {
  if (!isObj(v)) return null;
  let due = v.due;
  if (typeof due === 'number') due = Number.isFinite(due) && Math.abs(due) < 8.64e15 ? dayKey(due) : null; // defensive: a timestamp
  if (typeof due !== 'string' || !DAY_RE.test(due)) return null;
  const g = num(v.lastGrade, 0);
  const out: ReviewRecord = {
    due,
    interval: Math.max(0, Math.round(num(v.interval))),
    ease: round2(clamp(num(v.ease, EASE_START), EASE_MIN, EASE_MAX)),
    reps: Math.max(0, Math.round(num(v.reps))),
    lapses: Math.max(0, Math.round(num(v.lapses))),
    lastGrade: (g >= 0 && g <= 3 ? Math.round(g) : 0) as Grade,
    updatedAt: num(v.updatedAt),
  };
  if (typeof v.firstDay === 'string' && DAY_RE.test(v.firstDay)) out.firstDay = v.firstDay;
  return out;
}
export function normalizeReview(raw: unknown): ReviewMap {
  const out: ReviewMap = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const r = normalizeRecord(v);
    if (r) out[k] = r;
  }
  return out;
}
/** Per word: the newer updatedAt wins; a tie keeps the record with more progress (commutative). */
export function mergeRecord(a: ReviewRecord, b: ReviewRecord): ReviewRecord {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.reps !== b.reps) return a.reps > b.reps ? a : b;
  if (a.due !== b.due) return a.due > b.due ? a : b;
  return a.ease >= b.ease ? a : b;
}
export function mergeReview(local: ReviewMap, incoming: ReviewMap): { map: ReviewMap; added: number; updated: number } {
  const map: ReviewMap = { ...local };
  let added = 0, updated = 0;
  for (const [w, inc] of Object.entries(incoming)) {
    const cur = map[w];
    if (!cur) { map[w] = inc; added++; continue; }
    const m = mergeRecord(cur, inc);
    if (m !== cur) updated++;
    map[w] = m;
  }
  return { map, added, updated };
}
/** Drop records whose word is not in the vocab book (no orphan due cards). */
export function pruneReview(review: ReviewMap, vocab: Record<string, unknown>): ReviewMap {
  const out: ReviewMap = {};
  for (const [w, r] of Object.entries(review)) if (Object.prototype.hasOwnProperty.call(vocab, w)) out[w] = r;
  return out;
}
