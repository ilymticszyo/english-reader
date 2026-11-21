// #/review — flashcard review of the vocab book with spaced repetition (simplified SM-2, see shared/review.ts).
// Filters (URL query, AND-combined): pool = B1 | B2 | C1 | classics (a saved sentence comes from there),
// cefr = A1…C2 | '-' (the word's own dictionary level), a = one article / classic id.
import { clear, h, toast } from '../dom.ts';
import { ensureClassicsDict, ensureDict, getEntry, loadClassicsIndex, loadIndex } from '../data.ts';
import { GRADES, POOLS, fmtInterval, matchesFilter, nextInterval, poolOf } from '../shared/review.ts';
import type { Grade, ReviewFilter } from '../shared/review.ts';
import { getDue, getReview, getVocab, gradeWord, onChange, setMastered } from '../store.ts';
import type { VocabCtx } from '../store.ts';
import { speak, ttsSupported } from '../tts.ts';

const POOL_LABEL: Record<string, string> = { B1: 'B1 文章', B2: 'B2 文章', C1: 'C1 文章', classics: '名著' };
const CEFRS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** the sentence with every occurrence of the saved form (or the lemma) marked */
function markedSentence(s: string, forms: string[]): (string | HTMLElement)[] {
  const fs = [...new Set(forms.filter(Boolean).map((f) => f.toLowerCase()))].sort((a, b) => b.length - a.length);
  if (!fs.length) return [s];
  const esc = fs.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[^A-Za-z])(${esc.join('|')})(?=[^A-Za-z]|$)`, 'gi');
  const out: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index! + m[1].length;
    out.push(s.slice(last, start), h('mark', null, m[2]));
    last = start + m[2].length;
  }
  out.push(s.slice(last));
  return out;
}
export const ctxHref = (c: VocabCtx) => `#/${c.a.startsWith('cl-') ? 'classics' : 'read'}/${c.a}?p=${c.p}&s=${encodeURIComponent(c.s)}`;

