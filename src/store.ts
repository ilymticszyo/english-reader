// localStorage-backed user data. Prefix ra:v1:, JSON strings. All writes are guarded (quota errors are surfaced).
import { toast } from './dom.ts';
import type { Level } from './shared/types.ts';

export const PREFIX = 'ra:v1:';
export const SCHEMA = 1;

export interface Settings {
  fontSize: number; // 0..3
  theme: 'light' | 'dark' | 'system';
  accent: 'en-US' | 'en-GB';
  autoCollect: boolean;
  autoMarkRead: boolean;
  highlightKnown: boolean;
  lastLevel: Level;
}
export const DEFAULT_SETTINGS: Settings = {
  fontSize: 1,
  theme: 'system',
  accent: 'en-US',
  autoCollect: true,
  autoMarkRead: true,
  highlightKnown: true,
  lastLevel: 'B1',
};

export type Status = 'unread' | 'reading' | 'read';
export interface Progress {
  status: Status;
  scroll: number; // 0..1 fraction of article body
  updatedAt: number;
}
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
export type ProgressMap = Record<string, Progress>;

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
let progress: ProgressMap = read<ProgressMap>('progress', {});
let vocab: VocabMap = read<VocabMap>('vocab', {});
if (!localStorage.getItem(PREFIX + 'meta')) write('meta', { schema: SCHEMA, createdAt: Date.now() });

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
  const cur = progress[id] ?? { status: 'unread' as Status, scroll: 0, updatedAt: 0 };
  progress[id] = { ...cur, ...patch, updatedAt: Date.now() };
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
export interface Backup {
  schema: number;
  app: 'english-reader';
  exportedAt: string;
  settings: Settings;
  progress: ProgressMap;
  vocab: VocabMap;
}
export function exportBackup(): Backup {
  return { schema: SCHEMA, app: 'english-reader', exportedAt: new Date().toISOString(), settings, progress, vocab };
}

export function parseBackup(text: string): Backup {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!o || o.app !== 'english-reader') throw new Error('这不是本应用导出的备份文件');
  if (typeof o.schema !== 'number' || o.schema > SCHEMA) throw new Error(`备份文件的 schema 版本（${o.schema}）高于当前支持的版本（${SCHEMA}）`);
  if (!o.vocab || typeof o.vocab !== 'object') throw new Error('备份文件缺少 vocab 字段');
  return {
    schema: o.schema,
    app: 'english-reader',
    exportedAt: o.exportedAt ?? '',
    settings: { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) },
    progress: o.progress ?? {},
    vocab: o.vocab,
  };
}

export function importBackup(b: Backup, mode: 'merge' | 'overwrite') {
  if (mode === 'overwrite') {
    vocab = b.vocab;
    progress = b.progress;
    settings = { ...DEFAULT_SETTINGS, ...b.settings };
  } else {
    for (const [k, inc] of Object.entries(b.vocab)) {
      const cur = vocab[k];
      if (!cur) {
        vocab[k] = inc;
        continue;
      }
      const ctx = [...cur.ctx];
      for (const c of inc.ctx) if (!ctx.some((x) => x.a === c.a && x.s === c.s)) ctx.push(c);
      vocab[k] = {
        addedAt: Math.min(cur.addedAt, inc.addedAt),
        lastAt: Math.max(cur.lastAt, inc.lastAt),
        count: Math.max(cur.count, inc.count),
        mastered: cur.mastered && inc.mastered,
        snap: cur.snap?.zh ? cur.snap : inc.snap,
        ctx: ctx.slice(-5),
      };
    }
    for (const [id, inc] of Object.entries(b.progress)) {
      if (!progress[id] || progress[id].updatedAt < inc.updatedAt) progress[id] = inc;
    }
  }
  write('vocab', vocab);
  write('progress', progress);
  write('settings', settings);
  applyAppearance();
  emit('all');
}

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
