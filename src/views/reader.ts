import { clear, h, toast, topicLabel } from '../dom.ts';
import { ensureDict, loadArticle, loadIndex, lookup } from '../data.ts';
import { closeCard, showCard } from '../popup.ts';
import { splitSentences, tokenize } from '../shared/text.ts';
import type { Article } from '../shared/types.ts';
import { getProgress, getSettings, getStatus, isActiveWord, minutesOf, onChange, setProgress, setSettings } from '../store.ts';

export async function mountReader(root: HTMLElement, id: string, query: URLSearchParams): Promise<() => void> {
  root.append(h('p', { class: 'muted' }, '加载中…'));
  let article: Article;
  try {
    article = await loadArticle(id);
  } catch {
    clear(root);
    root.append(h('div', { class: 'empty' }, h('p', null, '找不到这篇文章。'), h('a', { class: 'btn', href: '#/' }, '返回文章列表')));
    return () => {};
  }
  const index = await loadIndex();
  await ensureDict(article.level);
  clear(root);

  const siblings = index.articles.filter((a) => a.level === article.level);
  const pos = siblings.findIndex((a) => a.id === id);
  const prev = siblings[pos - 1];
  const next = siblings[pos + 1];

  // ---------- header ----------
  const statusBtn = h('button', { class: 'btn small', type: 'button', id: 'art-status' });
  const syncStatus = () => {
    const st = getStatus(id);
    statusBtn.textContent = st === 'read' ? '✓ 已读（点击改回未读）' : '标记为已读';
    statusBtn.classList.toggle('done', st === 'read');
  };
  statusBtn.addEventListener('click', () => {
    if (getStatus(id) === 'read') setProgress(id, { status: 'unread', scroll: 0 });
    else setProgress(id, { status: 'read', scroll: 1 });
  });

  const fsDown = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '减小字号', onclick: () => setSettings({ fontSize: Math.max(0, getSettings().fontSize - 1) }) }, 'A−');
  const fsUp = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '增大字号', onclick: () => setSettings({ fontSize: Math.min(3, getSettings().fontSize + 1) }) }, 'A+');
  const themeBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': '切换主题', onclick: () => { const order = ['light', 'dark', 'system'] as const; const cur = getSettings().theme; setSettings({ theme: order[(order.indexOf(cur) + 1) % 3] }); } });
  const FS_NAMES = ['小', '中', '大', '特大'];
  const syncTools = () => {
    const s = getSettings();
    fsDown.disabled = s.fontSize <= 0;
    fsUp.disabled = s.fontSize >= 3;
    fsDown.title = fsUp.title = `字号：${FS_NAMES[s.fontSize]}`;
    themeBtn.textContent = s.theme === 'light' ? '☀️' : s.theme === 'dark' ? '🌙' : '🌓';
    themeBtn.title = `主题：${s.theme === 'light' ? '浅色' : s.theme === 'dark' ? '深色' : '跟随系统'}`;
  };

  const body = h('div', { class: 'article-body', lang: 'en' });
  const head = h('header', { class: 'article-head' },
    h('a', { class: 'backlink', href: '#/' }, '← 文章列表'),
    h('h1', { class: 'article-title' }, article.title),
    h('div', { class: 'article-meta muted' },
      h('span', { class: `badge lv lv-${article.level}` }, article.level),
      `${article.wordCount} 词 · 约 ${minutesOf(article.wordCount)} 分钟`,
      article.topics.map((t) => h('span', { class: 'chip' }, topicLabel(t)))),
    h('div', { class: 'article-tools' }, fsDown, fsUp, themeBtn, statusBtn),
  );

  const nav = h('nav', { class: 'article-nav' },
    prev ? h('a', { class: 'btn', href: `#/read/${prev.id}`, rel: 'prev' }, `← ${prev.title}`) : h('span', { class: 'btn disabled', 'aria-disabled': 'true' }, '← 上一篇'),
    next ? h('a', { class: 'btn', href: `#/read/${next.id}`, rel: 'next' }, `${next.title} →`) : h('span', { class: 'btn disabled', 'aria-disabled': 'true' }, '下一篇 →'),
  );
  const endMarker = h('div', { class: 'end-marker', 'aria-hidden': 'true' });
  const statusBtn2 = h('button', { class: 'btn', type: 'button', onclick: () => statusBtn.click() });
  root.append(h('article', { class: 'reader' }, head, body, endMarker, h('div', { class: 'article-foot' }, statusBtn2), nav,
    article.meta.source === 'ai-generated' ? h('p', { class: 'article-note muted small' }, '本文为 AI 生成的示例文章。') : null));

  // ---------- body with clickable words ----------
  const renderBody = () => {
    clear(body);
    article.paragraphs.forEach((text, pi) => {
      const p = h('p', { dataset: { p: String(pi) } });
      let cursor = 0;
      for (const t of tokenize(text)) {
        if (t.start > cursor) p.append(text.slice(cursor, t.start));
        const r = lookup(t.text);
        const span = h('span', { class: 'w', tabindex: '0', dataset: { s: String(t.start), l: r.lemma } }, t.text);
        p.append(span);
        cursor = t.end;
      }
      if (cursor < text.length) p.append(text.slice(cursor));
      body.append(p);
    });
    syncHighlight();
  };
  const syncHighlight = () => {
    const on = getSettings().highlightKnown;
    body.classList.toggle('hl-known', on);
    for (const el of body.querySelectorAll<HTMLElement>('.w')) el.classList.toggle('known', on && isActiveWord(el.dataset.l!));
  };

  const lookupAt = (span: HTMLElement) => {
    const p = span.closest('p')!;
    const pi = Number(p.dataset.p);
    const start = Number(span.dataset.s);
    const text = article.paragraphs[pi];
    const sent = splitSentences(text).find((s) => start >= s.start && start < s.end);
    const token = span.textContent ?? '';
    const lm = lookup(token);
    showCard(span, token, { a: article.id, v: article.version, p: pi, s: sent?.text ?? text, form: token.toLowerCase(), at: Date.now() }, lm);
  };
  body.addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest('.w') as HTMLElement | null;
    if (!span) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return; // user is selecting text
    lookupAt(span);
  });
  body.addEventListener('keydown', (e) => {
    const span = (e.target as HTMLElement).closest('.w') as HTMLElement | null;
    if (span && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      lookupAt(span);
    }
  });

  renderBody();
  syncTools();
  syncStatus();
  statusBtn2.textContent = statusBtn.textContent;

  // ---------- progress ----------
  if (getStatus(id) === 'unread') setProgress(id, { status: 'reading', scroll: 0 }, true);
  const bodyTop = () => body.getBoundingClientRect().top + window.scrollY;
  const fraction = () => {
    const top = bodyTop();
    const hgt = body.offsetHeight;
    return Math.max(0, Math.min(1, (window.scrollY + window.innerHeight - top) / hgt));
  };

  const jump = query.get('s');
  const saved = getProgress()[id];
  requestAnimationFrame(() => {
    if (jump != null) {
      jumpToSentence(Number(query.get('p') ?? -1), jump);
    } else if (saved && saved.status === 'reading' && saved.scroll > 0.02) {
      window.scrollTo({ top: Math.max(0, bodyTop() + saved.scroll * body.offsetHeight - window.innerHeight) });
    } else {
      window.scrollTo({ top: 0 });
    }
  });

  function jumpToSentence(p: number, sentence: string) {
    let pi = p;
    let start = pi >= 0 ? article.paragraphs[pi]?.indexOf(sentence) ?? -1 : -1;
    if (start < 0) {
      for (let i = 0; i < article.paragraphs.length; i++) {
        const k = article.paragraphs[i].indexOf(sentence);
        if (k >= 0) {
          pi = i;
          start = k;
          break;
        }
      }
    }
    if (start < 0) {
      toast('原句已被修订，已打开文章顶部。');
      window.scrollTo({ top: 0 });
      return;
    }
    const end = start + sentence.length;
    const spans = [...(body.children[pi]?.querySelectorAll<HTMLElement>('.w') ?? [])].filter((el) => Number(el.dataset.s) >= start && Number(el.dataset.s) < end);
    if (!spans.length) return;
    spans[0].scrollIntoView({ block: 'center' });
    spans.forEach((s) => s.classList.add('flash'));
    setTimeout(() => spans.forEach((s) => s.classList.remove('flash')), 2000);
  }

  let lastSave = 0;
  let timer: number | undefined;
  const saveScroll = () => {
    const f = fraction();
    const st = getStatus(id);
    if (st === 'read' && f < 0.99) return; // do not downgrade a finished article just by scrolling up
    const patch: { scroll: number; status?: 'read' } = { scroll: Math.round(f * 1000) / 1000 };
    if (getSettings().autoMarkRead && f >= 0.99 && st !== 'read') patch.status = 'read';
    setProgress(id, patch, true);
    if (patch.status) {
      syncStatus();
      statusBtn2.textContent = statusBtn.textContent;
    }
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
    if (w === 'progress' || w === 'all') {
      syncStatus();
      statusBtn2.textContent = statusBtn.textContent;
    }
  });

  return () => {
    window.removeEventListener('scroll', onScroll);
    clearTimeout(timer);
    saveScroll();
    off();
    closeCard();
  };
}
