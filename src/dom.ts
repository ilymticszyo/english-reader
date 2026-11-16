type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v as object);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && k !== 'list' && k !== 'type') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      append(el, c);
      continue;
    }
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(msg: string, action?: { label: string; run: () => void }, ms = 5000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: 'toast' }, h('span', null, msg));
  const remove = () => t.remove();
  if (action) {
    t.append(
      h('button', { class: 'toast-act', onclick: () => { action.run(); remove(); } }, action.label),
    );
  }
  box.append(t);
  setTimeout(remove, ms);
}

export const TOPIC_LABELS: Record<string, string> = {
  'daily-life': '日常生活',
  travel: '旅行',
  food: '饮食',
  health: '健康',
  education: '教育',
  work: '工作职场',
  technology: '科技',
  environment: '环境',
  science: '科学',
  culture: '文化艺术',
  society: '社会',
  history: '历史',
};
export const topicLabel = (t: string) => `${TOPIC_LABELS[t] ?? t} ${t}`;
