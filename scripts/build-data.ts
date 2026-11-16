// Build-time data pipeline:
//   content/articles/*.md  +  ECDICT (trimmed)  +  CEFR-J lists  +  content/lemma-overrides.json
//   -> public/data/{index.json, articles/*.json, dict/forms.json, dict/entries-{b1,b2,c1}.json}
//   -> reports/build-report.md (+ .json): suspicious lemmas, calibration flags. Reports never fail the build.
// Hard failures: bad article metadata, duplicate ids/titles, too few articles per level,
//   a word with no definition at all, or build/runtime resolver disagreement.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSourceArticles } from './lib/articles.ts';
import { ROOT, ensureEcdict, hasOwnMeaning, lexAlt, loadCefr, loadDb, loadOverrides, makeEntry, parseExchange, rawLemmas, resolveForBuild } from './lib/ecdict.ts';
import type { BuildRes } from './lib/ecdict.ts';
import { resolveToken, splitSentences, tokenize, viewOf } from '../src/shared/text.ts';
import { LEVELS, LEVEL_RANK } from '../src/shared/types.ts';
import type { Article, ArticleIndex, ArticleMeta, DictEntry, EntriesMap, FormsMap, Level } from '../src/shared/types.ts';

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'build.config.json'), 'utf8'));
const ov = loadOverrides();

const errors: string[] = [];
const err = (m: string) => errors.push(m);
/** calibration flags: reported for manual review, never reject */
const flags: string[] = [];

const t0 = Date.now();
const db = loadDb(await ensureEcdict());
const cefr = loadCefr();
console.log(`[data] ECDICT rows: ${db.rows.size}, CEFR words: ${Object.keys(cefr).length} (${Date.now() - t0}ms)`);
const rank = (k: string) => {
  const r = db.rows.get(k);
  return r ? (r.frq > 0 ? r.frq : r.bnc > 0 ? r.bnc : 1e9) : 1e9;
};

// ---------- articles ----------
const sources = loadSourceArticles();
const seenIds = new Set<string>();
const seenTitles = new Set<string>();
const articles: Article[] = [];
const keyLevel = new Map<string, Level>(); // dict key -> lowest level it appears in
const forms: Record<string, string> = {};
const usedKeys = new Set<string>(); // keys that must have an entry
const noteLevel = (key: string, lv: Level) => {
  const cur = keyLevel.get(key);
  if (!cur || LEVEL_RANK[lv] < LEVEL_RANK[cur]) keyLevel.set(key, lv);
};
interface Tok {
  text: string;
  res: BuildRes | null;
}
/** hyphenated words missing from ECDICT -> their parts */
const compounds = new Map<string, { w: string; l: string }[]>();
const perArticleTokens = new Map<string, Tok[]>();
/** token (lowercase key) -> where it occurs + how it was resolved */
const seen = new Map<string, { res: BuildRes; articles: Set<string>; samples: Set<string> }>();

