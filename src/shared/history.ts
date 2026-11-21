// Reading history (阅读记录) + backup file format. Pure functions (no DOM / localStorage) so they run in node unit tests too.
//
// Storage: localStorage `ra:v1:progress` = { [articleId | classicId]: Progress }  (keyed by article ID; cl-… ids are classics)
//   progress schema 1 (≤ 0.5.0): { status, scroll, updatedAt }
//   progress schema 2 (0.6.0):   + readAt (first time the article was finished; removed when marked unread again)
// Backup file (one JSON): { schema: 3, app: 'english-reader', exportedAt, history, vocab, review, settings }
//   schema 3 (0.7.0) adds `review` (spaced-repetition data per word, see review.ts); schema 2 files have no review;
//   schema 1 files used `progress` instead of `history`; vocab-only files (no progress at all) are accepted too.
import { normalizeReview, pruneReview } from './review.ts';
import type { ReviewMap } from './review.ts';

export type Status = 'unread' | 'reading' | 'read';
export interface Progress {
  status: Status;
  scroll: number; // 0..1 fraction of the article body
  updatedAt: number;
  /** when the article was (first) finished; only present while status is 'read' */
  readAt?: number;
}
export type ProgressMap = Record<string, Progress>;
export interface VocabCtx {
  a: string; // article id
  v: number; // article version
  p: number; // paragraph index
  s: string; // sentence text
  form: string;
  at: number;
}
export interface VocabItem {
  addedAt: number;
  lastAt: number;
  count: number;
  mastered: boolean;
  snap: { p?: string; zh?: string; cefr?: string };
  ctx: VocabCtx[];
}
export type VocabMap = Record<string, VocabItem>;

export const PROGRESS_SCHEMA = 2;
export const BACKUP_SCHEMA = 3;
const STATUSES: Status[] = ['unread', 'reading', 'read'];
const RANK: Record<Status, number> = { unread: 0, reading: 1, read: 2 };
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);

/** One stored entry (any older shape) → a schema-2 entry. Unknown extra fields are kept. Returns null for junk. */
export function migrateEntry(v: unknown): Progress | null {
  if (typeof v === 'string' && (STATUSES as string[]).includes(v)) v = { status: v }; // defensive: a bare status string
  if (!isObj(v)) return null;
  const scroll = Math.max(0, Math.min(1, num(v.scroll)));
  const status: Status = (STATUSES as string[]).includes(v.status) ? v.status : scroll >= 0.99 ? 'read' : scroll > 0 ? 'reading' : 'unread';
  const out: Progress = { ...v, status, scroll, updatedAt: num(v.updatedAt) };
  if (status === 'read') out.readAt = num(v.readAt, out.updatedAt);
  else delete out.readAt;
  return out;
}

/** Whole progress map (any schema) → schema 2. Never drops a valid entry. */
export function migrateProgress(raw: unknown): ProgressMap {
  const out: ProgressMap = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const e = migrateEntry(v);
    if (e) out[id] = e;
  }
  return out;
}

/** Apply a status/scroll change, keeping readAt in step with the status. */
export function applyPatch(cur: Progress | undefined, patch: Partial<Progress>, now: number): Progress {
  const base: Progress = cur ?? { status: 'unread', scroll: 0, updatedAt: 0 };
  const next: Progress = { ...base, ...patch, updatedAt: now };
  if (next.status === 'read') next.readAt = base.status === 'read' && base.readAt ? base.readAt : (patch.readAt ?? now);
  else delete next.readAt;
  return next;
}

/** Merge two entries for the same id: the more recent change wins (so an "unmark" on another device sticks);
 *  on a tie the further status wins. readAt keeps the earliest finish time. */
export function mergeEntry(a: Progress, b: Progress): Progress {
  const win = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b) : RANK[a.status] !== RANK[b.status] ? (RANK[a.status] > RANK[b.status] ? a : b) : a.scroll >= b.scroll ? a : b;
  const lose = win === a ? b : a;
  const out: Progress = { ...lose, ...win };
  if (out.status === 'read') {
    const times = [a, b].filter((x) => x.status === 'read' && x.readAt).map((x) => x.readAt!);
    out.readAt = times.length ? Math.min(...times) : out.updatedAt;
  } else delete out.readAt;
  return out;
}

export function mergeProgress(local: ProgressMap, incoming: ProgressMap): { map: ProgressMap; added: number; updated: number } {
  const map: ProgressMap = { ...local };
  let added = 0, updated = 0;
  for (const [id, inc] of Object.entries(incoming)) {
    const cur = map[id];
    if (!cur) { map[id] = inc; added++; continue; }
    const m = mergeEntry(cur, inc);
    if (m.status !== cur.status || m.scroll !== cur.scroll || m.updatedAt !== cur.updatedAt || m.readAt !== cur.readAt) updated++;
    map[id] = m;
  }
  return { map, added, updated };
}

