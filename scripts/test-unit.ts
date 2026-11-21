// Unit tests for the reading history (阅读记录) storage, migration, merge and backup file format (src/shared/history.ts)
// and the vocabulary review scheduler (生词复习, src/shared/review.ts).
//   npm run test:unit
import { deepStrictEqual as eq, ok, throws } from 'node:assert/strict';
import { BACKUP_SCHEMA, PROGRESS_SCHEMA, applyPatch, makeBackup, mergeEntry, mergeProgress, mergeVocab, migrateEntry, migrateProgress, parseBackupText, readCounts } from '../src/shared/history.ts';
import type { ProgressMap, VocabItem } from '../src/shared/history.ts';
import { EASE_MAX, EASE_MIN, EASE_START, MAX_INTERVAL, NEW_PER_DAY, addDays, dayKey, daysBetween, dueToday, fmtInterval, isDue, matchesFilter, mergeRecord, mergeReview, nextInterval, normalizeRecord, normalizeReview, poolOf, pruneReview, schedule } from '../src/shared/review.ts';
import type { Grade, ReviewMap, ReviewRecord } from '../src/shared/review.ts';

let n = 0, fails = 0;
const t = (name: string, fn: () => void) => {
  n++;
  try { fn(); } catch (e) { fails++; console.log(`  ✗ ${name}\n    ${(e as Error).message.split('\n').join('\n    ')}`); }
};
const W = (o: Partial<VocabItem> = {}): VocabItem => ({ addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: { zh: 'x' }, ctx: [], ...o });

// ---- schema versions
t('schema versions: progress 2, backup 3', () => { eq(PROGRESS_SCHEMA, 2); eq(BACKUP_SCHEMA, 3); });

// ---- migration (progress schema 1 → 2)
const v1: Record<string, unknown> = {
  'b1-001': { status: 'read', scroll: 1, updatedAt: 1000 },
  'b1-002': { status: 'reading', scroll: 0.4, updatedAt: 2000 },
  'b2-010': { status: 'unread', scroll: 0, updatedAt: 3000 },
  'cl-005': { status: 'read', scroll: 1, updatedAt: 4000, extra: 'kept' },
};
t('migration keeps every entry, status, scroll and updatedAt', () => {
  const m = migrateProgress(v1);
  eq(Object.keys(m), Object.keys(v1));
  for (const [id, old] of Object.entries(v1) as [string, any][]) { eq(m[id].status, old.status); eq(m[id].scroll, old.scroll); eq(m[id].updatedAt, old.updatedAt); }
});
t('migration adds readAt (= updatedAt) to read entries only', () => {
  const m = migrateProgress(v1);
  eq(m['b1-001'].readAt, 1000);
  eq(m['cl-005'].readAt, 4000);
  ok(!('readAt' in m['b1-002']) && !('readAt' in m['b2-010']));
});
t('migration keeps unknown extra fields', () => eq((migrateProgress(v1)['cl-005'] as any).extra, 'kept'));
t('migration is idempotent', () => { const m = migrateProgress(v1); eq(migrateProgress(m), m); });
t('migration keeps an existing readAt', () => eq(migrateEntry({ status: 'read', scroll: 1, updatedAt: 9, readAt: 5 })!.readAt, 5));
t('migration repairs partial entries instead of dropping them', () => {
  eq(migrateEntry({ scroll: 1 }), { scroll: 1, status: 'read', updatedAt: 0, readAt: 0 });
  eq(migrateEntry({ scroll: 0.3 })!.status, 'reading');
  eq(migrateEntry({ status: 'bogus' })!.status, 'unread');
  eq(migrateEntry({ status: 'reading', scroll: 7 })!.scroll, 1);
  eq(migrateEntry('read')!.status, 'read');
});
t('migration drops only junk values', () => { eq(Object.keys(migrateProgress({ a: null, b: 5, c: [], d: { status: 'read' } })), ['d']); eq(migrateProgress(null), {}); eq(migrateProgress('x'), {}); });