for (const s of sources) {
  const f = s.front;
  const id = String(f.id ?? '');
  const level = String(f.level ?? '') as Level;
  const title = String(f.title ?? '');
  const topics = (f.topics as string[]) ?? [];
  const at = s.file;
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
    for (const t of ts) toks.push({ text: t.text, res: resolveForBuild(t.text, db, ov) });
  }
  perArticleTokens.set(id, toks);
  for (const t of toks) {
    if (!t.res) {
      err(`${at}: NO DEFINITION for "${t.text}" (not in ECDICT, not in 'terms'). Add it to content/lemma-overrides.json → terms.`);
      continue;
    }
    const { key, lemma, kind } = t.res;
    noteLevel(lemma, level);
    usedKeys.add(lemma);
    for (const p of t.res.parts ?? []) {
      compounds.set(key, t.res.parts!);
      noteLevel(p.l, level);
      usedKeys.add(p.l);
      if (p.w !== p.l) {
        forms[p.w] = p.l;
        const prow = db.rows.get(p.w);
        if (prow && hasOwnMeaning(prow)) {
          usedKeys.add(p.w);
          noteLevel(p.w, level);
        }
      }
    }
    if (kind === 'dict' && key !== lemma) {
      forms[key] = lemma;
      const row = db.rows.get(key);
      if (row && hasOwnMeaning(row)) {
        usedKeys.add(key);
        noteLevel(key, level);
      }
    }
    const k = `${t.res.kind === 'proper' ? t.res.key : key}`;
    if (!seen.has(k)) seen.set(k, { res: t.res, articles: new Set(), samples: new Set() });
    const rec = seen.get(k)!;
    rec.articles.add(id);
    if (rec.samples.size < 3) rec.samples.add(t.text);
  }

  const range = cfg.levels[level]?.words;
  if (range && (wordCount < range[0] || wordCount > range[1])) flags.push(`${id}: word count ${wordCount} outside ${level} range ${range.join('-')}`);
  const avgSentenceLen = Math.round((wordCount / Math.max(1, sentences)) * 10) / 10;
  const maxAvg = cfg.levels[level]?.avgSentence;
  if (maxAvg && avgSentenceLen > maxAvg) flags.push(`${id}: average sentence length ${avgSentenceLen} > ${maxAvg} (${level})`);

  articles.push({
    id, level, title, topics,
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

for (const lv of LEVELS) {
  const n = articles.filter((a) => a.level === lv).length;
  if (n < cfg.expectedPerLevel) err(`level ${lv}: only ${n} articles, expected ${cfg.expectedPerLevel}`);
}

// lexicalized -ing nouns: the verb lemma entry is folded under the noun card, so it must ship too
const altOf = new Map<string, string>();
for (const key of [...usedKeys]) {
  if (ov.lexicalizedIng.has(key)) {
    const alt = lexAlt(db, key);
    if (alt && alt !== key) {
      altOf.set(key, alt);
      usedKeys.add(alt);
      noteLevel(alt, keyLevel.get(key)!);
    }
  }
}

// ---------- entries ----------
const shards: Record<Level, EntriesMap> = { B1: {}, B2: {}, C1: {} };
for (const key of [...usedKeys].sort()) {
  const lv = keyLevel.get(key)!;
  let entry: DictEntry;
  if (Object.prototype.hasOwnProperty.call(ov.terms, key)) {
    entry = { d: [{ pos: '', zh: ov.terms[key] }], proper: true };
  } else if (compounds.has(key)) {
    entry = { d: [], parts: compounds.get(key)! };
  } else {
    const row = db.rows.get(key);
    if (!row) {
      err(`NO DEFINITION: entry missing for "${key}"`);
      continue;
    }
    entry = makeEntry(row, cefr, key);
    if (!entry.d.length) err(`NO DEFINITION: entry "${key}" has no Chinese definition`);
    if (altOf.has(key)) entry.alt = altOf.get(key);
  }
  shards[lv][key] = entry;
}
const allEntries: EntriesMap = Object.assign({}, shards.B1, shards.B2, shards.C1);
const formsOut: FormsMap = {};
for (const k of Object.keys(forms).sort()) formsOut[k] = forms[k];

// ---------- verify with the runtime resolver (same code as the browser) + coverage ----------
const view = viewOf(formsOut, allEntries);
const offAll = new Map<string, string[]>();
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
    if (r.lemma !== t.res!.lemma) err(`${a.id}: resolver mismatch for "${t.text}": build=${t.res!.lemma} runtime=${r.lemma}`);
    if (t.res!.kind === 'proper') continue;
    total++;
    const ok = (lemma: string, ...words: string[]) => {
      const lv = cefr[lemma] ?? words.map((w) => cefr[w]).find(Boolean);
      if (lv && LEVEL_RANK[lv] <= LEVEL_RANK[a.level]) return true;
      off.set(lemma, lv ?? '?');
      return false;
    };
    // a hyphenated word that ECDICT lacks counts as covered only if every part is
    if (t.res!.parts) {
      if (t.res!.parts.map((p) => ok(p.l, p.w)).every(Boolean)) covered++;
    } else if (t.text.includes('-')) {
      // hyphenated word that ECDICT has as a whole but CEFR lists do not: covered if the whole or every part is
      const wholeLv = cefr[r.lemma] ?? cefr[r.key];
      const partRes = t.text.toLowerCase().split('-').filter(Boolean).map((w) => resolveForBuild(w, db, ov));
      if (wholeLv && LEVEL_RANK[wholeLv] <= LEVEL_RANK[a.level]) covered++;
      else if (partRes.every((x) => x && (cefr[x.lemma] ?? cefr[x.key]) && LEVEL_RANK[(cefr[x.lemma] ?? cefr[x.key])!] <= LEVEL_RANK[a.level])) covered++;
      else partRes.forEach((x) => x && ok(x.lemma, x.key));
    } else if (ok(r.lemma, r.key, t.text.toLowerCase())) covered++;
  }
  offAll.set(a.id, [...off.entries()].map(([w, l]) => `${w}:${l}`));
  a.meta.stats.coverageAtLevel = Math.round((covered / Math.max(1, total)) * 1000) / 1000;
  a.meta.stats.offLevelWords = [...off.entries()].sort((x, y) => (LEVEL_RANK[y[1]] ?? 9) - (LEVEL_RANK[x[1]] ?? 9)).map(([w]) => w).slice(0, 20);
  const need = cfg.levels[a.level].coverage;
  if (a.meta.stats.coverageAtLevel < need) flags.push(`${a.id}: vocabulary coverage ${(a.meta.stats.coverageAtLevel * 100).toFixed(1)}% < ${(need * 100).toFixed(0)}% (${a.level}); off-level: ${[...off.keys()].slice(0, 10).join(', ')}`);
}

