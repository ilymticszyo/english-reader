import { clear, h } from './dom.ts';
import { lookup } from './data.ts';
import type { LookupResult } from './data.ts';
import { FORM_LABELS } from './shared/text.ts';
import type { DictEntry } from './shared/types.ts';
import { addWord, getSettings, hasWord, onChange, recordLookup, removeWord, restoreWord } from './store.ts';
import type { VocabCtx, VocabItem } from './store.ts';
import { speak, ttsSupported } from './tts.ts';
import { toast } from './dom.ts';

const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: 'CET4',
  cet6: 'CET6',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
};

const DEFAULT_DEFS = 5;
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

export function snapshotOf(entry?: DictEntry): VocabItem['snap'] {
  if (!entry) return {};
  const zh = entry.d
    .slice(0, 3)
    .map((d) => (d.pos ? `${d.pos} ${d.zh}` : d.zh))
    .join('  ');
  return { p: entry.p, zh, cefr: entry.cefr };
}

function formLabel(lemmaEntry: DictEntry | undefined, key: string): string {
  const labels: string[] = [];
  for (const [k, v] of Object.entries(lemmaEntry?.ex ?? {})) {
    if (v.toLowerCase() === key.toLowerCase() && FORM_LABELS[k]) labels.push(FORM_LABELS[k]);
  }
  return labels.length ? labels.join(' / ') : '词形变化';
}

let current: { el: HTMLElement; anchor: HTMLElement | null; cleanup: () => void } | null = null;

export function closeCard(restoreFocus = false) {
  if (!current) return;
  const { el, anchor, cleanup } = current;
  current = null;
  cleanup();
  el.remove();
  document.body.style.paddingBottom = '';
  if (restoreFocus) anchor?.focus({ preventScroll: true });
}
export const isCardOpen = () => !!current;

function defsBlock(entry: DictEntry): HTMLElement {
  const wrap = h('div', { class: 'card-defs' });
  const render = (all: boolean) => {
    clear(wrap);
    const shown = all ? entry.d : entry.d.slice(0, DEFAULT_DEFS);
    for (const d of shown) {
      wrap.append(h('div', { class: 'def' }, d.pos ? h('span', { class: 'pos' }, d.pos) : null, h('span', { class: 'zh' }, d.zh)));
    }
    if (entry.d.length > DEFAULT_DEFS) {
      wrap.append(
        h('button', { class: 'linkbtn', type: 'button', onclick: () => render(!all) }, all ? '收起' : `更多释义（还有 ${entry.d.length - DEFAULT_DEFS} 条）`),
      );
    }
  };
  render(false);
  return wrap;
}

function metaRow(entry: DictEntry): HTMLElement | null {
  const bits: (Node | null)[] = [];
  if (entry.cefr) bits.push(h('span', { class: 'badge cefr', title: 'CEFR 等级（CEFR-J）' }, entry.cefr));
  for (const t of entry.tags ?? []) bits.push(h('span', { class: 'badge tag' }, TAG_LABELS[t] ?? t));
  if (entry.col) bits.push(h('span', { class: 'badge', title: '柯林斯星级' }, '★'.repeat(entry.col)));
  const real = bits.filter(Boolean);
  return real.length ? h('div', { class: 'card-meta' }, ...real) : null;
}

function formsRow(entry: DictEntry): HTMLElement | null {
  const ex = entry.ex;
  if (!ex) return null;
  const parts = Object.entries(ex)
    .filter(([k]) => FORM_LABELS[k])
    .map(([k, v]) => `${FORM_LABELS[k]} ${v}`);
  if (!parts.length) return null;
  return h('div', { class: 'card-forms' }, h('span', { class: 'lbl' }, '词形变化'), parts.join('；'));
}

function entryBody(entry: DictEntry): HTMLElement[] {
  const out: HTMLElement[] = [];
  const meta = metaRow(entry);
  if (meta) out.push(meta);
  out.push(defsBlock(entry));
  const f = formsRow(entry);
  if (f) out.push(f);
  return out;
}

