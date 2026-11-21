// Export / import UI shared by the vocabulary page and the settings page.
import { h, toast } from './dom.ts';
import { exportBackup, importBackup, markBackup, parseBackup } from './store.ts';
import type { ParsedBackup } from './store.ts';

export function exportDownload() {
  const b = exportBackup();
  const data = JSON.stringify(b, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `english-reader-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  markBackup();
  toast(`已导出 ${Object.keys(b.vocab).length} 个生词、${Object.keys(b.history).length} 条阅读记录、${Object.keys(b.review).length} 条复习记录和 ${b.levelTest.length} 条自测记录`);
}

export async function handleImportFile(input: HTMLInputElement) {
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    askImport(parseBackup(await f.text()));
  } catch (e) {
    toast('导入失败：' + (e as Error).message, undefined, 7000);
  }
}

function askImport(b: ParsedBackup) {
  const nWords = Object.keys(b.vocab).length;
  const nHist = Object.keys(b.history).length;
  const nRead = Object.values(b.history).filter((p) => p.status === 'read').length;
  const dlg = h('div', { class: 'modal-back', role: 'presentation' });
  const close = () => dlg.remove();
  const run = () => {
    const r = importBackup(b);
    close();
    toast(`已合并导入：新增 ${r.wordsAdded} 个生词，新增 ${r.historyAdded} 条、更新 ${r.historyUpdated} 条阅读记录` + (b.hasReview ? `，新增 ${r.reviewAdded} 条、更新 ${r.reviewUpdated} 条复习记录` : '') + (b.hasLevelTest ? `，新增 ${r.levelTestAdded} 条自测记录` : ''));
  };
  const nRev = Object.keys(b.review).length;
  const kind = b.fileSchema === 0 ? '旧版生词本文件（无版本号）' : `备份格式 v${b.fileSchema}`;
  dlg.append(
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入备份', id: 'import-dialog' },
      h('h2', null, '导入备份'),
      h('p', { id: 'import-summary' }, `文件包含 ${nWords} 个生词` + (b.hasHistory ? `、${nHist} 条阅读记录（其中已读 ${nRead} 篇）` : '，没有阅读记录（只含生词本的旧版导出）') + (b.hasReview ? `、${nRev} 条复习记录` : b.hasHistory ? '，没有复习记录（0.7.0 之前的导出）' : '') + (b.hasLevelTest ? `、${b.levelTest.length} 条自测记录` : b.hasReview ? '，没有自测记录（0.8.0 之前的导出）' : '') + (b.exportedAt ? `，导出于 ${b.exportedAt.slice(0, 10)}` : '') + '。'),
      h('p', { class: 'muted small' }, `${kind}。导入会与现有数据合并，不会删除或替换本机的生词和阅读记录：同一个词合并查询次数和例句；同一篇文章、同一个词的复习进度都以较新的那次改动为准；自测记录按测试时间合并（不重复）。设置不会被导入。`),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn primary', type: 'button', id: 'import-merge', onclick: run }, '合并导入'),
        h('button', { class: 'btn', type: 'button', id: 'import-cancel', onclick: close }, '取消'))),
  );
  dlg.addEventListener('click', (e) => e.target === dlg && close());
  document.body.append(dlg);
}

/** Builds export/import buttons + hidden file input. */
export function backupControls(): HTMLElement {
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', onchange: () => handleImportFile(fileInput) });
  return h('div', { class: 'backup' },
    h('button', { class: 'btn', type: 'button', id: 'export-btn', onclick: exportDownload }, '⬇ 导出 JSON'),
    h('button', { class: 'btn', type: 'button', id: 'import-btn', onclick: () => fileInput.click() }, '⬆ 导入 JSON'),
    fileInput);
}
