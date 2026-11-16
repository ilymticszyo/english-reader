// Export / import UI shared by the vocabulary page and the settings page.
import { h, toast } from './dom.ts';
import { exportBackup, getVocab, importBackup, markBackup, parseBackup } from './store.ts';

export function exportDownload() {
  const data = JSON.stringify(exportBackup(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `english-reader-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  markBackup();
  toast(`已导出 ${Object.keys(getVocab()).length} 个生词（以及进度和设置）`);
}

export async function handleImportFile(input: HTMLInputElement) {
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const b = parseBackup(await f.text());
    askImportMode(Object.keys(b.vocab).length, b);
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
  dlg.append(
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入备份' },
      h('h2', null, '导入备份'),
      h('p', null, `文件包含 ${n} 个生词${b.exportedAt ? `，导出于 ${b.exportedAt.slice(0, 10)}` : ''}。`),
      h('p', { class: 'muted' }, '合并：保留现有数据并加入文件中的内容。覆盖：用文件内容替换当前的生词本、进度和设置。'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn primary', type: 'button', id: 'import-merge', onclick: () => run('merge') }, '合并'),
        h('button', { class: 'btn danger', type: 'button', id: 'import-overwrite', onclick: () => run('overwrite') }, '覆盖'),
        h('button', { class: 'btn', type: 'button', onclick: close }, '取消'))),
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
