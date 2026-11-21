import type { LevelTestData } from './shared/leveltest.ts';
import type { Archaisms, Article, ArticleIndex, Classic, ClassicIndex, ClassicsDict, DictEntry, EntriesMap, FormsMap, GlossItem, Level } from './shared/types.ts';
import { LEVELS } from './shared/types.ts';
import { glossKey, resolveToken, resolveWithGloss, viewOf } from './shared/text.ts';
import type { Resolved } from './shared/text.ts';

const BASE = import.meta.env.BASE_URL; // './' by default => relative to the page, works on any sub-path

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`加载失败 ${path}（${res.status}）`);
  return res.json() as Promise<T>;
}

let indexP: Promise<ArticleIndex> | null = null;
export const loadIndex = () => (indexP ??= getJson<ArticleIndex>('data/index.json'));

let levelTestP: Promise<LevelTestData> | null = null;
/** 难度自测 word banks + pseudo-words + reading passages (precached, works offline) */
export const loadLevelTest = () => (levelTestP ??= getJson<LevelTestData>('data/leveltest.json').catch((e) => { levelTestP = null; throw e; }));

const articleCache = new Map<string, Promise<Article>>();
export const loadArticle = (id: string) => {
  if (!articleCache.has(id)) articleCache.set(id, getJson<Article>(`data/articles/${id}.json`));
  return articleCache.get(id)!;
};

// ---------- dictionary ----------
let forms: FormsMap = {};
let formsP: Promise<void> | null = null;
const entries: EntriesMap = {};
const shardP = new Map<Level, Promise<void>>();
let view = viewOf(forms, entries);

/** Load forms.json + the shards for this level and every lower level. */
export async function ensureDict(level: Level): Promise<void> {
  formsP ??= getJson<FormsMap>('data/dict/forms.json').then((f) => {
    forms = f;
    view = viewOf(forms, entries);
  });
  const need = LEVELS.slice(0, LEVELS.indexOf(level) + 1);
  for (const lv of need) {
    if (!shardP.has(lv)) {
      shardP.set(
        lv,
        getJson<EntriesMap>(`data/dict/entries-${lv.toLowerCase()}.json`).then((e) => {
          Object.assign(entries, e);
        }),
      );
    }
  }
  await Promise.all([formsP, ...need.map((l) => shardP.get(l)!)]);
}

export interface LookupResult {
  token: string;
  res: Resolved | null;
  lemma: string;
  entry?: DictEntry;
  /** the clicked form's own entry (e.g. "left" the adjective), when different from the lemma */
  formEntry?: DictEntry;
  /** lexicalized -ing noun: the verb lemma's entry, folded below the card */
  altKey?: string;
  altEntry?: DictEntry;
  /** hyphenated word missing from the dictionary: each part's entry, in order */
  parts?: { w: string; l: string; entry?: DictEntry }[];
}

export function lookup(token: string): LookupResult {
  return lookupIn(token, resolveToken(token, view), entries);
}

function lookupIn(token: string, res: Resolved | null, entries: EntriesMap): LookupResult {
  if (!res) return { token, res: null, lemma: token.toLowerCase().replace(/['’]s$/, '') };
  const entry = entries[res.lemma];
  const formEntry = res.key !== res.lemma && Object.prototype.hasOwnProperty.call(entries, res.key) ? entries[res.key] : undefined;
  const altKey = entry?.alt && Object.prototype.hasOwnProperty.call(entries, entry.alt) ? entry.alt : undefined;
  const parts = entry?.parts?.map((p) => ({ ...p, entry: Object.prototype.hasOwnProperty.call(entries, p.l) ? entries[p.l] : undefined }));
  return { token, res, lemma: res.lemma, entry, formEntry, altKey, altEntry: altKey ? entries[altKey] : undefined, parts };
}

export const getEntry = (k: string): DictEntry | undefined => entries[k] ?? (clEntries && Object.prototype.hasOwnProperty.call(clEntries, k) ? clEntries[k] : undefined);

// ---------- classics (名著赏析): a separate pool with its own supplementary dictionary ----------
let classicsIndexP: Promise<ClassicIndex> | null = null;
export const loadClassicsIndex = () => (classicsIndexP ??= getJson<ClassicIndex>('data/classics/index.json'));
const classicCache = new Map<string, Promise<Classic>>();
export const loadClassic = (id: string) => {
  if (!/^cl-\d{3}$/.test(id)) return Promise.reject(new Error('bad id'));
  if (!classicCache.has(id)) classicCache.set(id, getJson<Classic>(`data/classics/${id}.json`));
  return classicCache.get(id)!;
};
let archaisms: Archaisms = {};
let clEntries: EntriesMap | null = null;
let clView = view;
let classicsDictP: Promise<void> | null = null;
/** Main dictionary (all levels) + classics-only forms/entries + archaism notes. Articles never see the extra data. */
export function ensureClassicsDict(): Promise<void> {
  classicsDictP ??= Promise.all([
    ensureDict('C1'),
    getJson<ClassicsDict>('data/classics/dict.json'),
    getJson<Archaisms>('data/classics/archaisms.json'),
  ]).then(([, d, a]) => {
    archaisms = a;
    clEntries = d.entries;
    const mergedEntries = { ...entries, ...d.entries };
    clView = viewOf({ ...forms, ...d.forms }, mergedEntries);
    classicMerged = mergedEntries;
  });
  return classicsDictP;
}
let classicMerged: EntriesMap = {};

/** The note for a word in a classic: the excerpt's own glossary first, then the shared archaism list. */
export function glossFor(glossary: Map<string, GlossItem>, token: string): GlossItem | null {
  const k = glossKey(token);
  const k2 = k.replace(/'s$/, '');
  const g = glossary.get(k) ?? glossary.get(k2);
  if (g) return g;
  const a = archaisms[k] ?? archaisms[k2];
  return a ? { form: archaisms[k] ? k : k2, ...a } : null;
}

export interface ClassicLookup extends LookupResult {
  gloss: GlossItem | null;
}
export function lookupClassic(token: string, gloss: GlossItem | null): ClassicLookup {
  const res = resolveWithGloss(token, gloss, (w) => resolveToken(w, clView));
  return { ...lookupIn(token, res, classicMerged), gloss };
}
