// Build-time data pipeline:
//   content/articles/*.md  +  ECDICT (trimmed)  +  CEFR-J lists
//   -> public/data/{index.json, articles/*.json, dict/forms.json, dict/entries-{b1,b2,c1}.json}
// Usage: node scripts/build-data.ts [--strict]   (strict: calibration warnings become errors)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSourceArticles } from './lib/articles.ts';
import { ROOT, ensureEcdict, hasOwnMeaning, loadCefr, loadDb, makeEntry, resolveForBuild } from './lib/ecdict.ts';
import type { BuildRes } from './lib/ecdict.ts';
import type { Db } from './lib/ecdict.ts';
import { resolveToken, splitSentences, tokenize, viewOf } from '../src/shared/text.ts';
import { LEVELS, LEVEL_RANK } from '../src/shared/types.ts';
import type { Article, ArticleIndex, ArticleMeta, DictEntry, EntriesMap, FormsMap, Level } from '../src/shared/types.ts';

const strict = process.argv.includes('--strict');
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'build.config.json'), 'utf8'));
const proper: Record<string, string> = JSON.parse(readFileSync(resolve(ROOT, 'content/proper-nouns.json'), 'utf8'));
const overrides: Record<string, string> = JSON.parse(readFileSync(resolve(ROOT, 'content/lemma-overrides.json'), 'utf8'));
delete proper._comment;
delete overrides._comment;

const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => (strict ? errors : warnings).push(m);

const t0 = Date.now();
const db: Db = loadDb(await ensureEcdict());
const cefr = loadCefr();
console.log(`[data] ECDICT rows: ${db.rows.size}, CEFR words: ${Object.keys(cefr).length} (${Date.now() - t0}ms)`);

const resolveBuild = (token: string) => resolveForBuild(token, db, proper, overrides);

// ---------- articles ----------
const sources = loadSourceArticles();
const seenIds = new Set<string>();
const seenTitles = new Set<string>();
const articles: Article[] = [];
const keyLevel = new Map<string, Level>(); // dict key -> lowest level it appears in
const forms: Record<string, string> = {};
const keyToLemma = new Map<string, BuildRes>();
const usedKeys = new Set<string>(); // keys that must have an entry
const resolutionLog: string[] = [];
const noteLevel = (key: string, lv: Level) => {
  const cur = keyLevel.get(key);
  if (!cur || LEVEL_RANK[lv] < LEVEL_RANK[cur]) keyLevel.set(key, lv);
};

interface Tok {
  text: string;
  res: BuildRes | null;
}
const perArticleTokens = new Map<string, Tok[]>();

