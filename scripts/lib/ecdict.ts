import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { LEVEL_RANK } from '../../src/shared/types.ts';
import { candidateKeys } from '../../src/shared/text.ts';
import type { DictEntry, DictDef } from '../../src/shared/types.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ECDICT_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';

export interface Row {
  word: string;
  phonetic: string;
  translation: string;
  collins: number;
  oxford: string;
  tag: string;
  bnc: number;
  frq: number;
  exchange: string;
}

export async function ensureEcdict(): Promise<string> {
  const path = process.env.ECDICT_CSV || resolve(ROOT, 'data-src/ecdict.csv');
  if (!existsSync(path)) {
    console.log(`[data] ECDICT not found, downloading ${ECDICT_URL} (~66MB) ...`);
    const res = await fetch(ECDICT_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return path;
}

export interface Db {
  /** lowercase key -> row */
  rows: Map<string, Row>;
  /** form (lowercase) -> lemmas that list it in their exchange field */
  reverse: Map<string, Set<string>>;
}

export function parseExchange(ex: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of ex.split('/')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function loadDb(path: string): Db {
  const raw = readFileSync(path, 'utf8');
  const recs: Record<string, string>[] = parse(raw, { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const rows = new Map<string, Row>();
  for (const r of recs) {
    const w = r.word;
    if (!w) continue;
    const key = w.toLowerCase();
    const row: Row = {
      word: w,
      phonetic: r.phonetic || '',
      translation: r.translation || '',
      collins: Number(r.collins) || 0,
      oxford: r.oxford || '',
      tag: r.tag || '',
      bnc: Number(r.bnc) || 0,
      frq: Number(r.frq) || 0,
      exchange: r.exchange || '',
    };
    const prev = rows.get(key);
    if (!prev || (prev.word !== key && w === key)) rows.set(key, row);
  }
  const reverse = new Map<string, Set<string>>();
  for (const [lemma, row] of rows) {
    if (!row.exchange) continue;
    const ex = parseExchange(row.exchange);
    for (const k of ['p', 'd', 'i', '3', 's', 'r', 't']) {
      const f = ex[k]?.toLowerCase();
      if (!f || f === lemma) continue;
      if (!reverse.has(f)) reverse.set(f, new Set());
      reverse.get(f)!.add(lemma);
    }
  }
  return { rows, reverse };
}

const rank = (r?: Row) => (r ? (r.frq > 0 ? r.frq : r.bnc > 0 ? r.bnc : 1e9) : 1e9);

/** Candidate lemmas for a word form (primary first); empty = the word is its own lemma. */
export function lemmasOf(db: Db, form: string, overrides: Record<string, string> = {}): string[] {
  if (Object.prototype.hasOwnProperty.call(overrides, form)) {
    return overrides[form] === form ? [] : [overrides[form]];
  }
  const out: string[] = [];
  const own = db.rows.get(form);
  if (own?.exchange) {
    const l = parseExchange(own.exchange)['0']?.toLowerCase();
    if (l && l !== form && db.rows.has(l)) out.push(l);
  }
  const rev = [...(db.reverse.get(form) ?? [])].filter((l) => db.rows.has(l)).sort((a, b) => rank(db.rows.get(a)) - rank(db.rows.get(b)));
  for (const l of rev) if (!out.includes(l)) out.push(l);
  return out;
}

const INFLECTION_NOTE = /过去式|过去分词|现在分词|复数|单数|比较级|最高级|的变形|ing形式|的ing|第三人称/;

function splitLines(tr: string): string[] {
  return tr
    .split(/\\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True if the row has a meaning of its own, beyond "xxx的过去式". */
export function hasOwnMeaning(row: Row): boolean {
  const lines = splitLines(row.translation).filter((l) => !l.startsWith('[网络]'));
  return lines.some((l) => !(l.length < 40 && (INFLECTION_NOTE.test(l) || /^pl\./.test(l))));
}

function parseDefs(tr: string): DictDef[] {
  let lines = splitLines(tr);
  const web = lines.filter((l) => l.startsWith('[网络]'));
  let main = lines.filter((l) => !l.startsWith('[网络]'));
  const noName = main.filter((l) => !/人名|地名|姓氏/.test(l));
  if (noName.length) main = noName;
  if (!main.length) main = web;
  lines = main;
  const defs: DictDef[] = [];
  for (const l of lines) {
    const m = l.match(/^((?:[a-z]+\.)(?:\/[a-z]+\.)*|\[[^\]]+\])\s*(.*)$/);
    if (m && m[2]) defs.push({ pos: m[1], zh: m[2] });
    else defs.push({ pos: '', zh: l });
  }
  return defs;
}

export function normalizePhonetic(p: string): string {
  return p
    .replace(/ә/g, 'ə')
    .replace(/'/g, 'ˈ')
    .replace(/:/g, 'ː')
    .replace(/ɡ/g, 'ɡ')
    .trim();
}

export function makeEntry(row: Row, cefr: Record<string, string>, key: string): DictEntry {
  const e: DictEntry = { d: parseDefs(row.translation) };
  const p = normalizePhonetic(row.phonetic);
  if (p) e.p = p;
  const c = cefr[key];
  if (c) e.cefr = c;
  const tags = row.tag.split(/\s+/).filter(Boolean);
  if (tags.length) e.tags = tags;
  if (row.collins) e.col = row.collins;
  if (row.exchange) {
    const ex = parseExchange(row.exchange);
    const keep: Record<string, string> = {};
    for (const k of ['p', 'd', 'i', '3', 's', 'r', 't']) if (ex[k]) keep[k] = ex[k];
    if (Object.keys(keep).length) e.ex = keep;
  }
  return e;
}

export function loadCefr(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (headwords: string, level: string) => {
    for (const h of headwords.split('/')) {
      const w = h.trim().toLowerCase();
      if (!w || w.includes(' ') || !(level in LEVEL_RANK)) continue;
      if (!out[w] || LEVEL_RANK[level] < LEVEL_RANK[out[w]]) out[w] = level;
    }
  };
  for (const f of ['cefrj.csv', 'octanove-c1c2.csv']) {
    const p = resolve(ROOT, 'data-src/cefr', f);
    const recs: Record<string, string>[] = parse(readFileSync(p, 'utf8'), { columns: true, relax_column_count: true, skip_empty_lines: true });
    for (const r of recs) add(r.headword, r.CEFR);
  }
  return out;
}

export interface BuildRes {
  key: string;
  lemma: string;
  kind: 'proper' | 'dict';
}

/** Build-time resolution of a clicked token: whitelist -> ECDICT lemma (exchange field) -> own headword. */
export function resolveForBuild(token: string, db: Db, proper: Record<string, string>, overrides: Record<string, string>): BuildRes | null {
  for (const c of candidateKeys(token)) {
    if (Object.prototype.hasOwnProperty.call(proper, c)) return { key: c, lemma: c, kind: 'proper' };
    const lc = c.toLowerCase();
    const lem = lemmasOf(db, lc, overrides);
    if (lem.length) return { key: lc, lemma: lem[0], kind: 'dict' };
    if (db.rows.has(lc)) return { key: lc, lemma: lc, kind: 'dict' };
  }
  return null;
}