// ---- status changes (auto-mark at bottom, manual mark / unmark)
t('marking read sets readAt', () => { const p = applyPatch(undefined, { status: 'read', scroll: 1 }, 50); eq(p, { status: 'read', scroll: 1, updatedAt: 50, readAt: 50 }); });
t('scrolling a read article keeps the first readAt', () => { const p = applyPatch({ status: 'read', scroll: 1, updatedAt: 50, readAt: 50 }, { scroll: 0.995 }, 80); eq(p.readAt, 50); eq(p.updatedAt, 80); eq(p.status, 'read'); });
t('unmarking removes readAt', () => { const p = applyPatch({ status: 'read', scroll: 1, updatedAt: 50, readAt: 50 }, { status: 'unread', scroll: 0 }, 90); ok(!('readAt' in p)); eq(p.status, 'unread'); });
t('re-marking after unmark gets a new readAt', () => eq(applyPatch({ status: 'unread', scroll: 0, updatedAt: 90 }, { status: 'read', scroll: 1 }, 120).readAt, 120));
t('opening an unread article → reading, position saved', () => { const p = applyPatch(applyPatch(undefined, { status: 'reading', scroll: 0 }, 1), { scroll: 0.42 }, 2); eq([p.status, p.scroll], ['reading', 0.42]); });

// ---- merge
t('merge: newer change wins (unmark on another device sticks)', () => {
  const m = mergeEntry({ status: 'read', scroll: 1, updatedAt: 10, readAt: 10 }, { status: 'unread', scroll: 0, updatedAt: 20 });
  eq(m, { status: 'unread', scroll: 0, updatedAt: 20 });
});
t('merge: older incoming change does not downgrade', () => eq(mergeEntry({ status: 'read', scroll: 1, updatedAt: 30, readAt: 30 }, { status: 'reading', scroll: 0.5, updatedAt: 20 }).status, 'read'));
t('merge: tie → further status wins, then further scroll', () => {
  eq(mergeEntry({ status: 'reading', scroll: 0.5, updatedAt: 5 }, { status: 'read', scroll: 1, updatedAt: 5, readAt: 5 }).status, 'read');
  eq(mergeEntry({ status: 'reading', scroll: 0.2, updatedAt: 5 }, { status: 'reading', scroll: 0.6, updatedAt: 5 }).scroll, 0.6);
});
t('merge: both read → earliest readAt kept', () => eq(mergeEntry({ status: 'read', scroll: 1, updatedAt: 40, readAt: 40 }, { status: 'read', scroll: 1, updatedAt: 30, readAt: 12 }).readAt, 12));
t('merge: is commutative', () => {
  const a = { status: 'read' as const, scroll: 1, updatedAt: 40, readAt: 33 }, b = { status: 'reading' as const, scroll: 0.3, updatedAt: 40 };
  eq(mergeEntry(a, b), mergeEntry(b, a));
});
t('mergeProgress: union, local-only kept, counts added/updated', () => {
  const local: ProgressMap = { 'b1-001': { status: 'read', scroll: 1, updatedAt: 10, readAt: 10 }, 'b1-002': { status: 'reading', scroll: 0.3, updatedAt: 10 } };
  const inc: ProgressMap = { 'b1-002': { status: 'read', scroll: 1, updatedAt: 20, readAt: 20 }, 'cl-001': { status: 'read', scroll: 1, updatedAt: 5, readAt: 5 }, 'b1-001': { status: 'unread', scroll: 0, updatedAt: 1 } };
  const r = mergeProgress(local, inc);
  eq(Object.keys(r.map).sort(), ['b1-001', 'b1-002', 'cl-001']);
  eq(r.map['b1-001'].status, 'read');
  eq(r.map['b1-002'].status, 'read');
  eq([r.added, r.updated], [1, 1]);
  eq(local['b1-002'].status, 'reading'); // inputs untouched
});
t('mergeProgress: merging the same data twice changes nothing', () => {
  const a: ProgressMap = { x: { status: 'read', scroll: 1, updatedAt: 3, readAt: 3 } };
  const r = mergeProgress(a, a);
  eq(r.map, a);
  eq([r.added, r.updated], [0, 0]);
});
t('mergeVocab: keeps local-only words, adds missing, combines counts/contexts', () => {
  const ctx = (s: string) => ({ a: 'b1-001', v: 1, p: 0, s, form: 'x', at: 1 });
  const r = mergeVocab({ go: W({ count: 2, ctx: [ctx('A')] }), zebra: W() }, { go: W({ count: 5, addedAt: 0, lastAt: 9, ctx: [ctx('A'), ctx('B')] }), cat: W() });
  eq(Object.keys(r.map).sort(), ['cat', 'go', 'zebra']);
  eq([r.map.go.count, r.map.go.addedAt, r.map.go.lastAt, r.map.go.ctx.length], [5, 0, 9, 2]);
  eq(r.added, 1);
});
t('mergeVocab: mastered only if mastered on both sides', () => eq(mergeVocab({ a: W({ mastered: true }) }, { a: W({ mastered: false }) }).map.a.mastered, false));

