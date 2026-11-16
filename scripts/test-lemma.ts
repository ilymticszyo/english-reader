// Lemmatisation regression test against the full ECDICT, using the same resolver code as the browser.
// Builds a mini dictionary for the tested words (like the real build does) and resolves each clicked form.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, ensureEcdict, hasOwnMeaning, loadDb, resolveForBuild } from './lib/ecdict.ts';
import { resolveToken, viewOf } from '../src/shared/text.ts';

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'tests/lemma-cases.json'), 'utf8'));
const proper = JSON.parse(readFileSync(resolve(ROOT, 'content/proper-nouns.json'), 'utf8'));
const overrides = JSON.parse(readFileSync(resolve(ROOT, 'content/lemma-overrides.json'), 'utf8'));
delete proper._comment;
delete overrides._comment;
const db = loadDb(await ensureEcdict());

const basic: [string, string][] = cfg.cases;
const amb: [string, string][] = cfg.ambiguous.cases;
const forms: Record<string, string> = {};
const entries: Record<string, object> = {};
for (const [w] of [...basic, ...amb]) {
  const r = resolveForBuild(w, db, proper, overrides);
  if (!r) continue;
  entries[r.lemma] = {};
  if (r.key !== r.lemma) {
    forms[r.key] = r.lemma;
    const row = db.rows.get(r.key);
    if (row && hasOwnMeaning(row)) entries[r.key] = {};
  }
}
const view = viewOf(forms, entries);
let fail = 0;
let n = 0;
for (const [form, lemma] of [...basic, ...amb]) {
  n++;
  const got = resolveToken(form, view);
  if (!got || got.lemma !== lemma) {
    fail++;
    console.log(`  ✗ ${form}: expected ${lemma}, got ${got ? got.lemma : 'NOT FOUND'}`);
  }
}
let ownEntries = 0;
for (const [form, lemma] of amb) {
  const row = db.rows.get(form);
  if (form !== lemma && row && hasOwnMeaning(row)) ownEntries++;
}
console.log(`lemma cases: ${n - fail}/${n} passed; ambiguous words with own collapsible entry: ${ownEntries}`);
if (ownEntries < 30) {
  console.log('  ✗ expected at least 30 ambiguous words with their own entry (PRD C5)');
  fail++;
}
process.exit(fail ? 1 : 0);
