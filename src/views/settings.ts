import { h, toast } from '../dom.ts';
import { getSettings, resetSettings, setSettings, storageUsage } from '../store.ts';
import type { Settings } from '../store.ts';
import { ttsSupported } from '../tts.ts';

export function mountSettings(root: HTMLElement): () => void {
  const body = h('div', { class: 'settings' });
  root.append(h('h1', null, '设置'), body);

  const seg = <T extends string | number>(label: string, key: keyof Settings, opts: [T, string][]) => {
    const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const [v, t] of opts) {
      wrap.append(h('button', { class: 'seg-btn' + (getSettings()[key] === v ? ' active' : ''), type: 'button', role: 'radio', 'aria-checked': String(getSettings()[key] === v), dataset: { key: String(key), value: String(v) }, onclick: () => { setSettings({ [key]: v } as Partial<Settings>); render(); } }, t));
    }
    return h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, label), wrap);
  };
  const toggle = (label: string, key: keyof Settings, hint = '') => {
    const cb = h('input', { type: 'checkbox', checked: !!getSettings()[key], id: `set-${String(key)}`, onchange: (e: Event) => setSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>) });
    return h('label', { class: 'setting toggle' }, h('div', null, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'muted small' }, hint) : null), cb);
  };

  function render() {
    body.replaceChildren(
      ...[
      seg('字号', 'fontSize', [[0, '小'], [1, '中'], [2, '大'], [3, '特大']]),
      seg('主题', 'theme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]),
      seg('发音口音', 'accent', [['en-US', '美式 en-US'], ['en-GB', '英式 en-GB']]),
      ttsSupported ? null : h('p', { class: 'muted small' }, '当前浏览器不支持语音合成，查词卡片不会显示发音按钮。'),
      toggle('点击查词时自动收录到生词本', 'autoCollect'),
      toggle('读到文末自动标记为已读', 'autoMarkRead'),
      toggle('在正文中标出生词本里的词', 'highlightKnown', '淡淡的底色，已掌握的词不标'),
      h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '本地存储用量'), h('div', { class: 'muted', id: 'usage' }, `${(storageUsage() / 1024).toFixed(1)} KB（localStorage，上限通常约 5 MB）`)),
      h('div', { class: 'setting' }, h('button', { class: 'btn danger', type: 'button', id: 'reset-settings', onclick: () => { resetSettings(); render(); toast('已恢复默认设置'); } }, '恢复默认设置')),
      ].filter((x): x is NonNullable<typeof x> => !!x) as Node[],
    );
  }
  render();
  navigator.storage?.persist?.().catch(() => {});
  return () => {};
}
