// 阅读记录: one progress line each for B1, B2, C1 and 名著 (read / total), shared by the list, classics and settings pages.
import { h } from '../dom.ts';
import { loadClassicsIndex, loadIndex } from '../data.ts';
import { readCounts } from '../shared/history.ts';
import { LEVELS } from '../shared/types.ts';
import { getProgress } from '../store.ts';

export type Pools = Record<string, string[]>;
export const POOL_LABEL: Record<string, string> = { B1: 'B1', B2: 'B2', C1: 'C1', classics: '名著' };

export async function loadPools(): Promise<Pools> {
  const [idx, cl] = await Promise.all([loadIndex(), loadClassicsIndex().catch(() => ({ excerpts: [] as { id: string }[] }))]);
  const pools: Pools = {};
  for (const lv of LEVELS) pools[lv] = idx.articles.filter((a) => a.level === lv).map((a) => a.id);
  pools.classics = cl.excerpts.map((c) => c.id);
  return pools;
}

/** Renders (or re-renders into `el`) the four progress lines. `current` highlights the pool being browsed. */
export function renderHistorySummary(el: HTMLElement, pools: Pools, current = '') {
  const counts = readCounts(getProgress(), pools);
  el.className = 'history-summary';
  el.setAttribute('aria-label', '阅读记录');
  el.replaceChildren(...Object.entries(counts).map(([k, c]) => {
    const pct = c.total ? Math.round((c.read / c.total) * 100) : 0;
    return h('div', { class: 'hs-row' + (k === current ? ' current' : ''), dataset: { k } },
      h('span', { class: 'hs-k' }, POOL_LABEL[k] ?? k),
      h('span', { class: 'hs-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(c.total), 'aria-valuenow': String(c.read), 'aria-label': `${POOL_LABEL[k] ?? k} 已读` },
        h('span', { class: 'hs-fill', dataset: { pct: String(pct) } })),
      h('span', { class: 'hs-n' }, `已读 ${c.read} / ${c.total}`));
  }));
  el.querySelectorAll<HTMLElement>('.hs-fill').forEach((f) => (f.style.width = `${f.dataset.pct}%`));
  return el;
}
