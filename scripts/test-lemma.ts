// Lemmatisation regression test against the full ECDICT, using the same resolver code as the browser.
// Builds a mini dictionary for the tested words (like the real build does) and resolves each clicked form.
//   cases            [form, expected lemma]
//   ambiguous        words that are both an inflected form AND have their own entry (PRD C5, need >= 30)
//   lexicalizedIng / lexicalizedAdj   every word in these override lists must be its own lemma (verb folded as `alt`)
//   formSelfFirst  every word in this list is its own lemma too (lemma folded as `alt`, CEFR falls back to the lemma's)
//   hyphen           hyphenated words: whole ECDICT headword stays whole, otherwise the card lists the parts in order
//   verbalIng        -ing words that must keep resolving to the verb (running -> run, going -> go, ...)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, applyCefrOverrides, ensureEcdict, hasOwnMeaning, lexAlt, loadCefr, loadDb, loadOverrides, makeEntry, resolveForBuild } from './lib/ecdict.ts';
import { resolveToken, tokenize, viewOf } from '../src/shared/text.ts';

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'tests/lemma-cases.json'), 'utf8'));
const ov = loadOverrides();
const db = loadDb(await ensureEcdict());

const basic: [string, string][] = cfg.cases;
const amb: [string, string][] = cfg.ambiguous.cases;
const lexExpect: [string, string][] = [...cfg.lexicalizedIngCases, ...cfg.lexicalizedAdjCases, ...cfg.formSelfFirstCases]; // [word, expected folded verb lemma or ""]
const verbal: [string, string][] = cfg.verbalIng;
const hyphen: [string, string, [string, string][] | null][] = cfg.hyphen.cases;

