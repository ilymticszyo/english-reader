// Shared by the browser runtime and the build script, so "build passes" == "lookup works online".

export const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;

export interface DictView {
  hasForm(key: string): boolean;
  getForm(key: string): string | string[] | undefined;
  hasEntry(key: string): boolean;
}

export interface Resolved {
  /** the key under which the clicked token was found (form or lemma) */
  key: string;
  /** primary lemma */
  lemma: string;
  /** how it was found */
  via: 'form' | 'entry' | 'fallback';
}

const CONTRACTION_SUFFIX = /(n['’]t|['’](?:s|re|ve|ll|d|m))$/i;

/** Ordered candidate keys for a clicked token (exact case first, then lower case, possessive/contraction/hyphen variants). */
export function candidateKeys(token: string): string[] {
  const t = token.replace(/’/g, "'");
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const variants = (w: string) => {
    push(w);
    push(w.toLowerCase());
  };
  variants(t);
  if (CONTRACTION_SUFFIX.test(t)) {
    const base = t.replace(CONTRACTION_SUFFIX, '');
    variants(base);
    // can't -> can, won't -> will (handled by ECDICT forms if present)
    if (/n't$/i.test(t) && /^ca$/i.test(base)) push('can');
    if (/n't$/i.test(t) && /^wo$/i.test(base)) push('will');
  }
  if (t.includes('-')) {
    for (const part of t.split('-')) variants(part);
  }
  return out;
}

/** Rule-based suffix stripping, used only when a word is neither a known form nor a known entry. */
export function suffixCandidates(w: string): string[] {
  const s = w.toLowerCase();
  const out: string[] = [];
  const add = (x: string) => {
    if (x.length > 1) out.push(x);
  };
  if (s.endsWith('ies')) add(s.slice(0, -3) + 'y');
  if (s.endsWith('ied')) add(s.slice(0, -3) + 'y');
  if (s.endsWith('ing')) {
    const b = s.slice(0, -3);
    add(b);
    add(b + 'e');
    if (/(.)\1$/.test(b)) add(b.slice(0, -1));
  }
  if (s.endsWith('ed')) {
    const b = s.slice(0, -2);
    add(b);
    add(b + 'e');
    if (/(.)\1$/.test(b)) add(b.slice(0, -1));
  }
  if (s.endsWith('es')) add(s.slice(0, -2));
  if (s.endsWith('s')) add(s.slice(0, -1));
  if (s.endsWith('er')) {
    add(s.slice(0, -2));
    add(s.slice(0, -1));
  }
  if (s.endsWith('est')) {
    add(s.slice(0, -3));
    add(s.slice(0, -2));
  }
  return out;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function viewOf(forms: Record<string, unknown>, entries: Record<string, unknown>): DictView {
  return {
    hasForm: (k) => own(forms, k),
    getForm: (k) => (own(forms, k) ? (forms[k] as string | string[]) : undefined),
    hasEntry: (k) => own(entries, k),
  };
}

export function primaryLemma(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

export function resolveToken(token: string, dict: DictView): Resolved | null {
  const cands = candidateKeys(token);
  for (const c of cands) {
    if (dict.hasForm(c)) {
      const lemma = primaryLemma(dict.getForm(c)!);
      if (dict.hasEntry(lemma)) return { key: c, lemma, via: 'form' };
    }
    if (dict.hasEntry(c)) return { key: c, lemma: c, via: 'entry' };
  }
  for (const c of cands) {
    for (const s of suffixCandidates(c)) {
      if (dict.hasEntry(s)) return { key: c, lemma: s, via: 'fallback' };
    }
  }
  return null;
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

/** Decade forms (1870s, 1990s, '90s, 80s): one non-word token, so the trailing "s" is never a word. */
const DECADE_SRC = String.raw`(?<![A-Za-z0-9])['’]?\d{2,4}s\b`;
/** Leading-elision archaic forms ('tis, 'twas, 'twere, 'twill, 'twould, 'em): one token including the apostrophe.
 *  Mid-word elisions (o'er, ne'er, e'en) are already single tokens via WORD_RE. */
export const ELISION_SRC = String.raw`(?<![A-Za-z])['’](?:[Tt]is|[Tt]was|[Tt]were|[Tt]will|[Tt]would|em)(?![A-Za-z'’])`;
const TOKEN_RE = new RegExp(`${DECADE_SRC}|${ELISION_SRC}|${WORD_RE.source}`, 'g');
const STARTS_WITH_DECADE = /^['’]?\d/;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (STARTS_WITH_DECADE.test(m[0])) continue; // decade: neither counted nor clickable
    out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (Seg) {
    const seg = new Seg('en', { granularity: 'sentence' });
    for (const s of seg.segment(text)) {
      const raw = s.segment;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: trimmed, start: s.index + lead, end: s.index + lead + trimmed.length });
    }
    return out;
  }
  const re = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;
  for (const m of text.matchAll(re)) {
    const trimmed = m[0].trim();
    if (trimmed) {
      const lead = m[0].length - m[0].trimStart().length;
      out.push({ text: trimmed, start: m.index! + lead, end: m.index! + lead + trimmed.length });
    }
  }
  return out;
}

/** Normalised key for glossary / archaism lookups: curly apostrophe -> straight, lower case. */
export const glossKey = (token: string) => token.replace(/[’‘]/g, "'").toLowerCase();

/**
 * Dictionary lookup for a word that may carry a classics note (shared by build and browser):
 *  1. the note names a dictionary word ("dict") -> look that up (dialect / misleading forms: warn't -> be);
 *  2. otherwise the form itself;
 *  3. otherwise the note's single-word modern equivalent (thou -> you), if any.
 */
export function resolveWithGloss<R>(token: string, gloss: { lemma?: string; dict?: string } | null | undefined, resolve: (w: string) => R | null): R | null {
  if (gloss?.dict) return resolve(gloss.dict);
  const r = resolve(token);
  if (r) return r;
  if (gloss?.lemma && /^[a-z][a-z'-]*$/.test(gloss.lemma)) return resolve(gloss.lemma);
  return null;
}

export const FORM_LABELS: Record<string, string> = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  '3': '第三人称单数',
  s: '复数',
  r: '比较级',
  t: '最高级',
};
