// localStorage-backed user data. Prefix ra:v1:, JSON strings. All writes are guarded (quota errors are surfaced).
import { toast } from './dom.ts';
import type { Level } from './shared/types.ts';
import { PROGRESS_SCHEMA, applyPatch, makeBackup, mergeProgress, mergeVocab, migrateProgress, parseBackupText } from './shared/history.ts';
import type { Backup, ParsedBackup, Progress, ProgressMap, Status, VocabCtx, VocabItem, VocabMap } from './shared/history.ts';
import { dayKey, dueToday, mergeReview, normalizeReview, pruneReview, schedule } from './shared/review.ts';
import type { DueInfo, Grade, ReviewFilter, ReviewMap, ReviewRecord } from './shared/review.ts';
import { mergeResults, normalizeResults, suggest } from './shared/leveltest.ts';
import type { LevelResult, Suggestion } from './shared/leveltest.ts';
export type { Backup, ParsedBackup, Progress, ProgressMap, Status, VocabCtx, VocabItem, VocabMap };
export type { DueInfo, Grade, ReviewFilter, ReviewMap, ReviewRecord };
export type { LevelResult, Suggestion };

export const PREFIX = 'ra:v1:';
/** storage schema (ra:v1:meta.schema): 2 = progress entries carry readAt (0.6.0); 3 = ra:v1:review added (0.7.0);
 *  4 = ra:v1:levelTest added (难度自测 results, 0.8.0) */
export const SCHEMA = 4;

export interface Settings {
  fontSize: number; // 0..3
  theme: 'light' | 'dark' | 'system';
  accent: 'en-US' | 'en-GB';
  autoCollect: boolean;
  autoMarkRead: boolean;
  highlightKnown: boolean;
  lastLevel: Level;
  /** reading speed for the estimated reading time (words per minute) */
  wpm: number;
}
export const DEFAULT_SETTINGS: Settings = {
  fontSize: 1,
  theme: 'system',
  accent: 'en-US',
  autoCollect: true,
  autoMarkRead: true,
  highlightKnown: true,
  lastLevel: 'B1',
  wpm: 200,
};
export const WPM_OPTIONS = [120, 160, 200, 250, 300];
export const minutesOf = (wordCount: number) => Math.max(1, Math.ceil(wordCount / (getSettings().wpm || 200)));

