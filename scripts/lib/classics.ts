// 名著赏析 (classics) build step, called from build-data.ts after the graded articles are done.
//   content/classics/cl-NNN.md  +  content/classics/archaisms.json  +  content/classics/terms.json
//   -> public/data/classics/{index.json, cl-NNN.json, archaisms.json, dict.json}
// Classics never enter the B1/B2/C1 pools and are never gated by coverage: coverage is computed for reference only.
// Hard failures (PRD 15 / G5): missing or non-Gutenberg source, bad metadata, excerpt outside 300-800 words,
//   fewer than 3 or more than 5 model sentences, a model sentence that is not verbatim from the excerpt,
//   a glossary note for a word that is not in the excerpt, or any word with neither a dictionary entry nor a note.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, hasOwnMeaning, lexAlt, makeEntry, resolveForBuild } from './ecdict.ts';
import type { BuildRes, Db, Overrides } from './ecdict.ts';
import { glossKey, resolveToken, resolveWithGloss, splitSentences, tokenize, viewOf } from '../../src/shared/text.ts';
import { LEVELS, LEVEL_RANK } from '../../src/shared/types.ts';
import type { Archaisms, Classic, ClassicIndex, ClassicMeta, ClassicsDict, DictEntry, EntriesMap, FormsMap, GlossItem, Level } from '../../src/shared/types.ts';

export const CLASSIC_WORDS: [number, number] = [300, 800];
const INTRO_WORDS: [number, number] = [120, 180];
const APPR_WORDS: [number, number] = [200, 350];
const COMMENTARY_B2_TARGET = 0.9;
const WPM = 200;

export interface SourceClassic {
  file: string;
  front: Record<string, string>;
  sections: Record<string, string[]>;
}

