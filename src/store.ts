// localStorage-backed user data. Prefix ra:v1:, JSON strings. All writes are guarded (quota errors are surfaced).
import { toast } from './dom.ts';
import type { Level } from './shared/types.ts';
import { PROGRESS_SCHEMA, applyPatch, makeBackup, mergeProgress, mergeVocab, migrateProgress, parseBackupText } from './shared/history.ts';
import type { Backup, ParsedBackup, Progress, ProgressMap, Status, VocabCtx, VocabItem, VocabMap } from './shared/history.ts';
export type { Backup, ParsedBackup, Progress, ProgressMap, Status, VocabCtx, VocabItem, VocabMap };

export const PREFIX = 'ra:v1:';
/** storage schema (ra:v1:meta.schema); 2 = progress entries carry readAt (0.6.0) */
export const SCHEMA = PROGRESS_SCHEMA;

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

type Listener = (what: 'settings' | 'progress' | 'vocab' | 'all') => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit: Listener = (w) => listeners.forEach((f) => f(w));

let settings: Settings = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>('settings', {}) };
let vocab: VocabMap = read<VocabMap>('vocab', {});
type Meta = { schema: number; createdAt: number; lastBackupAt?: number; migratedAt?: number };
export const getMeta = () => read<Meta>('meta', { schema: SCHEMA, createdAt: 0 });
let progress: ProgressMap = loadProgress();

/** Reads ra:v1:progress and migrates older entries in place (schema 1 → 2: readAt added). Nothing is dropped:
 *  the untouched old value is kept once under ra:v1:progress.bak-v<old schema>. */
function loadProgress(): ProgressMap {
  const metaRaw = localStorage.getItem(PREFIX + 'meta');
  const raw = localStorage.getItem(PREFIX + 'progress');
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  const map = migrateProgress(parsed);
  if (!metaRaw) {
    write('meta', { schema: SCHEMA, createdAt: Date.now() });
    if (raw) write('progress', map);
    return map;
  }
  const meta = getMeta();
  if ((meta.schema ?? 1) < SCHEMA) {
    try { if (raw) localStorage.setItem(`${PREFIX}progress.bak-v${meta.schema ?? 1}`, raw); } catch { /* quota: the migration itself is lossless */ }
    write('progress', map);
    write('meta', { ...meta, schema: SCHEMA, migratedAt: Date.now() });
  }
  return map;
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
export function removeWord(lemma: string): VocabItem | undefined {
  const it = vocab[lemma];
  delete vocab[lemma];
  write('vocab', vocab);
  emit('vocab');
  return it;
}
export function restoreWord(lemma: string, it: VocabItem) {
  vocab[lemma] = it;
  write('vocab', vocab);
  emit('vocab');
}
export function setMastered(lemma: string, v: boolean) {
  if (!vocab[lemma]) return;
  vocab[lemma].mastered = v;
  write('vocab', vocab);
  emit('vocab');
}

// ---------- backup ----------
/** One JSON file: reading history + vocab book (+ settings), with a schema version. */
export const exportBackup = (): Backup<Settings> => makeBackup(progress, vocab, settings);
export const parseBackup = (text: string): ParsedBackup => parseBackupText(text);

/** Import always merges (never replaces): local-only words / history stay, the newer change per article wins.
 *  Settings in the file are ignored (they are device preferences). */
export function importBackup(b: ParsedBackup): { wordsAdded: number; historyAdded: number; historyUpdated: number } {
  const v = mergeVocab(vocab, b.vocab);
  const p = mergeProgress(progress, b.history);
  vocab = v.map;
  progress = p.map;
  write('vocab', vocab);
  write('progress', progress);
  emit('all');
  return { wordsAdded: v.added, historyAdded: p.added, historyUpdated: p.updated };
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