// ---- backup file
const vocab = { go: W() };
const hist: ProgressMap = { 'b1-001': { status: 'read', scroll: 1, updatedAt: 10, readAt: 10 } };
t('export: one file with schema version, history and vocab', () => {
  const b = makeBackup(hist, vocab, { theme: 'dark' }, new Date(0));
  eq(b, { schema: 3, app: 'english-reader', exportedAt: '1970-01-01T00:00:00.000Z', history: hist, vocab, review: {}, settings: { theme: 'dark' } });
});
t('export → import round-trip is lossless', () => {
  const p = parseBackupText(JSON.stringify(makeBackup(hist, vocab, {})));
  eq(p.history, hist); eq(p.vocab, vocab); eq(p.fileSchema, 3); ok(p.hasHistory); ok(p.hasReview); eq(p.review, {});
});
t('import: schema-1 file with progress → history (migrated)', () => {
  const p = parseBackupText(JSON.stringify({ schema: 1, app: 'english-reader', exportedAt: 'x', settings: {}, progress: { 'b2-001': { status: 'read', scroll: 1, updatedAt: 7 } }, vocab }));
  eq(p.fileSchema, 1); eq(p.history['b2-001'].readAt, 7); ok(p.hasHistory);
});
t('import: old vocab-only file (schema 1, no progress)', () => {
  const p = parseBackupText(JSON.stringify({ schema: 1, app: 'english-reader', exportedAt: '2026-01-01T00:00:00Z', vocab }));
  eq(p.vocab, vocab); eq(p.history, {}); ok(!p.hasHistory); eq(p.fileSchema, 1);
});
t('import: bare { vocab } and bare vocab map (no app / schema field)', () => {
  eq(parseBackupText(JSON.stringify({ vocab })).vocab, vocab);
  const p = parseBackupText(JSON.stringify(vocab));
  eq(p.vocab, vocab); eq(p.fileSchema, 0); ok(!p.hasHistory);
});
t('import: vocab items with missing fields are repaired', () => eq(parseBackupText(JSON.stringify({ vocab: { a: { addedAt: 3, ctx: [] } } })).vocab.a, { addedAt: 3, lastAt: 3, count: 1, mastered: false, snap: {}, ctx: [] }));
t('import: rejects future schema, foreign files, bad JSON, missing vocab', () => {
  throws(() => parseBackupText(JSON.stringify({ schema: 4, app: 'english-reader', vocab })), /schema 版本（4）/);
  throws(() => parseBackupText(JSON.stringify({ app: 'other', vocab })), /不是本应用/);
  throws(() => parseBackupText('{"hello": 1}'), /不是本应用/);
  throws(() => parseBackupText('nope'), /JSON/);
  throws(() => parseBackupText(JSON.stringify({ schema: 2, app: 'english-reader' })), /vocab/);
  throws(() => parseBackupText(JSON.stringify({ app: 'english-reader', vocab })), /schema/);
});
t('import of an old vocab-only file merges without touching history', () => {
  const p = parseBackupText(JSON.stringify({ schema: 1, app: 'english-reader', vocab: { cat: W() } }));
  const h = mergeProgress(hist, p.history), v = mergeVocab(vocab, p.vocab);
  eq(h.map, hist); eq(Object.keys(v.map).sort(), ['cat', 'go']);
});

