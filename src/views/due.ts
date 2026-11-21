// 「今日待复习 N 个」 link shown on the home page (article list) and the vocab page.
import { h } from '../dom.ts';
import { getDue, getVocab } from '../store.ts';

export function renderDueBanner(el: HTMLElement): HTMLElement {
  const d = getDue();
  const active = Object.values(getVocab()).some((it) => !it.mastered);
  el.hidden = !active;
  el.className = 'due-banner' + (d.total ? '' : ' none');
  el.setAttribute('href', '#/review');
  el.dataset.n = String(d.total);
  el.replaceChildren(
    h('span', { class: 'due-icon', 'aria-hidden': 'true' }, '🗂'),
    h('span', { class: 'due-main' }, h('strong', { class: 'due-text' }, `今日待复习 ${d.total} 个`),
      h('span', { class: 'muted small due-sub' }, d.total ? `到期 ${d.review.length} · 新词 ${d.fresh.length}` : '今天的复习已全部完成 ✓')),
    h('span', { class: 'due-go' }, d.total ? '开始复习 →' : '查看 →'));
  return el;
}