export function normalizeVocabItem(v: unknown): VocabItem | null {
  if (!isObj(v)) return null;
  const addedAt = num(v.addedAt);
  return {
    ...v,
    addedAt,
    lastAt: num(v.lastAt, addedAt),
    count: Math.max(1, num(v.count, 1)),
    mastered: !!v.mastered,
    snap: isObj(v.snap) ? v.snap : {},
    ctx: Array.isArray(v.ctx) ? v.ctx.filter(isObj) as VocabCtx[] : [],
  };
}

export function mergeVocab(local: VocabMap, incoming: VocabMap): { map: VocabMap; added: number } {
  const map: VocabMap = { ...local };
  let added = 0;
  for (const [k, inc] of Object.entries(incoming)) {
    const cur = map[k];
    if (!cur) { map[k] = inc; added++; continue; }
    const ctx = [...cur.ctx];
    for (const c of inc.ctx) if (!ctx.some((x) => x.a === c.a && x.s === c.s)) ctx.push(c);
    map[k] = {
      addedAt: Math.min(cur.addedAt, inc.addedAt),
      lastAt: Math.max(cur.lastAt, inc.lastAt),
      count: Math.max(cur.count, inc.count),
      mastered: cur.mastered && inc.mastered,
      snap: cur.snap?.zh ? cur.snap : inc.snap,
      ctx: ctx.slice(-5),
    };
  }
  return { map, added };
}

export interface Backup<S = Record<string, unknown>> {
  schema: number;
  app: 'english-reader';
  exportedAt: string;
  /** reading history keyed by article id */
  history: ProgressMap;
  vocab: VocabMap;
  /** spaced-repetition data keyed by vocab word (schema 3+) */
  review: ReviewMap;
  settings?: S;
}
export interface ParsedBackup extends Backup {
  /** schema of the file as read (0 = legacy vocab-only file without a schema field) */
  fileSchema: number;
  hasHistory: boolean;
  hasReview: boolean;
}

/** Review records of words that are not in the vocab book are left out (no orphans in the file). */
export function makeBackup<S>(history: ProgressMap, vocab: VocabMap, settings: S, now = new Date(), review: ReviewMap = {}): Backup<S> {
  return { schema: BACKUP_SCHEMA, app: 'english-reader', exportedAt: now.toISOString(), history, vocab, review: pruneReview(review, vocab), settings };
}

const looksLikeVocabMap = (o: Record<string, unknown>) => {
  const vals = Object.values(o);
  return vals.length > 0 && vals.every((v) => isObj(v) && ('addedAt' in v || 'ctx' in v || 'snap' in v));
};

/** Parse any export this app has produced: schema 3 (history + vocab + review), schema 2 (history + vocab), schema 1 (progress + vocab, or vocab only),
 *  and a bare vocab book ({ vocab } or the vocab map itself). Throws a user-facing (Chinese) message otherwise. */
export function parseBackupText(text: string): ParsedBackup {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!isObj(o)) throw new Error('这不是本应用导出的备份文件');
  let fileSchema = 0;
  if (o.app === 'english-reader') {
    if (typeof o.schema !== 'number' || o.schema < 1) throw new Error('备份文件缺少 schema 版本号');
    if (o.schema > BACKUP_SCHEMA) throw new Error(`备份文件的 schema 版本（${o.schema}）高于当前支持的版本（${BACKUP_SCHEMA}），请先更新应用`);
    fileSchema = o.schema;
  } else if (o.app !== undefined) {
    throw new Error('这不是本应用导出的备份文件');
  } else if (!isObj(o.vocab)) {
    if (!looksLikeVocabMap(o)) throw new Error('这不是本应用导出的备份文件');
    o = { vocab: o }; // a bare vocab map
  }
  if (!isObj(o.vocab)) throw new Error('备份文件缺少 vocab 字段');
  const vocab: VocabMap = {};
  for (const [k, v] of Object.entries(o.vocab)) {
    const it = normalizeVocabItem(v);
    if (it) vocab[k] = it;
  }
  const rawHist = fileSchema >= 2 ? o.history : (o.history ?? o.progress);
  const history = migrateProgress(rawHist);
  const hasReview = fileSchema >= 3 && isObj(o.review);
  const review = hasReview ? normalizeReview(o.review) : {};
  return { schema: BACKUP_SCHEMA, app: 'english-reader', exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '', history, vocab, review, settings: isObj(o.settings) ? o.settings : undefined, fileSchema, hasHistory: isObj(rawHist), hasReview };
}

/** One progress line per pool: read / total, counting only ids that exist in the current content. */
export function readCounts(progress: ProgressMap, pools: Record<string, string[]>): Record<string, { read: number; total: number }> {
  const out: Record<string, { read: number; total: number }> = {};
  for (const [k, ids] of Object.entries(pools)) out[k] = { read: ids.filter((id) => progress[id]?.status === 'read').length, total: ids.length };
  return out;
}