// ---- progress lines
t('readCounts: one line per pool, only ids in the pool count', () => {
  const prog: ProgressMap = { 'b1-001': { status: 'read', scroll: 1, updatedAt: 1 }, 'b1-002': { status: 'reading', scroll: 0.5, updatedAt: 1 }, 'cl-001': { status: 'read', scroll: 1, updatedAt: 1 }, 'zz-gone': { status: 'read', scroll: 1, updatedAt: 1 } };
  eq(readCounts(prog, { B1: ['b1-001', 'b1-002', 'b1-003'], B2: ['b2-001'], C1: [], classics: ['cl-001', 'cl-002'] }), { B1: { read: 1, total: 3 }, B2: { read: 0, total: 1 }, C1: { read: 0, total: 0 }, classics: { read: 1, total: 2 } });
});

// ======================================================= vocabulary review (生词复习)
const R = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({ due: '2026-11-21', interval: 0, ease: 2.5, reps: 0, lapses: 0, lastGrade: 0, updatedAt: 1, ...o });
const NOW = Date.parse('2026-11-21T04:00:00Z'); // 12:00 in Asia/Shanghai
const TODAY = '2026-11-21';
const chain = (gs: Grade[], start?: ReviewRecord) => {
  let r = start, day = TODAY, now = NOW;
  for (const g of gs) { r = schedule(r, g, now, day); day = r.due > day ? r.due : day; now += 864e5; }
  return r!;
};

// ---- timezone-safe "today"
t('dayKey: local calendar day for the given zone offset', () => {
  const ts = Date.parse('2026-11-21T16:30:00Z');
  eq(dayKey(ts, -480), '2026-11-22'); // Asia/Shanghai (UTC+8): already 00:30 next day
  eq(dayKey(ts, 300), '2026-11-21'); // New York (UTC−5): 11:30
  eq(dayKey(ts, 0), '2026-11-21');
  eq(dayKey(Date.parse('2026-11-21T15:59:59Z'), -480), '2026-11-21'); // 23:59:59 local
  eq(dayKey(Date.parse('2026-11-21T16:00:00Z'), -480), '2026-11-22'); // local midnight
});
t('dayKey: half-hour zones and the date line', () => {
  eq(dayKey(Date.parse('2026-11-21T18:45:00Z'), -330), '2026-11-22'); // India UTC+5:30 → 00:15
  eq(dayKey(Date.parse('2026-11-21T10:30:00Z'), -840), '2026-11-22'); // Kiribati UTC+14
  eq(dayKey(Date.parse('2026-11-21T10:30:00Z'), 660), '2026-11-20'); // Niue UTC−11
});
t('addDays / daysBetween: month, year, leap day and DST weekends (UTC arithmetic)', () => {
  eq(addDays('2026-11-30', 1), '2026-12-01');
  eq(addDays('2026-12-31', 1), '2027-01-01');
  eq(addDays('2028-02-28', 1), '2028-02-29');
  eq(addDays('2027-03-13', 1), '2027-03-14'); // US DST starts 2027-03-14
  eq(addDays('2027-10-30', 2), '2027-11-01'); // EU DST ends 2027-10-31
  eq(addDays('2026-11-21', 0), '2026-11-21');
  eq(addDays('2026-11-21', -21), '2026-10-31');
  eq(daysBetween('2026-11-21', '2027-11-21'), 365);
  eq(daysBetween('2027-03-13', '2027-03-15'), 2);
});
t('isDue: due today or earlier, not tomorrow', () => {
  ok(isDue(R({ due: TODAY }), TODAY)); ok(isDue(R({ due: '2026-11-01' }), TODAY)); ok(!isDue(R({ due: '2026-11-22' }), TODAY));
});