function read<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw ? ({ ...(Array.isArray(fallback) ? [] : {}), ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

let warned = false;
function write(name: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch (e) {
    if (!warned) {
      warned = true;
      toast('⚠️ 本地存储写入失败（可能已满），请到生词本页导出备份。', undefined, 8000);
      setTimeout(() => (warned = false), 10000);
    }
    console.error('localStorage write failed', e);
    return false;
  }
}

type Listener = (what: 'settings' | 'progress' | 'vocab' | 'review' | 'levelTest' | 'all') => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit: Listener = (w) => listeners.forEach((f) => f(w));

let settings: Settings = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>('settings', {}) };
let vocabOk = true;
let vocab: VocabMap = (() => {
  const raw = localStorage.getItem(PREFIX + 'vocab');
  try { return raw ? { ...JSON.parse(raw) } : {}; } catch { vocabOk = false; return {}; }
})();
type Meta = { schema: number; createdAt: number; lastBackupAt?: number; migratedAt?: number };
export const getMeta = () => read<Meta>('meta', { schema: SCHEMA, createdAt: 0 });
let progress: ProgressMap = {};
let review: ReviewMap = {};
let levelTest: LevelResult[] = [];
migrateStorage();

/** Loads progress + review and upgrades older stores in place. Nothing is dropped:
 *  schema 1 → 2: progress entries get readAt; the untouched old progress is kept once under ra:v1:progress.bak-v1.
 *  schema 2 → 3: ra:v1:review is added (empty; an existing one is kept); the old meta is kept under ra:v1:meta.bak-v2.
 *  schema 3 → 4: ra:v1:levelTest is added (empty list; an existing one is kept); the old meta is kept under ra:v1:meta.bak-v3.
 *  Review records of words no longer in the vocab book are pruned (unless the vocab book itself failed to parse). */
function migrateStorage() {
  const metaRaw = localStorage.getItem(PREFIX + 'meta');
  const raw = localStorage.getItem(PREFIX + 'progress');
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  progress = migrateProgress(parsed);
  const revRaw = localStorage.getItem(PREFIX + 'review');
  let revParsed: unknown = {};
  try { revParsed = revRaw ? JSON.parse(revRaw) : {}; } catch { revParsed = {}; }
  review = normalizeReview(revParsed);
  const ltRaw = localStorage.getItem(PREFIX + 'levelTest');
  let ltParsed: unknown = [];
  try { ltParsed = ltRaw ? JSON.parse(ltRaw) : []; } catch { ltParsed = []; }
  levelTest = normalizeResults(ltParsed);
  if (vocabOk) {
    const pruned = pruneReview(review, vocab);
    if (Object.keys(pruned).length !== Object.keys(review).length) { review = pruned; write('review', review); }
  }
  if (!metaRaw) {
    write('meta', { schema: SCHEMA, createdAt: Date.now() });
    if (raw) write('progress', progress);
    if (!revRaw) write('review', review);
    if (!ltRaw) write('levelTest', levelTest);
    return;
  }
  const meta = getMeta();
  const old = meta.schema ?? 1;
  if (old >= SCHEMA) return;
  if (old < PROGRESS_SCHEMA) {
    try { if (raw) localStorage.setItem(`${PREFIX}progress.bak-v${old}`, raw); } catch { /* quota: the migration itself is lossless */ }
    write('progress', progress);
  }
  try { localStorage.setItem(`${PREFIX}meta.bak-v${old}`, metaRaw); } catch { /* quota */ }
  if (!revRaw) write('review', review);
  if (!ltRaw) write('levelTest', levelTest);
  write('meta', { ...meta, schema: SCHEMA, migratedAt: Date.now() });
}
export function markBackup() {
  write('meta', { ...getMeta(), lastBackupAt: Date.now() });
  emit('settings');
}

export const getSettings = () => settings;
export function setSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  write('settings', settings);
  applyAppearance();
  emit('settings');
}
export function resetSettings() {
  settings = { ...DEFAULT_SETTINGS, lastLevel: settings.lastLevel };
  write('settings', settings);
  applyAppearance();
  emit('settings');
}

export const getProgress = () => progress;
export const getStatus = (id: string): Status => progress[id]?.status ?? 'unread';
export function setProgress(id: string, patch: Partial<Progress>, silent = false) {
  progress[id] = applyPatch(progress[id], patch, Date.now());
  write('progress', progress);
  if (!silent) emit('progress');
}
export function clearProgress(id: string) {
  delete progress[id];
  write('progress', progress);
  emit('progress');
}

export const getVocab = () => vocab;
export const hasWord = (lemma: string) => Object.prototype.hasOwnProperty.call(vocab, lemma);
export const isActiveWord = (lemma: string) => hasWord(lemma) && !vocab[lemma].mastered;

export function recordLookup(lemma: string, snap: VocabItem['snap'], ctx: VocabCtx | null, add: boolean) {
  const now = Date.now();
  let it = vocab[lemma];
  if (!it) {
    if (!add) return;
    it = vocab[lemma] = { addedAt: now, lastAt: now, count: 0, mastered: false, snap, ctx: [] };
  }
  it.count += 1;
  it.lastAt = now;
  if (snap && (snap.zh || snap.p)) it.snap = snap;
  if (ctx && !it.ctx.some((c) => c.a === ctx.a && c.s === ctx.s)) {
    it.ctx.push(ctx);
    if (it.ctx.length > 5) it.ctx.shift();
  }
  write('vocab', vocab);
  emit('vocab');
}

