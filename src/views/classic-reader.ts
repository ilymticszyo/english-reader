import { clear, h, toast } from '../dom.ts';
import { ensureClassicsDict, glossFor, loadClassic, loadClassicsIndex, lookupClassic } from '../data.ts';
import { closeCard, showCard } from '../popup.ts';
import { splitSentences, tokenize } from '../shared/text.ts';
import type { Classic, GlossItem } from '../shared/types.ts';
import { getProgress, getSettings, getStatus, isActiveWord, minutesOf, onChange, setProgress, setSettings } from '../store.ts';
import { filterClassics } from './classics.ts';

type Kind = 'intro' | 'excerpt' | 'appreciation' | 'model' | 'model-note';
interface Block { text: string; kind: Kind }

const pct = (x: number) => `${Math.round(x * 100)}%`;

export async function mountClassicReader(root: HTMLElement, id: string, query: URLSearchParams): Promise<() => void> {
  root.append(h('p', { class: 'muted' }, '加载中…'));
  let c: Classic;
  try {
    c = await loadClassic(id);
  } catch {
    clear(root);
    root.append(h('div', { class: 'empty' }, h('p', null, '找不到这篇名著选段。'), h('a', { class: 'btn', href: '#/classics' }, '返回名著列表')));
    return () => {};
  }
  const [index] = await Promise.all([loadClassicsIndex(), ensureClassicsDict()]);
  clear(root);

  // the excerpt's own notes, keyed like the build does (lower case, straight apostrophe)
  const glossary = new Map<string, GlossItem>(c.glossary.map((g) => [g.form, g]));

  // G8: prev / next walk the list as currently filtered (falls back to the full list if this one is filtered out)
  let siblings = filterClassics(index.excerpts);
  if (!siblings.some((x) => x.id === id)) siblings = index.excerpts;
  const pos = siblings.findIndex((x) => x.id === id);
  const prev = siblings[pos - 1];
  const next = siblings[pos + 1];

  // every text block is clickable; one flat index so vocab context (p, s) can point at any block
  const blocks: Block[] = [
    ...c.intro.map((text) => ({ text, kind: 'intro' as const })),
    ...c.paragraphs.map((text) => ({ text, kind: 'excerpt' as const })),
    ...c.appreciation.map((text) => ({ text, kind: 'appreciation' as const })),
    ...c.modelSentences.flatMap((m) => [{ text: m.text, kind: 'model' as const }, { text: m.note, kind: 'model-note' as const }]),
  ];
  const quoted = (k: Kind) => k === 'excerpt' || k === 'model'; // the author's words: notes apply here only

  // ---------- header ----------
  const statusBtn = h('button', { class: 'btn small', type: 'button', id: 'cl-status' });
  const statusBtn2 = h('button', { class: 'btn', type: 'button', onclick: () => statusBtn.click() });
  const syncStatus = () => {
    const st = getStatus(id);
    statusBtn.textContent = st === 'read' ? '✓ 已读（点击改回未读）' : '标记为已读';
    statusBtn.classList.toggle('done', st === 'read');
    statusBtn2.textContent = statusBtn.textContent;
  };
  statusBtn.addEventListener('click', () => {
    if (getStatus(id) === 'read') setProgress(id, { status: 'unread', scroll: 0 });
    else setProgress(id, { status: 'read', scroll: 1 });
  });
  const fsDown = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '减小字号', onclick: () => setSettings({ fontSize: Math.max(0, getSettings().fontSize - 1) }) }, 'A−');
  const fsUp = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '增大字号', onclick: () => setSettings({ fontSize: Math.min(3, getSettings().fontSize + 1) }) }, 'A+');
  const syncTools = () => {
    const s = getSettings();
    fsDown.disabled = s.fontSize <= 0;
    fsUp.disabled = s.fontSize >= 3;
  };

  const src = c.source;
  const sourceLink = h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer', class: 'cl-source-link' }, `${src.edition} ↗`);
  const head = h('header', { class: 'article-head classic-head' },
    h('a', { class: 'backlink', href: '#/classics' }, '← 名著列表'),
    h('div', { class: 'cl-work' }, h('cite', null, c.work), h('span', { class: 'muted' }, ` · ${c.author}`)),
    h('h1', { class: 'article-title', lang: 'en' }, c.title),
    h('div', { class: 'cl-chapter muted', lang: 'en' }, `${c.chapter} — ${c.scene}`),
    h('div', { class: 'article-meta muted' },
      h('span', { class: `badge lv lv-${c.refLevel}`, title: '参考难度（不计入分级）' }, `参考 ${c.refLevel}`),
      `原文 ${c.wordCount} 词 · 全篇约 ${minutesOf(c.totalWords)} 分钟`,
      h('span', { class: 'cl-source' }, '来源：', sourceLink, ` · ${src.year}`)),
    c.spoiler ? h('p', { class: 'spoiler-note', role: 'note' }, '⚠ 剧透提醒：本选段涉及结局或关键反转。') : null,
    h('div', { class: 'article-tools' }, fsDown, fsUp, statusBtn),
  );

  const paras: HTMLElement[] = [];
  const mkPara = (i: number, tag: 'p' | 'blockquote' = 'p') => {
    const el = h(tag, { dataset: { p: String(i) } });
    paras[i] = el;
    return el;
  };
  const sec = (key: string, title: string, ...kids: (Node | null)[]) =>
    h('section', { class: `cl-block cl-${key}`, id: `cl-${key}`, 'aria-labelledby': `cl-${key}-h` }, h('h2', { class: 'cl-h', id: `cl-${key}-h`, lang: 'en' }, title), ...kids);

  const introBody = h('div', { class: 'article-body cl-commentary', lang: 'en' });
  const excerptBody = h('div', { class: 'article-body cl-excerpt-body', lang: 'en' });
  const apprBody = h('div', { class: 'article-body cl-commentary', lang: 'en' });
  const modelList = h('ol', { class: 'cl-models', lang: 'en' });
  blocks.forEach((b, i) => {
    if (b.kind === 'intro') introBody.append(mkPara(i));
    else if (b.kind === 'excerpt') excerptBody.append(mkPara(i));
    else if (b.kind === 'appreciation') apprBody.append(mkPara(i));
    else if (b.kind === 'model') modelList.append(h('li', { class: 'cl-model' }, mkPara(i, 'blockquote')));
    else modelList.lastElementChild!.append(h('div', { class: 'cl-model-note' }, mkPara(i)));
  });

  // ---------- 本篇注释: the excerpt's notes + archaic forms it uses ----------
  const noteItems: GlossItem[] = [...c.glossary, ...c.archaismsUsed.map((k) => glossFor(new Map(), k)).filter((g): g is GlossItem => !!g)];
  const firstOcc = (form: string) => [...root.querySelectorAll<HTMLElement>('.cl-excerpt-body .w.gl')].find((el) => el.dataset.g === form);
  const notesList = () => h('dl', { class: 'notes-list' }, ...noteItems.flatMap((g) => [
    h('dt', null, h('button', { class: 'linkbtn note-jump', type: 'button', lang: 'en', dataset: { form: g.form }, title: '在原文中定位', onclick: () => {
      drawer.hidden = true;
      const el = firstOcc(g.form);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2000);
    } }, g.form)),
    h('dd', null, h('span', { lang: 'en' }, g.note), h('span', { class: 'muted' }, ` ${g.zh}`)),
  ]));
  const notesInline = sec('notes', 'Notes · 本篇注释',
    h('p', { class: 'muted small' }, '原文中带虚线下划线的词有注释，点词查看；古旧或易误解的词义以注释为准。'), notesList());
  const drawer = h('div', { class: 'notes-drawer', role: 'dialog', 'aria-label': '本篇注释', hidden: true },
    h('div', { class: 'nd-head' }, h('strong', null, `本篇注释（${noteItems.length}）`), h('button', { class: 'iconbtn', type: 'button', 'aria-label': '关闭注释', onclick: () => (drawer.hidden = true) }, '✕')),
    h('div', { class: 'nd-body' }, notesList()));
  const fab = h('button', { class: 'notes-fab', type: 'button', 'aria-label': '打开本篇注释', onclick: () => { closeCard(); drawer.hidden = !drawer.hidden; } }, `注释 ${noteItems.length}`);

  // ---------- G9: vocabulary distribution (reference only) ----------
  const st = c.meta.stats;
  const dist = h('details', { class: 'cl-dist' },
    h('summary', null, '词汇分布（仅供参考）'),
    h('ul', { class: 'dist-bars' }, ...(['B1', 'B2', 'C1'] as const).map((lv) =>
      h('li', null, h('span', { class: 'dist-lv' }, `≤ ${lv}`), h('span', { class: 'dist-bar' }, h('span', { class: 'dist-fill', style: `width:${pct(st.distribution[lv])}` })), h('span', { class: 'dist-n' }, pct(st.distribution[lv]))))),
    h('p', { class: 'muted small' }, `平均句长 ${st.avgSentenceLen} 词。名著不按覆盖率分级，参考难度 ${c.refLevel} 仅帮助选篇。`),
    st.offLevelWords.length ? h('p', { class: 'muted small', lang: 'en' }, `Above ${c.refLevel}: ${st.offLevelWords.slice(0, 12).join(', ')}…`) : null);

  const attribution = h('footer', { class: 'cl-attrib small muted' },
    h('p', null, '原文来自 ', h('a', { href: 'https://www.gutenberg.org/', target: '_blank', rel: 'noopener noreferrer' }, 'Project Gutenberg'), '（', sourceLink.cloneNode(true), '），', `${c.work}（${src.year}）`, '在美国属于公有领域（public domain）。'),
    h('p', null, src.pdNote),
    h('p', null, '本站只摘录作者正文，已去除 Project Gutenberg 的页眉、页脚与许可声明；导读、注释与赏析为本站撰写。本站与 Project Gutenberg 无关联。'));

  const nav = h('nav', { class: 'article-nav', 'aria-label': '上一篇 / 下一篇' },
    prev ? h('a', { class: 'btn', href: `#/classics/${prev.id}`, rel: 'prev' }, `← ${prev.title}`) : h('span', { class: 'btn disabled', 'aria-disabled': 'true' }, '← 上一篇'),
    next ? h('a', { class: 'btn', href: `#/classics/${next.id}`, rel: 'next' }, `${next.title} →`) : h('span', { class: 'btn disabled', 'aria-disabled': 'true' }, '下一篇 →'));

  const article = h('article', { class: 'reader classic-reader', dataset: { id } },
    head,
    sec('background', 'Background', introBody),
    sec('excerpt', 'The Excerpt', excerptBody),
    notesInline,
    sec('appreciation', 'Appreciation', apprBody),
    sec('imitate', 'Sentences to imitate', modelList),
    dist,
    h('div', { class: 'article-foot' }, statusBtn2),
    nav,
    attribution);
  root.append(article, fab, drawer);

  // ---------- clickable words in every block ----------
  const renderBlocks = () => {
    blocks.forEach((b, i) => {
      const el = paras[i];
      clear(el);
      let cursor = 0;
      for (const t of tokenize(b.text)) {
        if (t.start > cursor) el.append(b.text.slice(cursor, t.start));
        const g = quoted(b.kind) ? glossFor(glossary, t.text) : null;
        const r = lookupClassic(t.text, g);
        const span = h('span', { class: g ? 'w gl' : 'w', tabindex: '0', dataset: { s: String(t.start), l: r.lemma } }, t.text);
        if (g) {
          span.dataset.g = g.form;
          span.title = '有注释';
        }
        el.append(span);
        cursor = t.end;
      }
      if (cursor < b.text.length) el.append(b.text.slice(cursor));
    });
    syncHighlight();
  };
  const syncHighlight = () => {
    const on = getSettings().highlightKnown;
    article.classList.toggle('hl-known', on);
    for (const el of article.querySelectorAll<HTMLElement>('.w')) el.classList.toggle('known', on && isActiveWord(el.dataset.l!));
  };
  const lookupAt = (span: HTMLElement) => {
    const p = span.closest<HTMLElement>('[data-p]');
    if (!p) return;
    const pi = Number(p.dataset.p);
    const b = blocks[pi];
    const start = Number(span.dataset.s);
    const sent = splitSentences(b.text).find((s) => start >= s.start && start < s.end);
    const token = span.textContent ?? '';
    const g = quoted(b.kind) ? glossFor(glossary, token) : null;
    showCard(span, token, { a: id, v: c.version, p: pi, s: sent?.text ?? b.text, form: token.toLowerCase(), at: Date.now() }, lookupClassic(token, g));
  };
  article.addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest('.w') as HTMLElement | null;
    if (!span) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    lookupAt(span);
  });
  article.addEventListener('keydown', (e) => {
    const span = (e.target as HTMLElement).closest('.w') as HTMLElement | null;
    if (span && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      lookupAt(span);
    }
  });
  renderBlocks();
  syncTools();
  syncStatus();

  // ---------- progress (same keys as articles: ra:v1:progress[cl-NNN]) ----------
  if (getStatus(id) === 'unread') setProgress(id, { status: 'reading', scroll: 0 }, true);
  const topOf = () => article.getBoundingClientRect().top + window.scrollY;
  const fraction = () => Math.max(0, Math.min(1, (window.scrollY + window.innerHeight - topOf()) / article.offsetHeight));
  const jump = query.get('s');
  const saved = getProgress()[id];
  requestAnimationFrame(() => {
    if (jump != null) jumpToSentence(Number(query.get('p') ?? -1), jump);
    else if (saved && saved.status === 'reading' && saved.scroll > 0.02) window.scrollTo({ top: Math.max(0, topOf() + saved.scroll * article.offsetHeight - window.innerHeight) });
    else window.scrollTo({ top: 0 });
  });
  function jumpToSentence(p: number, sentence: string) {
    let pi = p;
    let start = pi >= 0 ? blocks[pi]?.text.indexOf(sentence) ?? -1 : -1;
    if (start < 0) {
      pi = blocks.findIndex((b) => b.text.includes(sentence));
      start = pi >= 0 ? blocks[pi].text.indexOf(sentence) : -1;
    }
    if (start < 0) {
      toast('原句已被修订，已打开文章顶部。');
      window.scrollTo({ top: 0 });
      return;
    }
    const end = start + sentence.length;
    const spans = [...paras[pi].querySelectorAll<HTMLElement>('.w')].filter((el) => Number(el.dataset.s) >= start && Number(el.dataset.s) < end);
    if (!spans.length) return;
    spans[0].scrollIntoView({ block: 'center' });
    spans.forEach((s) => s.classList.add('flash'));
    setTimeout(() => spans.forEach((s) => s.classList.remove('flash')), 2000);
  }
  let lastSave = 0;
  let timer: number | undefined;
  const saveScroll = () => {
    const f = fraction();
    const s = getStatus(id);
    if (s === 'read' && f < 0.99) return;
    const patch: { scroll: number; status?: 'read' } = { scroll: Math.round(f * 1000) / 1000 };
    if (getSettings().autoMarkRead && f >= 0.99 && s !== 'read') patch.status = 'read';
    setProgress(id, patch, true);
    if (patch.status) syncStatus();
  };
  const onScroll = () => {
    const now = Date.now();
    if (now - lastSave >= 2000) {
      lastSave = now;
      saveScroll();
    } else {
      clearTimeout(timer);
      timer = window.setTimeout(() => { lastSave = Date.now(); saveScroll(); }, 2000 - (now - lastSave));
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  const off = onChange((w) => {
    if (w === 'vocab' || w === 'settings' || w === 'all') syncHighlight();
    if (w === 'settings' || w === 'all') syncTools();
    if (w === 'progress' || w === 'all') syncStatus();
  });
  return () => {
    window.removeEventListener('scroll', onScroll);
    clearTimeout(timer);
    saveScroll();
    off();
    closeCard();
    fab.remove();
    drawer.remove();
  };
}
