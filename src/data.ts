import type { Article, ArticleIndex, DictEntry, EntriesMap, FormsMap, Level } from './shared/types.ts';
import { LEVELS } from './shared/types.ts';
import { resolveToken, viewOf } from './shared/text.ts';
import type { Resolved } from './shared/text.ts';

const BASE = import.meta.env.BASE_URL; // './' by default => relative to the page, works on any sub-path

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`加载失败 ${path}（${res.status}）`);
  return res.json() as Promise<T>;
}

let indexP: Promise<ArticleIndex> | null = null;
export const loadIndex = () => (indexP ??= getJson<ArticleIndex>('data/index.json'));

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
  const res = resolveToken(token, view);
  if (!res) return { token, res: null, lemma: token.toLowerCase().replace(/['’]s$/, '') };
  const entry = entries[res.lemma];
  const formEntry = res.key !== res.lemma && Object.prototype.hasOwnProperty.call(entries, res.key) ? entries[res.key] : undefined;
  const altKey = entry?.alt && Object.prototype.hasOwnProperty.call(entries, entry.alt) ? entry.alt : undefined;
  const parts = entry?.parts?.map((p) => ({ ...p, entry: Object.prototype.hasOwnProperty.call(entries, p.l) ? entries[p.l] : undefined }));
  return { token, res, lemma: res.lemma, entry, formEntry, altKey, altEntry: altKey ? entries[altKey] : undefined, parts };
}

export const getEntry = (k: string): DictEntry | undefined => entries[k];