// ---- intervals
t('new card: 忘了 0 (again today) · 模糊 1 · 记得 1 · 简单 4 days', () => eq(([0, 1, 2, 3] as Grade[]).map((g) => nextInterval(undefined, g)), [0, 1, 1, 4]));
t('second success: 模糊 2 · 记得 3 · 简单 6 days', () => eq(([1, 2, 3] as Grade[]).map((g) => nextInterval(R({ reps: 1, interval: 1 }), g)), [2, 3, 6]));
t('mature card: 模糊 ×1.2, 记得 ×ease, 简单 ×ease×1.3 (always ≥ previous + 1)', () => {
  const r = R({ reps: 3, interval: 10, ease: 2.5 });
  eq(nextInterval(r, 1), 12); // ease 2.35 not used; ×1.2
  eq(nextInterval(r, 2), 25);
  eq(nextInterval(r, 3), Math.round(10 * 2.65 * 1.3)); // 34
  eq(nextInterval(R({ reps: 3, interval: 2, ease: 1.3 }), 1), 3); // round(2.4)=2 → at least prev + 1
});
t('schedule: new card graded 记得 → due tomorrow, reps 1, firstDay today', () => {
  const r = schedule(undefined, 2, NOW, TODAY);
  eq(r, { due: '2026-11-22', interval: 1, ease: 2.5, reps: 1, lapses: 0, lastGrade: 2, updatedAt: NOW, firstDay: TODAY });
});
t('schedule: 记得 ×4 grows 1 → 3 → 8 → 20 days', () => {
  const ivs: number[] = [];
  let r: ReviewRecord | undefined;
  for (let i = 0; i < 4; i++) { r = schedule(r, 2, NOW, TODAY); ivs.push(r.interval); }
  eq(ivs, [1, 3, 8, 20]);
});
t('schedule: due = today + interval, computed from the review day (not the old due day)', () => {
  const late = schedule(R({ due: '2026-11-01', reps: 2, interval: 4 }), 2, NOW, TODAY); // reviewed 20 days late
  eq(late.interval, 10); eq(late.due, addDays(TODAY, 10));
});
t('schedule: interval capped at 365 days', () => {
  eq(nextInterval(R({ reps: 9, interval: 300, ease: 3 }), 3), MAX_INTERVAL);
  eq(chain([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]).interval, MAX_INTERVAL);
});
t('schedule: input record is not mutated', () => { const r = R({ reps: 2, interval: 3 }); const c = { ...r }; schedule(r, 0, NOW, TODAY); eq(r, c); });

