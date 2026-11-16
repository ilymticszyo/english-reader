export type Level = 'B1' | 'B2' | 'C1';
export const LEVELS: Level[] = ['B1', 'B2', 'C1'];
export const LEVEL_RANK: Record<string, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

export interface ArticleMeta {
  id: string;
  level: Level;
  title: string;
  topics: string[];
  genre: string;
  wordCount: number;
  minutes: number;
  source: string;
}

export interface ArticleIndex {
  schema: number;
  generatedAt: string;
  articles: ArticleMeta[];
}

export interface Article extends ArticleMeta {
  version: number;
  paragraphs: string[];
  phrases: unknown[];
  meta: {
    source: string;
    promptVersion: string;
    createdAt: string;
    stats: { avgSentenceLen: number; coverageAtLevel: number; offLevelWords: string[] };
  };
}

export interface DictDef {
  pos: string;
  zh: string;
}

export interface DictEntry {
  /** phonetic (ECDICT) */
  p?: string;
  d: DictDef[];
  cefr?: string;
  tags?: string[];
  /** collins stars */
  col?: number;
  /** word forms of this lemma: p past, d past participle, i -ing, 3 third person, s plural, r comparative, t superlative */
  ex?: Record<string, string>;
  /** proper noun / whitelist entry */
  proper?: boolean;
  /** lexicalized -ing noun: key of the verb lemma entry folded below this card */
  alt?: string;
  /** hyphenated word that ECDICT lacks as a whole: its parts in order (w = surface part, l = lemma key of its entry); d is empty */
  parts?: { w: string; l: string }[];
}

/** form -> lemma */
export type FormsMap = Record<string, string | string[]>;
export type EntriesMap = Record<string, DictEntry>;
