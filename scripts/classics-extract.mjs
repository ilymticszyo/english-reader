// Dev tool (not part of the build): cut an excerpt for content/classics/ from a Project Gutenberg plain-text file.
// The PG header/footer (everything outside "*** START OF ... ***" / "*** END OF ... ***") and [Illustration] captions
// (not the author's text) are dropped; line wraps are joined; _italics_ markers removed; "--" becomes an em dash.
//   PG_DIR=/path/to/pg-texts node scripts/classics-extract.mjs <ebook#> "<start phrase>" "<phrase in last paragraph>"
//   PG_DIR=... node scripts/classics-extract.mjs show <ebook#> "<phrase>" [n]     (paragraph survey with running word count)
//   PG_DIR=... node scripts/classics-extract.mjs fill                              (rewrite "## Excerpt" of every content/classics/cl-*.md
//                                                                                    from its sourceStart / sourceEnd / excerptPrefix frontmatter)
// Texts: https://www.gutenberg.org/cache/epub/<n>/pg<n>.txt (or a PG mirror such as gutenberg.pglaf.org) saved as pg<n>.txt.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
export function body(n) {
  const raw = readFileSync(`${process.env.PG_DIR || '.'}/pg${n}.txt`, 'utf8').replace(/\r\n/g, '\n');
  const s = raw.search(/\*\*\* START OF TH(E|IS) PROJECT GUTENBERG EBOOK[^\n]*\n/);
  const e = raw.search(/\*\*\* END OF TH(E|IS) PROJECT GUTENBERG EBOOK/);
  if (s < 0 || e < 0) throw new Error('no PG markers in ' + n);
  let text = raw.slice(raw.indexOf('\n', s) + 1, e);
  // drop [Illustration ...] blocks (may nest brackets and span lines): captions are not the author's text
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('[Illustration', i)) {
      let d = 0;
      for (; i < text.length; i++) { if (text[i] === '[') d++; else if (text[i] === ']') { d--; if (d === 0) { i++; break; } } }
      continue;
    }
    out += text[i++];
  }
  text = out.replace(/--/g, '—').replace(/œ/g, 'oe').replace(/Œ/g, 'Oe').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae'); // ligatures are typography, not spelling
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/_/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}
export function extract(n, start, end) {
  const ps = body(n);
  const i = ps.findIndex((p) => p.includes(start));
  if (i < 0) throw new Error(`start not found: ${start}`);
  let j = -1;
  for (let k = i; k < ps.length; k++) if (ps[k].includes(end)) { j = k; break; }
  if (j < 0) throw new Error(`end not found: ${end}`);
  const out = ps.slice(i, j + 1);
  out[0] = out[0].slice(out[0].indexOf(start));
  return out;
}
export const wc = (ps) => (ps.join(' ').match(/[A-Za-zÀ-ÿ]+(?:['’-][A-Za-zÀ-ÿ]+)*/g) ?? []).length;
if (process.argv[2] === 'fill') {
  const dir = new URL('../content/classics/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => /^cl-\d{3}\.md$/.test(x)).sort()) {
    const raw = readFileSync(new URL(f, dir), 'utf8');
    const fm = Object.fromEntries(raw.split('\n---\n')[0].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
    const n = (fm.edition.match(/#(\d+)/) || [])[1];
    const ps = extract(n, fm.sourceStart, fm.sourceEnd);
    if (fm.excerptPrefix) ps[0] = fm.excerptPrefix + ps[0];
    const next = raw.replace(/(## Excerpt\n\n)[\s\S]*?(\n\n## )/, (_, a, b) => a + ps.join('\n\n') + b);
    writeFileSync(new URL(f, dir), next);
    console.log(f, wc(ps), 'words');
  }
} else if (process.argv[2] === 'show') {
  const ps = body(process.argv[3]);
  const i = ps.findIndex((p) => p.includes(process.argv[4]));
  const n = Number(process.argv[5] || 40);
  let acc = 0;
  for (const p of ps.slice(i, i + n)) { acc += wc([p]); console.log(`[${acc}] ${p.slice(0, Number(process.argv[6] || 140))}`); }
} else if (process.argv[2]) {
  const out = extract(process.argv[2], process.argv[3], process.argv[4]);
  console.log(out.join('\n\n'));
  console.log(`\n== ${wc(out)} words, ${out.length} paragraphs`);
}