// ---- ease bounds
t('ease: 忘了 −0.2, 模糊 −0.15, 记得 ±0, 简单 +0.15', () => eq(([0, 1, 2, 3] as Grade[]).map((g) => schedule(R({ reps: 2, interval: 3 }), g, NOW, TODAY).ease), [2.3, 2.35, 2.5, 2.65]));
t(`ease never below ${EASE_MIN}`, () => { eq(chain([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).ease, EASE_MIN); eq(chain([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).ease, EASE_MIN); });
t(`ease never above ${EASE_MAX}`, () => eq(chain([3, 3, 3, 3, 3, 3, 3]).ease, EASE_MAX));
t('ease has no float drift (2 decimals)', () => { const e = chain([3, 1, 3, 1, 0, 3, 2]).ease; eq(e, Math.round(e * 100) / 100); });
t(`new cards start at ease ${EASE_START}`, () => eq(schedule(undefined, 2, NOW, TODAY).ease, EASE_START));

// ---- lapses
t('lapse: 忘了 on a learned card → interval 0, due today, reps reset, lapses +1', () => {
  const r = schedule(R({ reps: 4, interval: 30, ease: 2.5, lapses: 1 }), 0, NOW, TODAY);
  eq([r.interval, r.due, r.reps, r.lapses, r.lastGrade, r.ease], [0, TODAY, 0, 2, 0, 2.3]);
});
t('lapse: relearning restarts at 1 day, then 3 (ease kept lower)', () => {
  const r1 = schedule(schedule(R({ reps: 4, interval: 30 }), 0, NOW, TODAY), 2, NOW, TODAY);
  eq([r1.interval, r1.reps], [1, 1]);
  eq(schedule(r1, 2, NOW, '2026-11-22').interval, 3);
});
t('lapse: 忘了 on a brand-new card is not counted as a lapse', () => eq(schedule(undefined, 0, NOW, TODAY).lapses, 0));
t('lapse: firstDay is kept from the first review', () => eq(schedule(R({ firstDay: '2026-01-01', reps: 2, interval: 5 }), 0, NOW, TODAY).firstDay, '2026-01-01'));

// ---- due computation, new-card limit, filters
const V = (o: Partial<VocabItem> = {}): VocabItem => W({ ctx: [], ...o });
const ctxOf = (a: string) => ({ a, v: 1, p: 0, s: 'x', form: 'x', at: 1 });
t('dueToday: due reviews (oldest first) + new words (oldest saved first); mastered, future and orphans skipped', () => {
  const vocab = { a: V({ addedAt: 3 }), b: V({ addedAt: 1 }), c: V(), d: V(), e: V({ mastered: true }), f: V() };
  const review: ReviewMap = { c: R({ due: '2026-11-20', reps: 2 }), d: R({ due: '2026-11-22', reps: 2 }), f: R({ due: '2026-11-01', reps: 1 }), gone: R({ due: '2026-01-01' }) };
  const d = dueToday(vocab, review, TODAY);
  eq(d.review, ['f', 'c']); eq(d.fresh, ['b', 'a']); eq(d.total, 4); eq(d.freshLeft, 0);
});
t('dueToday: "today" is the local day passed in — a card due 11-22 is due in Shanghai at 00:30 but not yet in New York', () => {
  const vocab = { x: V() }, review = { x: R({ due: '2026-11-22', reps: 1, interval: 1 }) };
  const ts = Date.parse('2026-11-21T16:30:00Z');
  eq(dueToday(vocab, review, dayKey(ts, -480)).total, 1);
  eq(dueToday(vocab, review, dayKey(ts, 300)).total, 0);
});
t(`dueToday: at most ${NEW_PER_DAY} new words a day, counting new words already started today`, () => {
  const vocab: Record<string, VocabItem> = {};
  for (let i = 0; i < 30; i++) vocab['w' + String(i).padStart(2, '0')] = V({ addedAt: i });
  eq(dueToday(vocab, {}, TODAY).fresh.length, NEW_PER_DAY);
  eq(dueToday(vocab, {}, TODAY).freshLeft, 10);
  const started: ReviewMap = {};
  for (let i = 0; i < 5; i++) started['w' + String(i).padStart(2, '0')] = R({ due: '2026-11-22', reps: 1, interval: 1, firstDay: TODAY });
  const d = dueToday(vocab, started, TODAY);
  eq(d.fresh.length, 15); eq(d.fresh[0], 'w05'); eq(d.review.length, 0);
  eq(dueToday(vocab, started, '2026-11-22').fresh.length, 20); // a new day, a new quota
  eq(dueToday(vocab, started, '2026-11-22').review.length, 5);
});
t('dueToday: a new card graded 忘了 stays due today (counted as a review)', () => {
  const r = schedule(undefined, 0, NOW, TODAY);
  eq(dueToday({ x: V() }, { x: r }, TODAY), { review: ['x'], fresh: [], freshLeft: 0, total: 1 });
});
t('grading 记得 removes the card from today and brings it back tomorrow', () => {
  const vocab = { x: V() };
  const r = schedule(undefined, 2, NOW, TODAY);
  eq(dueToday(vocab, { x: r }, TODAY).total, 0);
  eq(dueToday(vocab, { x: r }, '2026-11-22').review, ['x']);
});
t('poolOf: article id → pool', () => eq(['b1-001', 'b2-100', 'c1-050', 'cl-007', 'zz-1'].map(poolOf), ['B1', 'B2', 'C1', 'classics', '']));
t('filters: pool (any saved sentence), CEFR (word level, "-" = none), article; AND-combined', () => {
  const w = V({ snap: { cefr: 'B2' }, ctx: [ctxOf('b1-002'), ctxOf('cl-010')] });
  const none = V({ snap: {}, ctx: [ctxOf('c1-001')] });
  ok(matchesFilter(w, {})); ok(matchesFilter(w, { pool: 'B1' })); ok(matchesFilter(w, { pool: 'classics' })); ok(!matchesFilter(w, { pool: 'C1' }));
  ok(matchesFilter(w, { cefr: 'B2' })); ok(!matchesFilter(w, { cefr: 'C1' })); ok(!matchesFilter(w, { cefr: '-' })); ok(matchesFilter(none, { cefr: '-' }));
  ok(matchesFilter(w, { article: 'cl-010' })); ok(!matchesFilter(w, { article: 'b1-003' }));
  ok(matchesFilter(w, { pool: 'B1', cefr: 'B2', article: 'b1-002' })); ok(!matchesFilter(w, { pool: 'B1', cefr: 'C1' }));
  ok(!matchesFilter(V({ ctx: [] }), { pool: 'B1' })); // a word without saved sentences has no source
});
t('dueToday with a filter only counts matching words', () => {
  const vocab = { a: V({ snap: { cefr: 'B1' }, ctx: [ctxOf('b1-001')] }), b: V({ snap: { cefr: 'C1' }, ctx: [ctxOf('cl-001')] }) };
  eq(dueToday(vocab, {}, TODAY, { pool: 'classics' }).fresh, ['b']);
  eq(dueToday(vocab, {}, TODAY, { cefr: 'B1' }).fresh, ['a']);
  eq(dueToday(vocab, {}, TODAY, { article: 'b1-001', cefr: 'C1' }).total, 0);
});
t('fmtInterval', () => eq([0, 1, 5, 60, 365].map(fmtInterval), ['今天', '1 天', '5 天', '2 个月', '1 年']));

// ---- review storage: normalize, merge, prune
t('normalizeRecord: repairs fields, clamps ease, converts a timestamp due, drops junk', () => {
  eq(normalizeRecord({ due: '2026-11-21', ease: 9, interval: 2.6, reps: -1, lastGrade: 7 }), { due: '2026-11-21', interval: 3, ease: EASE_MAX, reps: 0, lapses: 0, lastGrade: 0, updatedAt: 0 });
  eq(normalizeRecord({ due: Date.parse('2026-11-21T12:00:00Z') })!.due.length, 10);
  eq(normalizeRecord({ due: 'tomorrow' }), null); eq(normalizeRecord(null), null); eq(normalizeRecord([1]), null);
  eq(Object.keys(normalizeReview({ a: R(), b: { due: 'x' }, c: 5 })), ['a']); eq(normalizeReview('x'), {});
});
t('mergeRecord: newer updatedAt wins; tie → more reps (commutative)', () => {
  const a = R({ updatedAt: 10, reps: 1 }), b = R({ updatedAt: 20, reps: 0, due: '2026-11-21' });
  eq(mergeRecord(a, b), b); eq(mergeRecord(b, a), b);
  const c = R({ updatedAt: 5, reps: 3 }), d = R({ updatedAt: 5, reps: 1 });
  eq(mergeRecord(c, d), c); eq(mergeRecord(d, c), c);
});
t('mergeReview: union, local-only kept, counts added / updated, idempotent', () => {
  const local: ReviewMap = { go: R({ updatedAt: 10, reps: 2 }), cat: R({ updatedAt: 50 }) };
  const inc: ReviewMap = { go: R({ updatedAt: 30, reps: 3, due: '2026-12-01' }), cat: R({ updatedAt: 40, reps: 9 }), dog: R() };
  const r = mergeReview(local, inc);
  eq(Object.keys(r.map).sort(), ['cat', 'dog', 'go']); eq(r.map.go.reps, 3); eq(r.map.cat.reps, 0); eq([r.added, r.updated], [1, 1]);
  eq(local.go.reps, 2);
  const again = mergeReview(r.map, r.map); eq(again.map, r.map); eq([again.added, again.updated], [0, 0]);
});
t('pruneReview: drops records of words not in the vocab book', () => eq(Object.keys(pruneReview({ go: R(), gone: R() }, { go: W() })), ['go']));

// ---- backup schema 3
const rev: ReviewMap = { go: R({ due: '2026-11-25', interval: 4, reps: 2, updatedAt: 99 }) };
t('export schema 3: review included, orphan records left out', () => {
  const b = makeBackup(hist, vocab, {}, new Date(0), { ...rev, gone: R() });
  eq(b.schema, 3); eq(b.review, rev);
});
t('export → import round-trip keeps the review data', () => {
  const p = parseBackupText(JSON.stringify(makeBackup(hist, vocab, {}, new Date(), rev)));
  eq(p.review, rev); ok(p.hasReview); eq(p.fileSchema, 3);
});
t('import schema 2 (no review): history + vocab merge, review untouched', () => {
  const p = parseBackupText(JSON.stringify({ schema: 2, app: 'english-reader', exportedAt: 'x', history: hist, vocab: { cat: W() }, settings: {} }));
  ok(!p.hasReview); eq(p.review, {}); eq(p.fileSchema, 2);
  eq(mergeReview(rev, p.review).map, rev);
  eq(Object.keys(mergeVocab(vocab, p.vocab).map).sort(), ['cat', 'go']);
});
t('import schema 1 / bare vocab files: no review, still merge', () => {
  for (const f of [{ schema: 1, app: 'english-reader', vocab: { cat: W() } }, { vocab: { cat: W() } }, { cat: W() }]) {
    const p = parseBackupText(JSON.stringify(f));
    ok(!p.hasReview); eq(p.review, {}); ok('cat' in p.vocab);
  }
});
t('import schema 2 file that happens to carry a review field ignores it (not part of that format)', () => ok(!parseBackupText(JSON.stringify({ schema: 2, app: 'english-reader', vocab, review: rev })).hasReview));
t('import schema 3: bad review records dropped, good ones kept', () => {
  const p = parseBackupText(JSON.stringify({ schema: 3, app: 'english-reader', vocab, history: {}, review: { go: rev.go, bad: { due: 7e99 }, junk: 'x' } }));
  eq(p.review, rev);
});
t('import schema 3 merge: newest updatedAt wins per word', () => {
  const local: ReviewMap = { go: R({ updatedAt: 200, reps: 5, due: '2027-01-01' }) };
  const p = parseBackupText(JSON.stringify(makeBackup(hist, vocab, {}, new Date(), rev)));
  eq(mergeReview(local, p.review).map.go.reps, 5); // local is newer
  eq(mergeReview({ go: R({ updatedAt: 1 }) }, p.review).map.go, rev.go); // file is newer
});

console.log(`unit (reading history / backup / review): ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
