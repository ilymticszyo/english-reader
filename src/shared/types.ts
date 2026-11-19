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

// ---------- classics (名著赏析) ----------
export interface ClassicSource {
  /** e.g. "Project Gutenberg #1342" */
  edition: string;
  /** https://www.gutenberg.org/ebooks/<n> */
  url: string;
  /** first publication year of the work */
  year: number;
  /** why the text is in the public domain */
  pdNote: string;
}

export interface ClassicMeta {
  id: string;
  work: string;
  author: string;
  authorId: string;
  chapter: string;
  scene: string;
  title: string;
  /** reference difficulty: an editorial judgement, never a coverage gate */
  refLevel: Level;
  /** words in the original excerpt only */
  wordCount: number;
  /** words in background + excerpt + appreciation (for the reading-time estimate) */
  totalWords: number;
  /** ceil(totalWords / 200) */
  minutes: number;
  spoiler: boolean;
  source: ClassicSource;
}

export interface ClassicIndex {
  schema: number;
  generatedAt: string;
  excerpts: ClassicMeta[];
}

export interface GlossItem {
  /** word form as written (lower case, straight apostrophe) */
  form: string;
  /** modern / base word the note explains (informational, e.g. thee -> you; may be several words) */
  lemma: string;
  /** dictionary headword to show under the note instead of the form's own lookup (dialect: warn't -> be) */
  dict?: string;
  /** English note (context sense) */
  note: string;
  zh: string;
}

export interface Classic extends ClassicMeta {
  version: number;
  intro: string[];
  paragraphs: string[];
  appreciation: string[];
  modelSentences: { text: string; note: string }[];
  /** notes for this excerpt only; merged with data/classics/archaisms.json at runtime */
  glossary: GlossItem[];
  /** global archaism forms that occur in this excerpt (for the "本篇注释" list) */
  archaismsUsed: string[];
  phrases: unknown[];
  meta: {
    stats: {
      avgSentenceLen: number;
      /** share of excerpt lemmas at or below refLevel (reference only, G9) */
      coverageAtLevel: number;
      offLevelWords: string[];
      /** share of excerpt lemmas at or below each level (reference only, G9) */
      distribution: Record<Level, number>;
      /** background + appreciation: share of lemmas at B2 or below (soft target 90%) */
      commentaryB2: number;
    };
  };
}

export type Archaisms = Record<string, { lemma: string; note: string; zh: string; dict?: string }>;

/** data/classics/dict.json: dictionary forms + entries used by classics that the main shards do not already have */
export interface ClassicsDict {
  forms: FormsMap;
  entries: EntriesMap;
}