if (errors.length) {
  console.error('\n[data] BUILD FAILED:');
  for (const e of [...new Set(errors)]) console.error('  ✗ ' + e);
  process.exit(1);
}

// ---------- missed / suspicious lemma report ----------
const hasNounSense = (tr: string) => tr.split(/\\n|\n/).some((l) => /^\s*n\./.test(l) && !/的(现在分词|ing形式)/.test(l));
interface Finding {
  kind: string;
  word: string;
  detail: string;
  articles: string[];
  fix?: string;
}
const findings: Finding[] = [];
const fixLemma = (w: string, l: string) => `"lemma": { "${w}": "${l}" }`;
for (const [key, rec] of seen) {
  const { res } = rec;
  const arts = [...rec.articles].sort();
  const push = (kind: string, detail: string, fix?: string) => findings.push({ kind, word: key, detail, articles: arts, fix });
  if (res.kind === 'proper') continue;
  const row = db.rows.get(key);
  if (res.via === 'fallback') push('fallback', `not in ECDICT as a form; guessed lemma "${res.lemma}" by suffix rules`, fixLemma(key, res.lemma) + `   (or add to "terms" if it is a name)`);
  if (res.via === 'hyphen-compound') push('hyphen', `hyphenated word not in ECDICT as a whole; the card lists each part in order: ${res.parts!.map((p) => (p.w === p.l ? p.w : `${p.w}→${p.l}`)).join(' + ')}`, `"terms": { "${key}": "…" }  (only if a single combined gloss reads better)`);
  if (res.via === 'normal' && key !== res.lemma) {
    const cands = rawLemmas(db, key);
    if (cands.length > 1) push('ambiguous', `candidates: ${cands.join(' / ')}; using "${cands[0]}"`, fixLemma(key, cands[1]) + ' (if the other one is right)');
    const lrow = db.rows.get(res.lemma);
    const listed = lrow?.exchange ? Object.values(parseExchange(lrow.exchange)).some((v) => v.toLowerCase() === key) : false;
    if (!listed) push('lemma-does-not-list-form', `"${res.lemma}" does not list "${key}" among its forms in ECDICT (own '0:' link only)`, fixLemma(key, res.lemma) + ' (confirm) or ' + fixLemma(key, key));
    if (row && hasOwnMeaning(row) && rank(key) < rank(res.lemma)) push('form-more-common-than-lemma', `"${key}" has its own meaning and is more frequent (rank ${rank(key)}) than "${res.lemma}" (rank ${rank(res.lemma)})`, fixLemma(key, key));
    if (key.endsWith('ing') && row && hasNounSense(row.translation) && rank(key) < 5000 && !ov.lexicalizedIng.has(key)) push('lexicalized-ing-candidate', `"-ing" form with its own noun/adjective meaning; currently shows "${res.lemma}"`, `"lexicalizedIng": [ …, "${key}" ]`);
  }
  if (res.via === 'normal' && key === res.lemma && !row) push('no-row', 'resolved without a dictionary row');
  const lv = cefr[res.lemma] ?? cefr[key];
  if (!lv) findings.push({ kind: 'no-cefr', word: res.lemma, detail: 'lemma has no CEFR level (counts as off-level in coverage)', articles: arts });
}
const hasTerm = (w: string) => Object.prototype.hasOwnProperty.call(ov.terms, w);
void hasTerm;
findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.word.localeCompare(b.word));
const byKind = new Map<string, Finding[]>();
for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);