const forms: Record<string, string> = {};
const entries: Record<string, { alt?: string; parts?: { w: string; l: string }[] }> = {};
const words = [...basic, ...amb, ...verbal].map(([w]) => w).concat([...ov.lexicalized], lexExpect.map(([w]) => w));
for (const w of words) {
  const r = resolveForBuild(w, db, ov);
  if (!r) continue;
  entries[r.lemma] = {};
  if (ov.lexicalized.has(r.lemma)) {
    const alt = lexAlt(db, r.lemma);
    if (alt && alt !== r.lemma) {
      entries[r.lemma] = { alt };
      entries[alt] = {};
    }
  }
  if (r.key !== r.lemma) {
    forms[r.key] = r.lemma;
    const row = db.rows.get(r.key);
    if (row && hasOwnMeaning(row)) entries[r.key] = {};
  }
}
// hyphenated words: whole ECDICT headword -> itself; otherwise a compound whose entry lists every part (same shape as build-data.ts)
for (const [tok] of hyphen) {
  const r = resolveForBuild(tok, db, ov);
  if (!r) continue;
  entries[r.lemma] = r.parts ? { parts: r.parts } : {};
  for (const p of r.parts ?? []) {
    entries[p.l] ??= {};
    if (p.w !== p.l) forms[p.w] = p.l;
  }
}
const view = viewOf(forms, entries);
let fail = 0;
let n = 0;
const expect = (form: string, lemma: string, label: string) => {
  n++;
  const got = resolveToken(form, view);
  if (!got || got.lemma !== lemma) {
    fail++;
    console.log(`  ✗ [${label}] ${form}: expected ${lemma}, got ${got ? got.lemma : 'NOT FOUND'}`);
  }
};
for (const [f, l] of basic) expect(f, l, 'basic');
for (const [f, l] of amb) expect(f, l, 'ambiguous');
for (const [f, l] of verbal) expect(f, l, 'verbal -ing');
for (const w of ov.lexicalizedIng) expect(w, w, 'lexicalized -ing');
for (const w of ov.lexicalizedAdj) expect(w, w, 'lexicalized adjective participle');
for (const w of ov.formSelfFirst) expect(w, w, 'form-self-first');
for (const [w, alt] of lexExpect) {
  n++;
  const got = entries[w]?.alt ?? '';
  if (got !== alt) {
    fail++;
    console.log(`  ✗ [lexicalized alt] ${w}: expected folded verb "${alt}", got "${got}"`);
  }
}
for (const [tok, key, parts] of hyphen) {
  n += 2;
  const build = resolveForBuild(tok, db, ov);
  const got = resolveToken(tok, view);
  const gotParts = (entries[got?.lemma ?? '']?.parts ?? null)?.map((p) => [p.w, p.l]) ?? null;
  if (!build || build.key !== key || JSON.stringify((build.parts ?? null)?.map((p) => [p.w, p.l]) ?? null) !== JSON.stringify(parts)) {
    fail++;
    console.log(`  ✗ [hyphen build] ${tok}: expected key ${key} parts ${JSON.stringify(parts)}, got ${JSON.stringify(build)}`);
  }
  if (!got || got.lemma !== key || JSON.stringify(gotParts) !== JSON.stringify(parts)) {
    fail++;
    console.log(`  ✗ [hyphen runtime] ${tok}: expected ${key} ${JSON.stringify(parts)}, got ${got?.lemma} ${JSON.stringify(gotParts)}`);
  }
}
// decade forms are one non-word token: not counted, not clickable (no stray "s")
const tokCases: [string, string[]][] = cfg.tokenizer;
for (const [text, want] of tokCases) {
  n++;
  const got = tokenize(text).map((t) => t.text);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++;
    console.log(`  ✗ [tokenizer] ${JSON.stringify(text)}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}
// CEFR: manual levels win; whitelist words without their own level take the verb lemma's level; lead definition goes first
const cefrOwn = loadCefr();
const cefrAll = loadCefr();
applyCefrOverrides(cefrAll, db, ov);
for (const [w, lv] of cfg.cefr.manual as [string, string][]) {
  n++;
  if (cefrAll[w] !== lv) { fail++; console.log(`  ✗ [cefr manual] ${w}: expected ${lv}, got ${cefrAll[w]}`); }
}
for (const [w, verb] of cfg.cefr.fallback as [string, string][]) {
  n++;
  if (cefrOwn[w] || !cefrOwn[verb] || cefrAll[w] !== cefrOwn[verb]) { fail++; console.log(`  ✗ [cefr fallback] ${w}: own=${cefrOwn[w]} verb(${verb})=${cefrOwn[verb]} got ${cefrAll[w]}`); }
}
for (const [w, pos, zh] of cfg.cefr.leadDefs as [string, string, string][]) {
  n++;
  const row = db.rows.get(w);
  const e = row ? makeEntry(row, cefrAll, w, ov) : null;
  if (!e || e.d[0]?.pos !== pos || !e.d[0].zh.includes(zh) || e.d.length < 2) { fail++; console.log(`  ✗ [leadDef] ${w}: first def ${JSON.stringify(e?.d[0])}`); }
}
let ownEntries = 0;
for (const [form, lemma] of amb) {
  const row = db.rows.get(form);
  if (form !== lemma && row && hasOwnMeaning(row)) ownEntries++;
}
const total = basic.length;
console.log(`lemma cases: ${n - fail}/${n} passed (basic ${total}, ambiguous ${amb.length}, lexicalized -ing ${ov.lexicalizedIng.size}, adjectival participles ${ov.lexicalizedAdj.size}, form-self-first ${ov.formSelfFirst.size}, ${lexExpect.length} alt checks, verbal -ing ${verbal.length}, hyphen ${hyphen.length}x2, tokenizer ${tokCases.length}, cefr ${cfg.cefr.manual.length + cfg.cefr.fallback.length + cfg.cefr.leadDefs.length}); ambiguous words with own collapsible entry: ${ownEntries}`);
if (total < 200) {
  console.log(`  ✗ need >= 200 basic cases, have ${total}`);
  fail++;
}
if (ownEntries < 30) {
  console.log('  ✗ expected at least 30 ambiguous words with their own entry (PRD C5)');
  fail++;
}
process.exit(fail ? 1 : 0);
