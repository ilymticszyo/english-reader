import { clear, h, toast } from '../dom.ts';
import { LEVEL_RANK } from '../shared/types.ts';
import { exportBackup, getVocab, importBackup, onChange, parseBackup, removeWord, restoreWord, setMastered } from '../store.ts';
import type { VocabItem } from '../store.ts';
import { speak, ttsSupported } from '../tts.ts';

const state = { sort: 'recent', cefr: '', showMastered: false, q: '', shown: 50 };
const PAGE = 50;

export function mountWords(root: HTMLElement): () => void {
  const summary = h('p', { class: 'muted', id: 'vocab-summary' });
  const list = h('div', { class: 'vocab-list' });
  const more = h('div', { class: 'more' });

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', onchange: () => onFile() });
  const exportBtn = h('button', { class: 'btn', type: 'button', id: 'export-btn', onclick: () => doExport() }, '⬇ 导出 JSON');
  const importBtn = h('button', { class: 'btn', type: 'button', id: 'import-btn', onclick: () => fileInput.click() }, '⬆ 导入 JSON');

  const search = h('input', { type: 'search', placeholder: '搜索单词或释义…', 'aria-label': '搜索生词', value: state.q, oninput: (e: Event) => { state.q = (e.target as HTMLInputElement).value; state.shown = PAGE; render(); } });
  const sortSel = h('select', { 'aria-label': '排序', onchange: (e: Event) => { state.sort = (e.target as HTMLSelectElement).value; render(); } },
    h('option', { value: 'recent' }, '最近查询'), h('option', { value: 'count' }, '查询次数'), h('option', { value: 'alpha' }, '字母顺序'));
  sortSel.value = state.sort;
  const cefrSel = h('select', { 'aria-label': '按 CEFR 筛选', onchange: (e: Event) => { state.cefr = (e.target as HTMLSelectElement).value; state.shown = PAGE; render(); } },
    h('option', { value: '' }, '全部等级'), ...['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((c) => h('option', { value: c }, c)), h('option', { value: '-' }, '无等级'));
  cefrSel.value = state.cefr;
  const masteredCb = h('input', { type: 'checkbox', checked: state.showMastered, onchange: (e: Event) => { state.showMastered = (e.target as HTMLInputElement).checked; render(); } });

  root.append(
    h('h1', null, '生词本'),
    summary,
    h('div', { class: 'backup' }, exportBtn, importBtn, fileInput, h('span', { class: 'muted small' }, '备份包含生词本、阅读进度和设置')),
    h('div', { class: 'filters' }, search, sortSel, cefrSel, h('label', { class: 'check' }, masteredCb, ' 显示已掌握')),
    list,
    more,
  );

  function doExport() {
    const data = JSON.stringify(exportBackup(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `english-reader-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`已导出 ${Object.keys(getVocab()).length} 个生词`);
  }

  async function onFile() {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const b = parseBackup(await f.text());
      const n = Object.keys(b.vocab).length;
      askImportMode(n, b);
    } catch (e) {
      toast('导入失败：' + (e as Error).message, undefined, 7000);
    }
  }

  function askImportMode(n: number, b: ReturnType<typeof parseBackup>) {
    const dlg = h('div', { class: 'modal-back', role: 'presentation' });
    const close = () => dlg.remove();
    const run = (mode: 'merge' | 'overwrite') => {
      importBackup(b, mode);
      close();
      toast(mode === 'merge' ? `已合并导入（文件内 ${n} 个生词）` : `已覆盖导入（${n} 个生词）`);
    };
    dlg.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入备份' },
      h('h2', null, '导入备份'),
      h('p', null, `文件包含 ${n} 个生词${b.exportedAt ? `，导出于 ${b.exportedAt.slice(0, 10)}` : ''}。`),
      h('p', { class: 'muted' }, '合并：保留现有数据并加入文件中的内容。覆盖：用文件内容替换当前的生词本、进度和设置。'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn primary', type: 'button', id: 'import-merge', onclick: () => run('merge') }, '合并'),
        h('button', { class: 'btn danger', type: 'button', id: 'import-overwrite', onclick: () => run('overwrite') }, '覆盖'),
        h('button', { class: 'btn', type: 'button', onclick: close }, '取消'))));
    dlg.addEventListener('click', (e) => e.target === dlg && close());
    document.body.append(dlg);
  }

  function row(lemma: string, it: VocabItem): HTMLElement {
    const ctxBox = h('div', { class: 'ctx-box', hidden: true });
    for (const c of [...it.ctx].reverse()) {
      ctxBox.append(h('a', { class: 'ctx', href: `#/read/${c.a}?p=${c.p}&s=${encodeURIComponent(c.s)}`, title: '回到原文' },
        h('span', null, c.s), h('span', { class: 'muted small' }, ` — ${c.a}`)));
    }
    if (!it.ctx.length) ctxBox.append(h('div', { class: 'muted small' }, '暂无语境'));
    const toggle = h('button', { class: 'linkbtn', type: 'button', onclick: () => { ctxBox.hidden = !ctxBox.hidden; toggle.textContent = ctxBox.hidden ? `语境（${it.ctx.length}）` : '收起语境'; } }, `语境（${it.ctx.length}）`);
    return h('div', { class: 'vocab-row' + (it.mastered ? ' mastered' : ''), dataset: { word: lemma } },
      h('div', { class: 'vr-main' },
        h('div', { class: 'vr-top' },
          h('strong', { class: 'vr-word' }, lemma),
          it.snap.p ? h('span', { class: 'phon' }, `/${it.snap.p}/`) : null,
          it.snap.cefr ? h('span', { class: 'badge cefr' }, it.snap.cefr) : null,
          h('span', { class: 'muted small' }, `查询 ${it.count} 次`),
          ttsSupported ? h('button', { class: 'iconbtn speak', type: 'button', 'aria-label': `发音 ${lemma}`, onclick: () => speak(lemma) }, '🔊') : null),
        h('div', { class: 'vr-zh' }, it.snap.zh || '（词典未收录）'),
        toggle, ctxBox),
      h('div', { class: 'vr-actions' },
        h('button', { class: 'btn small mastered-btn', type: 'button', onclick: () => setMastered(lemma, !it.mastered) }, it.mastered ? '取消已掌握' : '已掌握'),
        h('button', { class: 'btn small danger remove-btn', type: 'button', onclick: () => { const old = removeWord(lemma); if (old) toast(`已移除「${lemma}」`, { label: '撤销', run: () => restoreWord(lemma, old) }); } }, '移除')));
  }

  function render() {
    const vocab = getVocab();
    const all = Object.entries(vocab);
    const q = state.q.trim().toLowerCase();
    let items = all.filter(([w, it]) => {
      if (it.mastered && !state.showMastered) return false;
      if (state.cefr === '-' ? it.snap.cefr : state.cefr && it.snap.cefr !== state.cefr) return false;
      if (q && !w.includes(q) && !(it.snap.zh ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    items.sort((a, b) => state.sort === 'alpha' ? a[0].localeCompare(b[0]) : state.sort === 'count' ? b[1].count - a[1].count || b[1].lastAt - a[1].lastAt : b[1].lastAt - a[1].lastAt);
    const mastered = all.filter(([, i]) => i.mastered).length;
    summary.textContent = `共 ${all.length} 个生词，其中已掌握 ${mastered} 个；当前显示 ${items.length} 个`;
    clear(list);
    clear(more);
    if (!items.length) {
      list.append(h('div', { class: 'empty' }, all.length ? '没有符合条件的生词。' : '生词本还是空的。去读一篇文章，点一下不认识的词，它会自动收进来。', all.length ? null : h('div', null, h('a', { class: 'btn', href: '#/' }, '去读文章'))));
      return;
    }
    // paging keeps the DOM small even with thousands of words
    for (const [w, it] of items.slice(0, state.shown)) list.append(row(w, it));
    void LEVEL_RANK;
    if (items.length > state.shown) more.append(h('button', { class: 'btn', type: 'button', onclick: () => { state.shown += PAGE; render(); } }, `显示更多（还有 ${items.length - state.shown} 个）`));
  }
  render();
  return onChange((w) => (w === 'vocab' || w === 'all') && render());
}