/** content/classics/cl-001.md: frontmatter + "## Background / ## Excerpt / ## Appreciation / ## Sentences to imitate / ## Notes" */
export function loadSourceClassics(dir = resolve(ROOT, 'content/classics')): SourceClassic[] {
  if (!existsSync(dir)) return [];
  const out: SourceClassic[] = [];
  for (const f of readdirSync(dir).filter((x) => /^cl-\d{3}\.md$/.test(x)).sort()) {
    const raw = readFileSync(resolve(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`${f}: missing frontmatter`);
    const front: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const sections: Record<string, string[]> = {};
    let cur = '';
    const buf: Record<string, string> = {};
    for (const line of m[2].split('\n')) {
      const hm = line.match(/^##\s+(.+?)\s*$/);
      if (hm) {
        cur = hm[1].toLowerCase();
        buf[cur] = '';
        continue;
      }
      if (cur) buf[cur] += line + '\n';
    }
    for (const [k, v] of Object.entries(buf)) {
      sections[k] = v.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    }
    out.push({ file: f, front, sections });
  }
  return out;
}

const para = (p: string) => p.replace(/\s*\n\s*/g, ' ').trim();
const words = (ps: string[]) => ps.reduce((n, p) => n + tokenize(p).length, 0);
/** for the "verbatim" check: quote marks around a quoted sentence may be left out */
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();

export interface ClassicsBuildCtx {
  db: Db;
  ov: Overrides;
  cefr: Record<string, string>;
  /** the main dictionary as shipped for the graded articles */
  mainForms: FormsMap;
  mainEntries: EntriesMap;
  /** compounds map from the main build is not needed: hyphen parts are resolved here */
  err: (m: string) => void;
  flag: (m: string) => void;
  /** ids used by graded articles (so classics ids can never collide) */
  articleIds: Set<string>;
}

export interface ClassicsBuildOut {
  index: ClassicIndex;
  classics: Classic[];
  archaisms: Archaisms;
  dict: ClassicsDict;
  report: string;
}

export function buildClassics(ctx: ClassicsBuildCtx): ClassicsBuildOut {
  const { db, cefr, mainForms, mainEntries, err, flag } = ctx;
  const dir = resolve(ROOT, 'content/classics');
  const sources = loadSourceClassics(dir);
  const archaismsPath = resolve(dir, 'archaisms.json');
  const archaisms: Archaisms = existsSync(archaismsPath) ? JSON.parse(readFileSync(archaismsPath, 'utf8')) : {};
  const termsPath = resolve(dir, 'terms.json');
  const classicTerms: Record<string, string> = existsSync(termsPath) ? JSON.parse(readFileSync(termsPath, 'utf8')) : {};
  for (const k of Object.keys(archaisms)) if (k !== glossKey(k)) err(`classics/archaisms.json: key "${k}" must be lower case with a straight apostrophe`);
  // names / dialect spellings that only the classics need: never leak into the graded-article dictionary
  const ov: Overrides = { ...ctx.ov, terms: { ...ctx.ov.terms, ...classicTerms } };

  const forms: FormsMap = {};
  const entries: EntriesMap = {};
  const need = new Set<string>();
  const compounds = new Map<string, { w: string; l: string }[]>();
  const altOf = new Map<string, string>();
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const addForm = (k: string, l: string) => {
    if (!has(mainForms, k)) forms[k] = l;
  };
  const noteKey = (k: string) => {
    if (!has(mainEntries, k)) need.add(k);
  };
  const noteRes = (r: BuildRes) => {
    noteKey(r.lemma);
    if (r.parts) {
      compounds.set(r.key, r.parts);
      for (const p of r.parts) {
        noteKey(p.l);
        if (p.w !== p.l) {
          addForm(p.w, p.l);
          const prow = db.rows.get(p.w);
          if (prow && hasOwnMeaning(prow)) noteKey(p.w);
        }
      }
    }
    if (r.kind === 'dict' && r.key !== r.lemma) {
      addForm(r.key, r.lemma);
      const row = db.rows.get(r.key);
      if (row && hasOwnMeaning(row)) noteKey(r.key);
    }
  };

  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const out: Classic[] = [];
  const perTokens = new Map<string, { text: string; block: 'excerpt' | 'commentary' | 'quote' | 'other'; res: BuildRes | null; gloss?: GlossItem | null }[]>();
  const glossOf = (local: Map<string, GlossItem>, token: string): GlossItem | null => {
    const k = glossKey(token);
    const k2 = k.replace(/'s$/, '');
    const g = local.get(k) ?? local.get(k2);
    if (g) return g;
    const a = archaisms[k] ?? archaisms[k2];
    return a ? { form: archaisms[k] ? k : k2, ...a } : null;
  };

  for (const s of sources) {
    const f = s.front;
    const at = `classics/${s.file}`;
    const id = f.id ?? '';
    if (!/^cl-\d{3}$/.test(id) || `${id}.md` !== s.file) err(`${at}: bad id "${id}" (must match file name, e.g. cl-001)`);
    if (seenIds.has(id) || ctx.articleIds.has(id)) err(`${at}: duplicate id`);
    seenIds.add(id);
    for (const k of ['work', 'author', 'authorId', 'chapter', 'scene', 'title', 'refLevel', 'spoiler', 'edition', 'url', 'year', 'pdNote']) {
      if (!f[k]) err(`${at}: missing frontmatter field "${k}"`);
    }
    const refLevel = f.refLevel as Level;
    if (!LEVELS.includes(refLevel)) err(`${at}: refLevel must be B1/B2/C1, got "${f.refLevel}"`);
    if (f.spoiler !== 'true' && f.spoiler !== 'false') err(`${at}: spoiler must be true or false`);
    if (!/^[a-z][a-z0-9-]*$/.test(f.authorId ?? '')) err(`${at}: authorId must be a lower-case slug`);
    if (seenTitles.has((f.title ?? '').toLowerCase())) err(`${at}: duplicate title`);
    seenTitles.add((f.title ?? '').toLowerCase());
    // G5: every excerpt must point at a verified public-domain Project Gutenberg edition
    const pg = (f.edition ?? '').match(/^Project Gutenberg #(\d+)\b/);
    if (!pg) err(`${at}: edition must be "Project Gutenberg #<number>" (source is required; G5)`);
    else if (f.url !== `https://www.gutenberg.org/ebooks/${pg[1]}`) err(`${at}: url must be https://www.gutenberg.org/ebooks/${pg[1]}`);
    const year = Number(f.year);
    if (!(year >= 1700 && year <= 1930)) err(`${at}: year ${f.year} is not a verified public-domain publication year (US cut-off: 1930)`);
    if (f.pdVerified !== 'true') err(`${at}: pdVerified must be true (public-domain check done)`);

    const sec = s.sections;
    const intro = (sec['background'] ?? []).map(para);
    const paragraphs = (sec['excerpt'] ?? []).map(para);
    const appreciation = (sec['appreciation'] ?? []).map(para);
    if (!intro.length) err(`${at}: missing "## Background"`);
    if (!paragraphs.length) err(`${at}: missing "## Excerpt"`);
    if (!appreciation.length) err(`${at}: missing "## Appreciation"`);
    // Sentences to imitate: "> quoted sentence" followed by its note
    const modelSentences: { text: string; note: string }[] = [];
    for (const block of sec['sentences to imitate'] ?? []) {
      const lines = block.split('\n');
      const q = lines.filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '')).join(' ').trim();
      const note = lines.filter((l) => !l.startsWith('>')).join(' ').trim();
      if (!q || !note) err(`${at}: each sentence to imitate needs "> sentence" and a note`);
      modelSentences.push({ text: q, note });
    }
    if (modelSentences.length < 3 || modelSentences.length > 5) err(`${at}: needs 3 to 5 sentences to imitate, got ${modelSentences.length}`);
    const excerptNorm = norm(paragraphs.join(' '));
    for (const m of modelSentences) if (!excerptNorm.includes(norm(m.text))) err(`${at}: sentence to imitate is not verbatim from the excerpt: "${m.text.slice(0, 60)}…"`);
    // Notes: "- form | English note | 中文" or "- form => lemma | note | 中文"
    const glossary: GlossItem[] = [];
    const local = new Map<string, GlossItem>();
    for (const block of sec['notes'] ?? []) {
      for (const line of block.split('\n').filter((l) => l.trim())) {
        const m = line.match(/^-\s*(.+?)\s*(?:=>\s*(.+?)\s*)?\|\s*(.+?)\s*\|\s*(.+?)\s*$/);
        if (!m) {
          err(`${at}: bad note line "${line}" (expected "- form | note | 中文" or "- form => lemma | note | 中文")`);
          continue;
        }
        const g: GlossItem = { form: glossKey(m[1]), lemma: (m[2] ?? '').toLowerCase(), note: m[3], zh: m[4] };
        if (m[2]) g.dict = m[2].toLowerCase();
        if (local.has(g.form)) err(`${at}: duplicate note for "${g.form}"`);
        glossary.push(g);
        local.set(g.form, g);
      }
    }
    const all = [...intro, ...paragraphs, ...appreciation, ...modelSentences.flatMap((m) => [m.text, m.note])];
    if (/[#*`_]{2,}|^\s*[-*] /m.test(all.join('\n'))) err(`${at}: markdown residue in body`);
    if (/Project Gutenberg|gutenberg\.org|\*\*\* ?(START|END) OF/i.test(paragraphs.join('\n'))) err(`${at}: Gutenberg header/footer text left in the excerpt`);
    if (/\[Illustration/i.test(paragraphs.join('\n'))) err(`${at}: illustration caption left in the excerpt (not the author's text)`);

    const wordCount = words(paragraphs);
    if (wordCount < CLASSIC_WORDS[0] || wordCount > CLASSIC_WORDS[1]) err(`${at}: excerpt has ${wordCount} words, must be ${CLASSIC_WORDS.join('-')}`);
    const iw = words(intro);
    const aw = words(appreciation);
    if (iw < INTRO_WORDS[0] || iw > INTRO_WORDS[1]) flag(`${id}: background has ${iw} words (guide ${INTRO_WORDS.join('-')})`);
    if (aw < APPR_WORDS[0] || aw > APPR_WORDS[1]) flag(`${id}: appreciation has ${aw} words (guide ${APPR_WORDS.join('-')})`);
    const totalWords = iw + wordCount + aw;
    const excerptKeys = new Set(paragraphs.flatMap((p) => tokenize(p).map((t) => glossKey(t.text))));
    for (const g of glossary) {
      if (!excerptKeys.has(g.form) && !excerptKeys.has(g.form + "'s")) err(`${at}: note for "${g.form}" but the word is not in the excerpt`);
    }
    const archaismsUsed = Object.keys(archaisms).filter((k) => excerptKeys.has(k) && !local.has(k)).sort();

    // ---- dictionary resolution for every clickable word (all three blocks + model sentences)
    const toks: { text: string; block: 'excerpt' | 'commentary' | 'quote' | 'other'; res: BuildRes | null; gloss?: GlossItem | null }[] = [];
    // notes apply to the author's words only (excerpt + quoted model sentences); our own commentary uses the plain dictionary
    const blocks: [string[], 'excerpt' | 'commentary' | 'quote' | 'other'][] = [[intro, 'commentary'], [paragraphs, 'excerpt'], [appreciation, 'commentary'], [modelSentences.map((m) => m.text), 'quote'], [modelSentences.map((m) => m.note), 'other']];
    for (const [ps, block] of blocks) {
      for (const p of ps) {
        for (const t of tokenize(p)) {
          const gloss = block === 'excerpt' || block === 'quote' ? glossOf(local, t.text) : null;
          const res = resolveWithGloss(t.text, gloss, (w) => resolveForBuild(w, db, ov));
          if (gloss?.dict && !res) err(`${at}: note for "${gloss.form}" points at "${gloss.dict}", which has no dictionary entry`);
          if (!res && !gloss) err(`${at}: NO DEFINITION for "${t.text}" (not in ECDICT; add a note in "## Notes", content/classics/archaisms.json, or content/classics/terms.json)`);
          if (res) noteRes(res);
          toks.push({ text: t.text, block, res, gloss });
        }
      }
    }
    perTokens.set(id, toks);

    let sentences = 0;
    for (const p of paragraphs) sentences += splitSentences(p).length;
    const pdNote = f.pdNote ?? '';
    out.push({
      id, work: f.work, author: f.author, authorId: f.authorId, chapter: f.chapter, scene: f.scene, title: f.title,
      refLevel, wordCount, totalWords, minutes: Math.max(1, Math.ceil(totalWords / WPM)), spoiler: f.spoiler === 'true',
      source: { edition: f.edition, url: f.url, year, pdNote },
      version: Number(f.version ?? 1),
      intro, paragraphs, appreciation, modelSentences, glossary, archaismsUsed, phrases: [],
      meta: { stats: { avgSentenceLen: Math.round((wordCount / Math.max(1, sentences)) * 10) / 10, coverageAtLevel: 0, offLevelWords: [], distribution: { B1: 0, B2: 0, C1: 0 }, commentaryB2: 0 } },
    });
  }

  // lexicalized words fold their lemma's entry below the card: ship it too
  for (const key of [...need]) {
    if (ctx.ov.lexicalized.has(key)) {
      const alt = lexAlt(db, key);
      if (alt && alt !== key) {
        altOf.set(key, alt);
        noteKey(alt);
      }
    }
  }
  for (const key of [...need].sort()) {
    let entry: DictEntry;
    if (has(ov.terms, key)) entry = { d: [{ pos: '', zh: ov.terms[key] }], proper: true };
    else if (compounds.has(key)) entry = { d: [], parts: compounds.get(key)! };
    else {
      const row = db.rows.get(key);
      if (!row) {
        err(`classics: NO DEFINITION: entry missing for "${key}"`);
        continue;
      }
      entry = makeEntry(row, cefr, key, ctx.ov);
      if (!entry.d.length) err(`classics: NO DEFINITION: entry "${key}" has no Chinese definition`);
      if (altOf.has(key)) entry.alt = altOf.get(key);
    }
    entries[key] = entry;
  }
  const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const dict: ClassicsDict = { forms: sortObj(forms), entries: sortObj(entries) };

  // ---- verify with the runtime resolver over the merged dictionary (what the classics reader loads) + reference stats
  const view = viewOf({ ...mainForms, ...dict.forms }, { ...mainEntries, ...dict.entries });
  const lvOf = (lemma: string, ...ws: string[]) => cefr[lemma] ?? ws.map((w) => cefr[w]).find(Boolean);
  let report = `\n## Classics (名著赏析)\n\nClassics are not part of the B1/B2/C1 pools and are never gated by coverage. Numbers below are for reference only (G1, G9).\n\n`;
  report += `| id | work | ref | excerpt words | ≤B1 | ≤B2 | ≤C1 | at ref level | commentary ≤B2 | notes |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const c of out) {
    const toks = perTokens.get(c.id)!;
    const cnt = { B1: 0, B2: 0, C1: 0 } as Record<Level, number>;
    let total = 0;
    const off = new Map<string, string>();
    let cTotal = 0;
    let cB2 = 0;
    for (const t of toks) {
      const r = resolveWithGloss(t.text, t.gloss, (w) => resolveToken(w, view));
      if (t.res && !r) err(`${c.id}: runtime resolver cannot find "${t.text}"`);
      if (t.res && r && r.lemma !== t.res.lemma) err(`${c.id}: resolver mismatch for "${t.text}": build=${t.res.lemma} runtime=${r.lemma}`);
      if (!t.res || t.res.kind === 'proper') continue;
      const lv = t.res.parts ? t.res.parts.map((p) => lvOf(p.l, p.w)).reduce<string | undefined>((a, b) => (!a || !b ? undefined : LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b), 'A1') : lvOf(t.res.lemma, t.res.key, t.text.toLowerCase());
      if (t.block === 'excerpt') {
        total++;
        for (const L of LEVELS) if (lv && LEVEL_RANK[lv] <= LEVEL_RANK[L]) cnt[L]++;
        if (!lv || LEVEL_RANK[lv] > LEVEL_RANK[c.refLevel]) off.set(t.res.lemma, lv ?? '?');
      } else if (t.block === 'commentary') {
        cTotal++;
        if (lv && LEVEL_RANK[lv] <= LEVEL_RANK.B2) cB2++;
      }
    }
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    for (const L of LEVELS) c.meta.stats.distribution[L] = r3(cnt[L] / Math.max(1, total));
    c.meta.stats.coverageAtLevel = c.meta.stats.distribution[c.refLevel];
    c.meta.stats.offLevelWords = [...off.entries()].sort((x, y) => (LEVEL_RANK[y[1]] ?? 9) - (LEVEL_RANK[x[1]] ?? 9)).map(([w]) => w).slice(0, 20);
    c.meta.stats.commentaryB2 = r3(cB2 / Math.max(1, cTotal));
    if (c.meta.stats.commentaryB2 < COMMENTARY_B2_TARGET) flag(`${c.id}: background + appreciation only ${(c.meta.stats.commentaryB2 * 100).toFixed(1)}% at B2 or below (soft target ${COMMENTARY_B2_TARGET * 100}%; glossed terms may pass)`);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    report += `| ${c.id} | ${c.work} | ${c.refLevel} | ${c.wordCount} | ${pct(c.meta.stats.distribution.B1)} | ${pct(c.meta.stats.distribution.B2)} | ${pct(c.meta.stats.distribution.C1)} | ${pct(c.meta.stats.coverageAtLevel)} | ${pct(c.meta.stats.commentaryB2)} | ${c.glossary.length} + ${c.archaismsUsed.length} archaisms |\n`;
  }

  const index: ClassicIndex = {
    schema: 1,
    generatedAt: '2026-11-19T00:00:00Z',
    excerpts: out.map(({ id, work, author, authorId, chapter, scene, title, refLevel, wordCount, totalWords, minutes, spoiler, source }): ClassicMeta => ({ id, work, author, authorId, chapter, scene, title, refLevel, wordCount, totalWords, minutes, spoiler, source })),
  };
  return { index, classics: out, archaisms, dict, report };
}
