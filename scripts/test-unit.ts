// Unit tests for the reading history (阅读记录) storage, migration, merge and backup file format (src/shared/history.ts).
//   npm run test:unit
import { deepStrictEqual as eq, ok, throws } from 'node:assert/strict';
import { BACKUP_SCHEMA, PROGRESS_SCHEMA, applyPatch, makeBackup, mergeEntry, mergeProgress, mergeVocab, migrateEntry, migrateProgress, parseBackupText, readCounts } from '../src/shared/history.ts';
import type { ProgressMap, VocabItem } from '../src/shared/history.ts';

let n = 0, fails = 0;
const t = (name: string, fn: () => void) => {
  n++;
  try { fn(); } catch (e) { fails++; console.log(`  ✗ ${name}\n    ${(e as Error).message.split('\n').join('\n    ')}`); }
};
const W = (o: Partial<VocabItem> = {}): VocabItem => ({ addedAt: 1, lastAt: 1, count: 1, mastered: false, snap: { zh: 'x' }, ctx: [], ...o });

// ---- schema versions
t('schema versions are 2', () => { eq(PROGRESS_SCHEMA, 2); eq(BACKUP_SCHEMA, 2); });

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
  eq(b, { schema: 2, app: 'english-reader', exportedAt: '1970-01-01T00:00:00.000Z', history: hist, vocab, settings: { theme: 'dark' } });
});
t('export → import round-trip is lossless', () => {
  const p = parseBackupText(JSON.stringify(makeBackup(hist, vocab, {})));
  eq(p.history, hist); eq(p.vocab, vocab); eq(p.fileSchema, 2); ok(p.hasHistory);
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
  throws(() => parseBackupText(JSON.stringify({ schema: 3, app: 'english-reader', vocab })), /schema 版本（3）/);
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

console.log(`unit (reading history / backup): ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