const KIND_HELP: Record<string, string> = {
  fallback: 'Words ECDICT does not know as a form; the lemma was guessed by suffix rules. Check, then add to "lemma" (or "terms").',
  hyphen: 'Hyphenated words missing from ECDICT as a whole. Informational: the card lists each part\'s definition in order. Add to "terms" only when a single combined gloss is clearly better.',
  ambiguous: 'ECDICT lists several possible lemmas. The first (most frequent) is used. Override if the other is more natural.',
  'lemma-does-not-list-form': 'Lemma link exists only on the form\'s own row. Usually fine; check unusual ones.',
  'form-more-common-than-lemma': 'The clicked form is more frequent than its claimed lemma and has its own meaning (e.g. number→numb). Likely wrong lemma: override to itself.',
  'lexicalized-ing-candidate': '-ing words with their own meaning that currently show the verb. Add to "lexicalizedIng" if the noun/adjective sense is the common one.',
  'no-cefr': 'Lemmas missing from the CEFR lists. Informational; they count as off-level.',
  'no-row': 'Internal: resolved without a dictionary row.',
};
let md = `# Build report\n\nGenerated ${new Date().toISOString()} · ${articles.length} articles\n\nReports never fail the build. Only a word with no definition at all does.\n\n`;
md += `## Summary\n\n| item | count |\n|---|---|\n`;
for (const [k, v] of byKind) md += `| ${k} | ${v.length} |\n`;
md += `| calibration flags (needs manual review) | ${flags.length} |\n\n`;
md += `## Calibration flags (manual review)\n\n${flags.length ? flags.map((f) => `- ${f}`).join('\n') : '_none_'}\n\n`;
md += `## Per-article stats\n\n| article | words | avg sentence | coverage | off-level (top) |\n|---|---|---|---|---|\n`;
for (const a of [...articles].sort((x, y) => x.id.localeCompare(y.id))) md += `| ${a.id} | ${a.wordCount} | ${a.meta.stats.avgSentenceLen} | ${(a.meta.stats.coverageAtLevel * 100).toFixed(1)}% | ${a.meta.stats.offLevelWords.slice(0, 6).join(', ')} |\n`;
md += `\n## Missed or suspicious lemmas\n\nFix by editing \`content/lemma-overrides.json\` (the only place for manual fixes), then rebuild.\n`;
for (const [k, list] of byKind) {
  md += `\n### ${k} (${list.length})\n\n${KIND_HELP[k] ?? ''}\n\n`;
  for (const f of list.slice(0, k === 'no-cefr' ? 400 : 200)) md += `- **${f.word}** — ${f.detail} _[${f.articles.join(', ')}]_${f.fix ? `\n  - fix: \`${f.fix}\`` : ''}\n`;
}
const out = resolve(ROOT, 'public/data');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'articles'), { recursive: true });
mkdirSync(resolve(out, 'dict'), { recursive: true });
const sorted = [...articles].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.id.localeCompare(b.id));
const index: ArticleIndex = {
  schema: 1,
  // deterministic (no wall clock) so identical content gives an identical build / service-worker version
  generatedAt: `${articles.map((a) => a.meta.createdAt).sort().at(-1) ?? '1970-01-01'}T00:00:00Z`,
  articles: sorted.map(({ id, level, title, topics, genre, wordCount, minutes, source }): ArticleMeta => ({ id, level, title, topics, genre, wordCount, minutes, source })),
};
const write = (p: string, data: unknown) => writeFileSync(resolve(out, p), JSON.stringify(data));
write('index.json', index);
for (const a of sorted) write(`articles/${a.id}.json`, a);
write('dict/forms.json', formsOut);
for (const lv of LEVELS) write(`dict/entries-${lv.toLowerCase()}.json`, shards[lv]);

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(resolve(ROOT, 'reports/build-report.md'), md);
writeFileSync(resolve(ROOT, 'reports/build-report.json'), JSON.stringify({ flags, findings, articles: sorted.map((a) => ({ id: a.id, level: a.level, words: a.wordCount, ...a.meta.stats, offLevelAll: offAll.get(a.id) ?? [] })) }, null, 2));
const size = (p: string) => readFileSync(resolve(out, p)).length;
console.log(`[data] ${articles.length} articles; forms=${Object.keys(formsOut).length}; entries B1/B2/C1 = ${LEVELS.map((l) => Object.keys(shards[l]).length).join('/')}`);
console.log(`[data] shard bytes: forms=${size('dict/forms.json')} ${LEVELS.map((l) => `${l}=${size(`dict/entries-${l.toLowerCase()}.json`)}`).join(' ')}`);
for (const a of sorted) console.log(`  ${a.id} words=${a.wordCount} sentLen=${a.meta.stats.avgSentenceLen} coverage=${a.meta.stats.coverageAtLevel}`);
console.log(`[data] report → reports/build-report.md: ${[...byKind].filter(([k]) => k !== 'no-cefr').map(([k, v]) => `${k}=${v.length}`).join(' ') || 'no findings'}; no-cefr=${byKind.get('no-cefr')?.length ?? 0}; calibration flags=${flags.length}`);
for (const f of flags) console.log('  ⚑ ' + f);
