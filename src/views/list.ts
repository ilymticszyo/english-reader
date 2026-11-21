import { clear, h, topicLabel } from '../dom.ts';
import { loadClassicsIndex, loadIndex } from '../data.ts';
import type { ClassicMeta } from '../shared/types.ts';
import { LEVELS } from '../shared/types.ts';
import type { ArticleMeta, Level } from '../shared/types.ts';
import { loadPools, renderHistorySummary } from './history.ts';
import { renderDueBanner } from './due.ts';
import { getProgress, getSettings, getStatus, minutesOf, onChange, setSettings } from '../store.ts';
import type { Status } from '../store.ts';

const STATUS_LABEL: Record<Status, string> = { unread: '未读', reading: '在读', read: '已读' };
const filters = { topic: '', status: '' as '' | Status, q: '', onlyUnread: false };
/** list-card status: a clear ✓ badge once read */
export const statusBadge = (st: Status) => h('span', { class: `status st-${st}` + (st === 'read' ? ' badge-read' : ''), title: st === 'read' ? '已读' : undefined }, st === 'read' ? '✓ 已读' : STATUS_LABEL[st]);

export async function mountList(root: HTMLElement): Promise<() => void> {
  root.append(h('p', { class: 'muted' }, '加载中…'));
  const index = await loadIndex();
  // 继续阅读 may point at a classic too (G8); the list itself stays articles-only
  const classics: ClassicMeta[] = await loadClassicsIndex().then((i) => i.excerpts).catch(() => []);
  clear(root);
  let level: Level = getSettings().lastLevel;
  const all = index.articles;
  const pools = await loadPools();

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const progressLine = h('section', { class: 'history-summary' });
  const cont = h('div', { class: 'continue' });
  const due = h('a', { id: 'due-home', href: '#/review' });
  const controls = h('div', { class: 'filters' });
  const list = h('div', { class: 'cards', role: 'list' });
  root.append(h('h1', { class: 'sr-only' }, '文章列表'), tabs, progressLine, due, cont, controls, list);

  const topicSel = h('select', { 'aria-label': '按话题筛选', onchange: (e: Event) => { filters.topic = (e.target as HTMLSelectElement).value; renderList(); } });
  const statusSel = h('select', { 'aria-label': '按阅读状态筛选', onchange: (e: Event) => { filters.status = (e.target as HTMLSelectElement).value as Status; renderList(); } },
    h('option', { value: '' }, '全部状态'), ...(['unread', 'reading', 'read'] as Status[]).map((s) => h('option', { value: s }, STATUS_LABEL[s])));
  const search = h('input', { type: 'search', placeholder: '搜索标题…', 'aria-label': '标题关键词', value: filters.q, oninput: (e: Event) => { filters.q = (e.target as HTMLInputElement).value; renderList(); } });
  const onlyUnread = h('input', { type: 'checkbox', id: 'only-unread', checked: filters.onlyUnread, onchange: (e: Event) => { filters.onlyUnread = (e.target as HTMLInputElement).checked; renderList(); } });
  controls.append(search, topicSel, statusSel, h('label', { class: 'check', for: 'only-unread' }, onlyUnread, '只看未读'));
  statusSel.value = filters.status;

  const renderTabs = () => {
    clear(tabs);
    for (const lv of LEVELS) {
      const arts = all.filter((a) => a.level === lv);
      const done = arts.filter((a) => getStatus(a.id) === 'read').length;
      tabs.append(
        h('button', { class: 'tab' + (lv === level ? ' active' : ''), role: 'tab', 'aria-selected': String(lv === level), dataset: { level: lv }, onclick: () => { level = lv; setSettings({ lastLevel: lv }); filters.topic = ''; renderAll(); } },
          h('span', { class: 'tab-lv' }, lv), h('span', { class: 'tab-n' }, `${done}/${arts.length}`)),
      );
    }
  };

  const renderTopics = () => {
    const topics = [...new Set(all.filter((a) => a.level === level).flatMap((a) => a.topics))].sort();
    clear(topicSel);
    topicSel.append(h('option', { value: '' }, '全部话题'), ...topics.map((t) => h('option', { value: t }, topicLabel(t))));
    topicSel.value = topics.includes(filters.topic) ? filters.topic : '';
    if (topicSel.value !== filters.topic) filters.topic = '';
  };

  const card = (a: ArticleMeta) => {
    const st = getStatus(a.id);
    return h('a', { class: 'card-item' + (st === 'read' ? ' is-read' : ''), role: 'listitem', href: `#/read/${a.id}`, dataset: { id: a.id } },
      h('div', { class: 'ci-top' }, h('span', { class: `badge lv lv-${a.level}` }, a.level), statusBadge(st)),
      h('h2', { class: 'ci-title' }, a.title),
      h('div', { class: 'ci-meta muted' }, `${a.wordCount} 词 · 约 ${minutesOf(a.wordCount)} 分钟`),
      h('div', { class: 'ci-topics' }, ...a.topics.map((t) => h('span', { class: 'chip' }, topicLabel(t)))),
    );
  };

  const renderContinue = () => {
    clear(cont);
    const prog = getProgress();
    const cur = Object.entries(prog).filter(([, p]) => p.status === 'reading').sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0];
    if (cur && cur[0].startsWith('cl-')) {
      const cm = classics.find((c) => c.id === cur[0]);
      if (!cm) return;
      cont.append(h('a', { class: 'continue-card', href: `#/classics/${cm.id}` },
        h('span', { class: 'continue-label' }, '继续阅读 · 名著'), h('strong', null, `${cm.work} · ${cm.title}`),
        h('span', { class: 'muted' }, `参考 ${cm.refLevel} · 已读 ${Math.round(cur[1].scroll * 100)}%`)));
      return;
    }
    const meta = cur && all.find((a) => a.id === cur[0]);
    if (!meta) return;
    cont.append(h('a', { class: 'continue-card', href: `#/read/${meta.id}` },
      h('span', { class: 'continue-label' }, '继续阅读'), h('strong', null, meta.title),
      h('span', { class: 'muted' }, `${meta.level} · 已读 ${Math.round(cur[1].scroll * 100)}%`)));
  };

  const renderList = () => {
    clear(list);
    const q = filters.q.trim().toLowerCase();
    const items = all.filter((a) => a.level === level && (!filters.topic || a.topics.includes(filters.topic)) && (!filters.status || getStatus(a.id) === filters.status) && (!filters.onlyUnread || getStatus(a.id) !== 'read') && (!q || a.title.toLowerCase().includes(q)));
    if (!items.length) {
      list.append(h('div', { class: 'empty' }, h('p', null, '没有符合条件的文章。'),
        h('button', { class: 'btn', type: 'button', onclick: () => { filters.topic = ''; filters.status = ''; filters.q = ''; filters.onlyUnread = false; search.value = ''; statusSel.value = ''; onlyUnread.checked = false; renderAll(); } }, '清除筛选')));
      return;
    }
    for (const a of items) list.append(card(a));
  };

  const renderAll = () => {
    renderTabs();
    renderHistorySummary(progressLine, pools, level);
    renderContinue();
    renderDueBanner(due);
    renderTopics();
    renderList();
  };
  renderAll();
  return onChange((w) => (w === 'progress' || w === 'settings' || w === 'all' ? renderAll() : (w === 'vocab' || w === 'review') && renderDueBanner(due)));
}
