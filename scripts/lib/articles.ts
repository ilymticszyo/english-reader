import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './ecdict.ts';

export interface SourceArticle {
  file: string;
  front: Record<string, string | string[]>;
  paragraphs: string[];
}

function parseValue(v: string): string | string[] {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return v;
}

export function loadSourceArticles(): SourceArticle[] {
  const dir = resolve(ROOT, 'content/articles');
  const out: SourceArticle[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const raw = readFileSync(resolve(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`${f}: missing frontmatter`);
    const front: Record<string, string | string[]> = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) front[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
    }
    const paragraphs = m[2]
      .trim()
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean);
    out.push({ file: f, front, paragraphs });
  }
  return out;
}