export function showCard(anchor: HTMLElement, token: string, ctx: VocabCtx | null, result?: LookupResult, record = true) {
  closeCard();
  const r = result ?? lookup(token);
  const { entry, formEntry, res } = r;
  const lemma = r.lemma;
  const settings = getSettings();

  // collect on lookup
  if (record) recordLookup(lemma, snapshotOf(entry), ctx, settings.autoCollect);

  const showForm = !!res && res.key !== res.lemma;
  const card = h('div', { class: 'card', role: 'dialog', 'aria-label': `词典：${lemma}`, tabindex: '-1' });
  const handle = h('div', { class: 'card-handle', 'aria-hidden': 'true' });

  const title = h('h3', { class: 'card-title' });
  if (showForm) {
    title.append(
      h('span', { class: 'card-form' }, token),
      h('span', { class: 'card-arrow' }, ' ← '),
      h('span', { class: 'card-lemma' }, lemma),
      h('span', { class: 'card-formtype' }, `（${res!.via === 'fallback' ? '词形推测' : formLabel(entry, res!.key)}）`),
    );
  } else {
    title.append(h('span', { class: 'card-lemma' }, entry?.proper ? token : lemma));
  }

  const star = h('button', { class: 'iconbtn star', type: 'button', 'aria-label': '加入/移出生词本', 'aria-pressed': 'false' });
  const syncStar = () => {
    const on = hasWord(lemma);
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', String(on));
    star.title = on ? '已在生词本，点击移出' : '加入生词本';
    star.classList.toggle('on', on);
  };
  syncStar();
  star.addEventListener('click', () => {
    if (hasWord(lemma)) {
      const it = removeWord(lemma);
      toast(`已从生词本移出「${lemma}」`, it ? { label: '撤销', run: () => restoreWord(lemma, it) } : undefined);
    } else {
      addWord(lemma, snapshotOf(entry), ctx);
    }
  });
  const offChange = onChange((w) => (w === 'vocab' || w === 'all') && syncStar());

  const speaker = ttsSupported
    ? h('button', { class: 'iconbtn speak', type: 'button', 'aria-label': '发音', title: `发音（${settings.accent}）`, onclick: () => speak(lemma) }, '🔊')
    : null;

  const head = h('div', { class: 'card-head' }, title, h('div', { class: 'card-actions' }, speaker, star, h('button', { class: 'iconbtn close', type: 'button', 'aria-label': '关闭', onclick: () => closeCard(true) }, '✕')));
  card.append(handle, head);

  if (entry?.p) card.append(h('div', { class: 'card-phon', title: 'ECDICT 参考音标' }, `/${entry.p}/`));

  if (entry) {
    if (entry.proper) card.append(h('div', { class: 'card-note' }, '专有名词 / 术语（补充释义）'));
    card.append(...entryBody(entry));
  } else {
    card.append(h('div', { class: 'card-missing' }, '词典未收录'));
  }

  if (formEntry && showForm) {
    const det = h('details', { class: 'card-own' }, h('summary', null, `「${token}」本身的词条`));
    if (formEntry.p) det.append(h('div', { class: 'card-phon' }, `/${formEntry.p}/`));
    det.append(...entryBody(formEntry));
    card.append(det);
  }

  if (r.altEntry && r.altKey) {
    const det = h('details', { class: 'card-own card-alt' }, h('summary', null, `动词「${r.altKey}」的词条`));
    if (r.altEntry.p) det.append(h('div', { class: 'card-phon' }, `/${r.altEntry.p}/`));
    det.append(...entryBody(r.altEntry));
    card.append(det);
  }

  document.body.append(card);
  card.classList.toggle('sheet', isMobile());

  // ---- positioning ----
  const place = () => {
    if (isMobile()) {
      card.classList.add('sheet');
      card.style.left = card.style.top = '';
      document.body.style.paddingBottom = `${card.offsetHeight + 16}px`;
      const rect = anchor.getBoundingClientRect();
      const limit = window.innerHeight - card.offsetHeight - 16;
      if (rect.bottom > limit) window.scrollBy({ top: rect.bottom - limit + 8 });
      else if (rect.top < 60) window.scrollBy({ top: rect.top - 80 });
      return;
    }
    card.classList.remove('sheet');
    const rect = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const hgt = card.offsetHeight;
    const margin = 8;
    let left = rect.left + window.scrollX;
    left = Math.max(margin + window.scrollX, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - margin));
    const below = rect.bottom + 8;
    const fitsBelow = below + hgt < window.innerHeight - margin;
    const top = fitsBelow ? below : Math.max(margin, rect.top - hgt - 8);
    card.style.left = `${left}px`;
    card.style.top = `${top + window.scrollY}px`;
  };
  place();
  card.focus({ preventScroll: true });
  card.addEventListener('toggle', place, true);
  card.addEventListener('click', () => requestAnimationFrame(() => !isMobile() && place()));

  // ---- close behaviours ----
  const onDown = (e: Event) => {
    const t = e.target as HTMLElement;
    if (card.contains(t) || t.closest('.w') || t.closest('#toasts')) return;
    closeCard();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCard(true);
    }
  };
  const onResize = () => place();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  // swipe down to dismiss (bottom sheet)
  let startY = 0;
  let dy = 0;
  let dragging = false;
  const down = (e: PointerEvent) => {
    if (!card.classList.contains('sheet') || (e.target as HTMLElement).closest('button')) return;
    dragging = true;
    startY = e.clientY;
    dy = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    card.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (dy > 80) closeCard();
    else card.style.transform = '';
  };
  for (const el of [handle, head]) {
    el.addEventListener('pointerdown', down as EventListener);
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  current = {
    el: card,
    anchor,
    cleanup: () => {
      offChange();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    },
  };
}