export async function mountReview(root: HTMLElement, query: URLSearchParams): Promise<() => void> {
  const f: ReviewFilter = { pool: query.get('pool') ?? '', cefr: query.get('cefr') ?? '', article: query.get('a') ?? '' };
  if (f.pool && !(POOLS as readonly string[]).includes(f.pool)) f.pool = '';
  // titles for the source links / article filter (offline: precached; failure only loses the titles)
  const titles = new Map<string, string>();
  const [idx, cl] = await Promise.all([loadIndex().catch(() => null), loadClassicsIndex().catch(() => null)]);
  idx?.articles.forEach((a) => titles.set(a.id, a.title));
  cl?.excerpts.forEach((c) => titles.set(c.id, `${c.work} · ${c.title}`));

  const summary = h('p', { class: 'muted', id: 'rv-summary' });
  const poolSel = h('select', { id: 'rv-pool', 'aria-label': '按来源筛选' }, h('option', { value: '' }, '全部来源'), ...POOLS.map((p) => h('option', { value: p }, POOL_LABEL[p])));
  const cefrSel = h('select', { id: 'rv-cefr', 'aria-label': '按词汇等级筛选' }, h('option', { value: '' }, '全部词汇等级'), ...CEFRS.map((c) => h('option', { value: c }, `词汇 ${c}`)), h('option', { value: '-' }, '无等级'));
  const artSel = h('select', { id: 'rv-article', 'aria-label': '按文章筛选' });
  const stage = h('section', { class: 'rv-stage', id: 'rv-stage', 'aria-live': 'polite' });
  root.append(
    h('div', { class: 'rv-head' }, h('h1', null, '复习生词'), h('a', { class: 'linkbtn', href: '#/words' }, '← 生词本')),
    summary,
    h('div', { class: 'filters rv-filters' }, poolSel, cefrSel, artSel),
    stage,
    h('p', { class: 'muted small rv-help' }, '快捷键：空格 翻面，1 忘了 · 2 模糊 · 3 记得 · 4 简单。间隔按简化版 SM-2 安排：答得越好，下次出现越晚；“忘了”会在本轮稍后再出现一次。'),
  );

  let queue: string[] = [];
  let flipped = false;
  const tally = [0, 0, 0, 0];
  let reviewed = 0;
  let dictReady = false;

  const fillArticles = () => {
    const ids = new Set<string>();
    for (const it of Object.values(getVocab())) if (!it.mastered) for (const c of it.ctx) if (!f.pool || poolOf(c.a) === f.pool) ids.add(c.a);
    const sorted = [...ids].sort();
    if (f.article && !ids.has(f.article)) sorted.unshift(f.article);
    artSel.replaceChildren(h('option', { value: '' }, '全部文章'), ...sorted.map((id) => h('option', { value: id }, `${id} ${titles.get(id) ?? ''}`.trim())));
    poolSel.value = f.pool ?? '';
    cefrSel.value = f.cefr ?? '';
    artSel.value = f.article ?? '';
  };

  const syncUrl = () => {
    const q = new URLSearchParams();
    if (f.pool) q.set('pool', f.pool);
    if (f.cefr) q.set('cefr', f.cefr);
    if (f.article) q.set('a', f.article);
    const hash = '#/review' + (q.toString() ? '?' + q : '');
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };

  const renderSummary = () => {
    const all = getDue();
    const cur = getDue(f);
    const filtered = !!(f.pool || f.cefr || f.article);
    summary.textContent = `今日待复习 ${all.total} 个（到期 ${all.review.length} · 新词 ${all.fresh.length}）` + (filtered ? `；当前筛选下 ${cur.total} 个` : '') + (reviewed ? `；本轮已复习 ${reviewed} 次` : '');
  };

  const start = () => {
    const d = getDue(f);
    queue = [...d.review, ...d.fresh];
    flipped = false;
    // classics-only words need the classics dictionary for their definitions
    const needCl = queue.some((w) => getVocab()[w]?.ctx.some((c) => c.a.startsWith('cl-')));
    void (needCl ? ensureClassicsDict() : ensureDict('C1')).then(() => { dictReady = true; if (flipped) renderCard(); }).catch(() => {});
    renderCard();
  };

  const renderDone = () => {
    const vocab = getVocab();
    const active = Object.values(vocab).filter((it) => !it.mastered);
    const d = getDue(f);
    const filtered = !!(f.pool || f.cefr || f.article);
    const box = h('div', { class: 'rv-done', id: 'rv-done' });
    if (!active.length) {
      box.append(h('p', null, Object.keys(vocab).length ? '生词本里的词都已标记为掌握，没有要复习的词。' : '生词本还是空的。读文章时点一下不认识的词，它会收进生词本，之后就能在这里复习。'), h('a', { class: 'btn', href: '#/' }, '去读文章'));
    } else if (filtered && !active.some((it) => matchesFilter(it, f))) {
      box.append(h('p', null, '当前筛选下没有生词。'), h('button', { class: 'btn', type: 'button', id: 'rv-clear', onclick: () => { f.pool = f.cefr = f.article = ''; changed(); } }, '清除筛选'));
    } else {
      box.append(h('p', { class: 'rv-done-title' }, reviewed ? '🎉 本轮复习完成' : '✓ 今天没有待复习的词'));
      if (reviewed) box.append(h('p', { class: 'muted', id: 'rv-tally' }, `共复习 ${reviewed} 次：` + GRADES.map((g) => `${g.label} ${tally[g.g]}`).join(' · ')));
      if (d.freshLeft) box.append(h('p', { class: 'muted small' }, `还有 ${d.freshLeft} 个新词留到之后几天（每天最多引入 20 个新词，到期的复习不受限制）。`));
      const next = Object.entries(getReview()).filter(([w]) => vocab[w] && !vocab[w].mastered && matchesFilter(vocab[w], f)).map(([, r]) => r.due).sort()[0];
      if (next) box.append(h('p', { class: 'muted small', id: 'rv-next' }, `下一次复习：${next}`));
      box.append(h('a', { class: 'btn', href: '#/words' }, '回到生词本'));
    }
    stage.replaceChildren(box);
    stage.classList.remove('has-grades');
    renderSummary();
  };

  function renderCard() {
    renderSummary();
    const vocab = getVocab();
    while (queue.length && (!vocab[queue[0]] || vocab[queue[0]].mastered)) queue.shift();
    if (!queue.length) return renderDone();
    const w = queue[0];
    const it = vocab[w];
    const rec = getReview()[w];
    const front = h('div', { class: 'rv-front' },
      h('div', { class: 'rv-tags' },
        h('span', { class: 'badge ' + (rec ? 'rv-due' : 'rv-new') }, rec ? (rec.lapses ? `复习 · 忘过 ${rec.lapses} 次` : '复习') : '新词'),
        it.snap.cefr ? h('span', { class: 'badge cefr' }, it.snap.cefr) : null),
      h('div', { class: 'rv-word-row' },
        h('strong', { class: 'rv-word', lang: 'en' }, w),
        ttsSupported ? h('button', { class: 'iconbtn speak rv-speak', type: 'button', 'aria-label': `朗读 ${w}`, onclick: () => speak(w) }, '🔊') : null),
      ttsSupported ? null : h('div', { class: 'muted small rv-notts' }, '当前浏览器不支持朗读'));
    const card = h('article', { class: 'rv-card' + (flipped ? ' flipped' : ''), dataset: { word: w, side: flipped ? 'back' : 'front' }, 'aria-label': `单词卡 ${w}` }, front);
    const actions = h('div', { class: 'rv-actions' });
    if (!flipped) {
      actions.append(h('button', { class: 'btn primary rv-flip', type: 'button', id: 'rv-flip', onclick: flip }, '显示答案', h('kbd', null, '空格')));
    } else {
      const entry = getEntry(w);
      const p = entry?.p || it.snap.p;
      const defs = entry && entry.d.length ? entry.d.slice(0, 5).map((d) => h('li', null, d.pos ? h('span', { class: 'pos' }, d.pos) : null, ` ${d.zh}`)) : [h('li', null, it.snap.zh || (dictReady ? '（词典未收录）' : '词典加载中…'))];
      const ctxs = [...it.ctx];
      const main = ctxs[0];
      const ctxBox = h('div', { class: 'rv-ctx' });
      if (main) {
        ctxBox.append(
          h('blockquote', { class: 'rv-sentence', lang: 'en' }, ...markedSentence(main.s, [main.form, w])),
          h('a', { class: 'rv-source', href: ctxHref(main), title: '回到原文' }, `出自：${titles.get(main.a) ?? main.a}`));
        if (ctxs.length > 1) {
          const more = h('details', { class: 'rv-more' }, h('summary', null, `其他例句（${ctxs.length - 1}）`),
            ...ctxs.slice(1).map((c) => h('div', { class: 'rv-more-item' }, h('span', { lang: 'en' }, ...markedSentence(c.s, [c.form, w])), ' ', h('a', { class: 'small', href: ctxHref(c) }, `— ${titles.get(c.a) ?? c.a}`))));
          ctxBox.append(more);
        }
      } else ctxBox.append(h('div', { class: 'muted small' }, '没有保存原文例句（这个词是从词典卡片直接加入的）'));
      card.append(h('div', { class: 'rv-back' },
        p ? h('div', { class: 'phon' }, `/${p}/`) : null,
        h('ul', { class: 'rv-defs' }, ...defs),
        ctxBox,
        h('button', { class: 'linkbtn small rv-master', type: 'button', onclick: () => {
          setMastered(w, true);
          queue = queue.filter((x) => x !== w);
          flipped = false;
          toast(`已将「${w}」标为已掌握，不再复习`, { label: '撤销', run: () => { setMastered(w, false); queue.unshift(w); renderCard(); } });
          renderCard();
        } }, '已经掌握，不再复习')));
      for (const g of GRADES) {
        actions.append(h('button', { class: `btn rv-grade g${g.g}`, type: 'button', dataset: { g: String(g.g) }, onclick: () => grade(g.g) },
          h('span', { class: 'rv-g-label' }, g.label), h('span', { class: 'rv-g-iv small' }, g.g === 0 ? '本轮再来' : fmtInterval(nextInterval(rec, g.g))), h('kbd', null, g.key)));
      }
    }
    actions.className = 'rv-actions' + (flipped ? ' grades' : '');
    stage.classList.toggle('has-grades', flipped);
    stage.replaceChildren(card, actions, h('div', { class: 'muted small rv-progress', id: 'rv-progress' }, `本轮剩余 ${new Set(queue).size} 个`));
  }

  function flip() {
    if (flipped || !queue.length) return;
    flipped = true;
    renderCard();
    stage.querySelector<HTMLElement>('.rv-grade.g2')?.focus({ preventScroll: true });
  }
  function grade(g: Grade) {
    if (!flipped || !queue.length) return;
    const w = queue.shift()!;
    gradeWord(w, g);
    tally[g]++;
    reviewed++;
    if (g === 0) queue.push(w); // forgotten: once more later in this session
    flipped = false;
    renderCard();
    stage.querySelector<HTMLElement>('#rv-flip')?.focus({ preventScroll: true });
  }

  const changed = () => { syncUrl(); fillArticles(); start(); };
  poolSel.onchange = () => { f.pool = poolSel.value; if (f.article && poolOf(f.article) !== f.pool && f.pool) f.article = ''; changed(); };
  cefrSel.onchange = () => { f.cefr = cefrSel.value; changed(); };
  artSel.onchange = () => { f.article = artSel.value; changed(); };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-back')) return;
    const t = e.target as HTMLElement;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if ((e.key === ' ' || e.key === 'Enter') && !flipped) {
      // a focused control outside the card keeps its own Space / Enter; inside the card (🔊, 显示答案) the key flips
      if (t && /^(BUTTON|A|SUMMARY)$/.test(t.tagName) && !stage.contains(t)) return;
      e.preventDefault();
      flip();
    } else if (flipped && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      grade((Number(e.key) - 1) as Grade);
    }
  };
  document.addEventListener('keydown', onKey);
  fillArticles();
  syncUrl();
  start();
  const off = onChange((w) => { if (w === 'all') { fillArticles(); start(); } });
  return () => { document.removeEventListener('keydown', onKey); off(); };
}
