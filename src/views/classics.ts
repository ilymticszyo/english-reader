import { clear, h } from '../dom.ts';
import { loadClassicsIndex } from '../data.ts';
import { LEVELS, LEVEL_RANK } from '../shared/types.ts';
import type { ClassicMeta, Level } from '../shared/types.ts';
import { statusBadge } from './list.ts';
import { loadPools, renderHistorySummary } from './history.ts';
import { getProgress, getStatus, minutesOf, onChange } from '../store.ts';

type Sort = 'order' | 'level' | 'short';
/** Shared with the classic reader so prev / next walk the same filtered list (G8). Kept for the session. */
export const classicFilters = { level: '' as '' | Level, author: '', q: '', sort: 'order' as Sort, onlyUnread: false };

export function filterClassics(all: ClassicMeta[]): ClassicMeta[] {
  const q = classicFilters.q.trim().toLowerCase();
  const items = all.filter((c) =>
    (!classicFilters.level || c.refLevel === classicFilters.level) &&
    (!classicFilters.author || c.authorId === classicFilters.author) &&
    (!classicFilters.onlyUnread || getStatus(c.id) !== 'read') &&
    (!q || [c.work, c.scene, c.title, c.author, c.chapter].some((s) => s.toLowerCase().includes(q))));
  if (classicFilters.sort === 'level') items.sort((a, b) => LEVEL_RANK[a.refLevel] - LEVEL_RANK[b.refLevel] || a.id.localeCompare(b.id));
  else if (classicFilters.sort === 'short') items.sort((a, b) => a.wordCount - b.wordCount || a.id.localeCompare(b.id));
  return items;
}

export async function mountClassics(root: HTMLElement): Promise<() => void> {
  root.append(h('p', { class: 'muted' }, '加载中…'));
  const index = await loadClassicsIndex();
  clear(root);
  const all = index.excerpts;
  const pools = await loadPools();

  const authors = [...new Map(all.map((c) => [c.authorId, c.author])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const levelSel = h('select', { 'aria-label': '按参考难度筛选', id: 'cl-level', onchange: (e: Event) => { classicFilters.level = (e.target as HTMLSelectElement).value as Level; renderList(); } },
    h('option', { value: '' }, '全部难度'), ...LEVELS.map((l) => h('option', { value: l }, `参考 ${l}`)));
  const authorSel = h('select', { 'aria-label': '按作者筛选', id: 'cl-author', onchange: (e: Event) => { classicFilters.author = (e.target as HTMLSelectElement).value; renderList(); } },
    h('option', { value: '' }, '全部作者'), ...authors.map(([id, name]) => h('option', { value: id }, name)));
  const sortSel = h('select', { 'aria-label': '排序', id: 'cl-sort', onchange: (e: Event) => { classicFilters.sort = (e.target as HTMLSelectElement).value as Sort; renderList(); } },
    h('option', { value: 'order' }, '默认顺序'), h('option', { value: 'level' }, '难度由低到高'), h('option', { value: 'short' }, '篇幅由短到长'));
  const search = h('input', { type: 'search', id: 'cl-q', placeholder: '搜索作品、场景或标题…', 'aria-label': '搜索作品或场景', value: classicFilters.q, oninput: (e: Event) => { classicFilters.q = (e.target as HTMLInputElement).value; renderList(); } });
  levelSel.value = classicFilters.level;
  authorSel.value = classicFilters.author;
  sortSel.value = classicFilters.sort;

  const progressLine = h('section', { class: 'history-summary' });
  const onlyUnread = h('input', { type: 'checkbox', id: 'cl-only-unread', checked: classicFilters.onlyUnread, onchange: (e: Event) => { classicFilters.onlyUnread = (e.target as HTMLInputElement).checked; renderList(); } });
  const cont = h('div', { class: 'continue' });
  const count = h('div', { class: 'muted small cl-count', 'aria-live': 'polite' });
  const list = h('div', { class: 'cards', role: 'list' });
  root.append(
    h('h1', null, '名著赏析'),
    h('p', { class: 'muted cl-intro' }, '公版经典名著选段（Project Gutenberg），每篇含英文导读、原文与赏析。难度为参考值，不计入 B1 / B2 / C1 分级。'),
    progressLine, cont,
    h('div', { class: 'filters' }, search, levelSel, authorSel, sortSel, h('label', { class: 'check', for: 'cl-only-unread' }, onlyUnread, '只看未读')),
    count, list);

  const card = (c: ClassicMeta) => {
    const st = getStatus(c.id);
    return h('a', { class: 'card-item classic-card' + (st === 'read' ? ' is-read' : ''), role: 'listitem', href: `#/classics/${c.id}`, dataset: { id: c.id } },
      h('div', { class: 'ci-top' },
        h('span', { class: `badge lv lv-${c.refLevel}`, title: '参考难度' }, `参考 ${c.refLevel}`),
        c.spoiler ? h('span', { class: 'badge spoiler', title: '含剧透：选段涉及结局或关键反转' }, '⚠ 剧透') : null,
        statusBadge(st)),
      h('div', { class: 'ci-work' }, h('cite', null, c.work), h('span', { class: 'muted' }, ` · ${c.author}`)),
      h('h2', { class: 'ci-title', lang: 'en' }, c.title),
      h('div', { class: 'ci-scene muted small', lang: 'en' }, `${c.chapter} — ${c.scene}`),
      h('div', { class: 'ci-meta muted' }, `原文 ${c.wordCount} 词 · 约 ${minutesOf(c.totalWords)} 分钟`),
    );
  };

  const renderContinue = () => {
    clear(cont);
    const cur = Object.entries(getProgress()).filter(([id, p]) => id.startsWith('cl-') && p.status === 'reading').sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0];
    const meta = cur && all.find((c) => c.id === cur[0]);
    if (!meta) return;
    cont.append(h('a', { class: 'continue-card', href: `#/classics/${meta.id}` },
      h('span', { class: 'continue-label' }, '继续阅读'), h('strong', null, `${meta.work} · ${meta.title}`),
      h('span', { class: 'muted' }, `参考 ${meta.refLevel} · 已读 ${Math.round(cur[1].scroll * 100)}%`)));
  };

  const renderList = () => {
    clear(list);
    const items = filterClassics(all);
    count.textContent = `共 ${items.length} 篇`;
    if (!items.length) {
      list.append(h('div', { class: 'empty' }, h('p', null, '没有符合条件的名著选段。'),
        h('button', { class: 'btn', type: 'button', id: 'cl-clear', onclick: () => {
          Object.assign(classicFilters, { level: '', author: '', q: '', onlyUnread: false });
          onlyUnread.checked = false;
          search.value = '';
          levelSel.value = '';
          authorSel.value = '';
          renderList();
        } }, '清除筛选')));
      return;
    }
    for (const c of items) list.append(card(c));
  };

  const renderAll = () => {
    renderHistorySummary(progressLine, pools, 'classics');
    renderContinue();
    renderList();
  };
  renderAll();
  return onChange((w) => (w === 'progress' || w === 'settings' || w === 'all') && renderAll());
}