for (const s of sources) {
  const f = s.front;
  const id = String(f.id ?? '');
  const level = String(f.level ?? '') as Level;
  const title = String(f.title ?? '');
  const topics = (f.topics as string[]) ?? [];
  const at = `${s.file}`;
  if (!/^(b1|b2|c1)-\d{3}$/.test(id) || id !== s.file.replace(/\.md$/, '')) err(`${at}: bad id "${id}" (must match file name, e.g. b1-001)`);
  if (!LEVELS.includes(level) || id.slice(0, 2).toUpperCase() !== level) err(`${at}: bad level "${level}"`);
  if (seenIds.has(id)) err(`${at}: duplicate id`);
  seenIds.add(id);
  if (!title) err(`${at}: missing title`);
  if (seenTitles.has(title.toLowerCase())) err(`${at}: duplicate title`);
  seenTitles.add(title.toLowerCase());
  if (!topics.length || topics.some((t) => !cfg.topics.includes(t))) err(`${at}: topics must be from the 12-topic enum, got [${topics}]`);
  if (!f.source) err(`${at}: missing source`);
  if (/[#*`_]{2,}|^\s*[-*] /m.test(s.paragraphs.join('\n'))) err(`${at}: markdown residue in body`);

  const toks: Tok[] = [];
  let wordCount = 0;
  let sentences = 0;
  for (const para of s.paragraphs) {
    const ts = tokenize(para);
    wordCount += ts.length;
    sentences += splitSentences(para).length;
    for (const t of ts) toks.push({ text: t.text, res: resolveBuild(t.text) });
  }
  perArticleTokens.set(id, toks);
  for (const t of toks) {
    if (!t.res) {
      err(`${at}: word not found in dictionary: "${t.text}"`);
      continue;
    }
    const { key, lemma, kind } = t.res;
    noteLevel(lemma, level);
    usedKeys.add(lemma);
    if (kind === 'dict' && key !== lemma) {
      forms[key] = lemma;
      const row = db.rows.get(key);
      if (row && hasOwnMeaning(row)) {
        usedKeys.add(key);
        noteLevel(key, level);
      }
    }
    if (!keyToLemma.has(key)) keyToLemma.set(key, t.res);
  }

  const range = cfg.levels[level]?.words;
  if (range && (wordCount < range[0] || wordCount > range[1])) warn(`${at}: word count ${wordCount} outside ${level} range ${range.join('-')}`);
  const avgSentenceLen = Math.round((wordCount / Math.max(1, sentences)) * 10) / 10;
  const maxAvg = cfg.levels[level]?.avgSentence;
  if (maxAvg && avgSentenceLen > maxAvg) warn(`${at}: avg sentence length ${avgSentenceLen} > ${maxAvg}`);

  articles.push({
    id,
    level,
    title,
    topics,
    genre: String(f.genre ?? ''),
    source: String(f.source ?? ''),
    wordCount,
    minutes: Math.max(1, Math.ceil(wordCount / cfg.wordsPerMinute)),
    version: Number(f.version ?? 1),
    paragraphs: s.paragraphs,
    phrases: [],
    meta: {
      source: String(f.source ?? ''),
      promptVersion: String(f.promptVersion ?? ''),
      createdAt: String(f.createdAt ?? ''),
      stats: { avgSentenceLen, coverageAtLevel: 0, offLevelWords: [] },
    },
  });
}

// ---------- level counts ----------
for (const lv of LEVELS) {
  const n = articles.filter((a) => a.level === lv).length;
  if (n < cfg.expectedPerLevel) err(`level ${lv}: only ${n} articles, expected ${cfg.expectedPerLevel}`);
}

// ---------- entries ----------
const shards: Record<Level, EntriesMap> = { B1: {}, B2: {}, C1: {} };
for (const key of [...usedKeys].sort()) {
  const lv = keyLevel.get(key)!;
  let entry: DictEntry;
  if (Object.prototype.hasOwnProperty.call(proper, key)) {
    entry = { d: [{ pos: '', zh: proper[key] }], proper: true };
    const c = cefr[key.toLowerCase()];
    void c;
  } else {
    const row = db.rows.get(key);
    if (!row) {
      err(`entry missing for "${key}"`);
      continue;
    }
    entry = makeEntry(row, cefr, key);
    if (!entry.d.length) err(`entry "${key}" has no Chinese definition`);
  }
  shards[lv][key] = entry;
}

const allEntries: EntriesMap = Object.assign({}, shards.B1, shards.B2, shards.C1);
const formsOut: FormsMap = {};
for (const k of Object.keys(forms).sort()) formsOut[k] = forms[k];

// ---------- verify with the runtime resolver (same code as the browser) ----------
const view = viewOf(formsOut, allEntries);
const fallbackWords = new Set<string>();
for (const a of articles) {
  const toks = perArticleTokens.get(a.id)!;
  let covered = 0;
  let total = 0;
  const off = new Map<string, string>();
  for (const t of toks) {
    const r = resolveToken(t.text, view);
    if (!r) {
      err(`${a.id}: runtime resolver cannot find "${t.text}"`);
      continue;
    }
    if (r.via === 'fallback') fallbackWords.add(t.text);
    const exp = t.res!;
    if (r.lemma !== exp.lemma) err(`${a.id}: resolver mismatch for "${t.text}": build=${exp.lemma} runtime=${r.lemma}`);
    if (exp.kind === 'proper') continue;
    total++;
    const lv = cefr[r.lemma] ?? cefr[r.key] ?? cefr[t.text.toLowerCase()];
    if (lv && LEVEL_RANK[lv] <= LEVEL_RANK[a.level]) covered++;
    else off.set(r.lemma, lv ?? '?');
  }
  a.meta.stats.coverageAtLevel = Math.round((covered / Math.max(1, total)) * 1000) / 1000;
  a.meta.stats.offLevelWords = [...off.entries()].sort((x, y) => (LEVEL_RANK[y[1]] ?? 9) - (LEVEL_RANK[x[1]] ?? 9)).map(([w]) => w).slice(0, 20);
  const need = cfg.levels[a.level].coverage;
  if (a.meta.stats.coverageAtLevel < need) warn(`${a.id}: coverage ${a.meta.stats.coverageAtLevel} < ${need} (${a.level})`);
}
for (const w of fallbackWords) err(`word "${w}" is only resolvable via suffix fallback; add it to content/lemma-overrides.json`);

// ---------- write ----------
if (errors.length) {
  console.error('\n[data] BUILD FAILED:');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

const out = resolve(ROOT, 'public/data');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'articles'), { recursive: true });
mkdirSync(resolve(out, 'dict'), { recursive: true });
const sorted = [...articles].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.id.localeCompare(b.id));
const index: ArticleIndex = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  articles: sorted.map(({ id, level, title, topics, genre, wordCount, minutes, source }): ArticleMeta => ({ id, level, title, topics, genre, wordCount, minutes, source })),
};
const write = (p: string, data: unknown) => writeFileSync(resolve(out, p), JSON.stringify(data));
write('index.json', index);
for (const a of sorted) write(`articles/${a.id}.json`, a);
write('dict/forms.json', formsOut);
for (const lv of LEVELS) write(`dict/entries-${lv.toLowerCase()}.json`, shards[lv]);

// ---------- report ----------
mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
const report = {
  articles: sorted.map((a) => ({ id: a.id, level: a.level, words: a.wordCount, avgSentenceLen: a.meta.stats.avgSentenceLen, coverage: a.meta.stats.coverageAtLevel, offLevel: a.meta.stats.offLevelWords })),
  dict: { forms: Object.keys(formsOut).length, entries: Object.fromEntries(LEVELS.map((l) => [l, Object.keys(shards[l]).length])) },
  warnings,
};
writeFileSync(resolve(ROOT, 'reports/coverage.json'), JSON.stringify(report, null, 2));
const size = (p: string) => readFileSync(resolve(out, p)).length;
console.log(`[data] ${articles.length} articles; forms=${Object.keys(formsOut).length}; entries B1/B2/C1 = ${LEVELS.map((l) => Object.keys(shards[l]).length).join('/')}`);
console.log(`[data] shard bytes: forms=${size('dict/forms.json')} ${LEVELS.map((l) => `${l}=${size(`dict/entries-${l.toLowerCase()}.json`)}`).join(' ')}`);
for (const a of report.articles) console.log(`  ${a.id} words=${a.words} sentLen=${a.avgSentenceLen} coverage=${a.coverage} off=[${a.offLevel.slice(0, 6)}]`);
if (warnings.length) {
  console.log(`[data] ${warnings.length} calibration warning(s):`);
  for (const w of warnings) console.log('  ! ' + w);
}
void resolutionLog;