export function addWord(lemma: string, snap: VocabItem['snap'], ctx: VocabCtx | null) {
  const now = Date.now();
  if (hasWord(lemma)) {
    vocab[lemma].mastered = false;
  } else {
    vocab[lemma] = { addedAt: now, lastAt: now, count: 1, mastered: false, snap, ctx: ctx ? [ctx] : [] };
  }
  write('vocab', vocab);
  emit('vocab');
}
/** review records of words removed in this session, so 撤销 (undo) brings the schedule back too */
const removedReview = new Map<string, ReviewRecord>();
export function removeWord(lemma: string): VocabItem | undefined {
  const it = vocab[lemma];
  delete vocab[lemma];
  write('vocab', vocab);
  if (review[lemma]) {
    removedReview.set(lemma, review[lemma]);
    delete review[lemma];
    write('review', review);
  }
  emit('vocab');
  return it;
}
export function restoreWord(lemma: string, it: VocabItem) {
  vocab[lemma] = it;
  write('vocab', vocab);
  const r = removedReview.get(lemma);
  if (r && !review[lemma]) { review[lemma] = r; write('review', review); }
  removedReview.delete(lemma);
  emit('vocab');
}
export function setMastered(lemma: string, v: boolean) {
  if (!vocab[lemma]) return;
  vocab[lemma].mastered = v;
  write('vocab', vocab);
  emit('vocab');
}

// ---------- review (生词复习) ----------
export const getReview = () => review;
export const today = () => dayKey(Date.now());
export const getDue = (f: ReviewFilter = {}): DueInfo => dueToday(vocab, review, today(), f);
/** Grade one card (0 忘了 … 3 简单) and store the new schedule. */
export function gradeWord(lemma: string, g: Grade): ReviewRecord | undefined {
  if (!vocab[lemma]) return undefined;
  const now = Date.now();
  review[lemma] = schedule(review[lemma], g, now, dayKey(now));
  write('review', review);
  emit('review');
  return review[lemma];
}

// ---------- 难度自测 (level self-test) ----------
/** all results, oldest first */
export const getLevelResults = () => levelTest;
export const getLatestLevel = (): LevelResult | undefined => levelTest.at(-1);
export function addLevelResult(r: LevelResult) {
  levelTest = mergeResults(levelTest, [r]).list;
  write('levelTest', levelTest);
  emit('levelTest');
}
export const getSuggestion = (): Suggestion => suggest(getLatestLevel(), progress, vocab, Date.now());

// ---------- backup ----------
/** One JSON file: reading history + vocab book + review schedule + level-test results (+ settings), with a schema version. */
export const exportBackup = (): Backup<Settings> => makeBackup(progress, vocab, settings, new Date(), review, levelTest);
export const parseBackup = (text: string): ParsedBackup => parseBackupText(text);

/** Import always merges (never replaces): local-only words / history stay, the newer change per article wins.
 *  Settings in the file are ignored (they are device preferences). */
export function importBackup(b: ParsedBackup): { wordsAdded: number; historyAdded: number; historyUpdated: number; reviewAdded: number; reviewUpdated: number; levelTestAdded: number } {
  const v = mergeVocab(vocab, b.vocab);
  const lt = mergeResults(levelTest, b.levelTest ?? []);
  levelTest = lt.list;
  write('levelTest', levelTest);
  const p = mergeProgress(progress, b.history);
  const r = mergeReview(review, pruneReview(b.review ?? {}, v.map));
  vocab = v.map;
  progress = p.map;
  review = pruneReview(r.map, vocab);
  write('vocab', vocab);
  write('progress', progress);
  write('review', review);
  emit('all');
  return { wordsAdded: v.added, historyAdded: p.added, historyUpdated: p.updated, reviewAdded: r.added, reviewUpdated: r.updated, levelTestAdded: lt.added };
}

export const STORAGE_WARN_BYTES = 4 * 1024 * 1024;
export function storageUsage(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(PREFIX)) n += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2;
  }
  return n;
}

// ---------- appearance ----------
const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyAppearance() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.fs = String(settings.fontSize);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
}
mq.addEventListener('change', () => settings.theme === 'system' && applyAppearance());
