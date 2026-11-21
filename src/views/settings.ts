import { h, toast } from '../dom.ts';
import { backupControls } from '../backup-ui.ts';
import { getVersionInfo, offlineStatus } from '../pwa.ts';
import { loadPools, renderHistorySummary } from './history.ts';
import type { Pools } from './history.ts';
import { STORAGE_WARN_BYTES, WPM_OPTIONS, getMeta, getSettings, onChange, resetSettings, setSettings, storageUsage } from '../store.ts';
import type { Settings } from '../store.ts';
import { hasEnglishVoice, onVoicesChanged, ttsSupported } from '../tts.ts';

export function mountSettings(root: HTMLElement): () => void {
  const body = h('div', { class: 'settings' });
  root.append(h('h1', null, '设置'), body);

  const seg = <T extends string | number>(label: string, key: keyof Settings, opts: [T, string][], hint = '') => {
    const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const [v, t] of opts) {
      wrap.append(h('button', { class: 'seg-btn' + (getSettings()[key] === v ? ' active' : ''), type: 'button', role: 'radio', 'aria-checked': String(getSettings()[key] === v), dataset: { key: String(key), value: String(v) }, onclick: () => { setSettings({ [key]: v } as Partial<Settings>); render(); } }, t));
    }
    return h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, label), wrap, hint ? h('div', { class: 'muted small' }, hint) : null);
  };
  const toggle = (label: string, key: keyof Settings, hint = '') => {
    const cb = h('input', { type: 'checkbox', checked: !!getSettings()[key], id: `set-${String(key)}`, onchange: (e: Event) => setSettings({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>) });
    return h('label', { class: 'setting toggle' }, h('div', null, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'muted small' }, hint) : null), cb);
  };

  const usageLine = h('div', { class: 'muted', id: 'usage' });
  const versionLine = h('div', { class: 'muted', id: 'version' }, '读取中…');
  const offlineLine = h('div', { class: 'muted', id: 'offline' }, '检查中…');
  const backupLine = h('div', { class: 'muted small', id: 'last-backup' });
  const voiceHint = h('p', { class: 'muted small', id: 'voice-hint', hidden: true });
  const historyBox = h('section', { class: 'history-summary', id: 'settings-history' }, h('span', { class: 'muted small' }, '读取中…'));
  let pools: Pools | null = null;
  void loadPools().then((p) => { pools = p; renderHistorySummary(historyBox, p); }).catch(() => historyBox.replaceChildren('文章索引读取失败'));

  function fillDynamic() {
    const used = storageUsage();
    usageLine.textContent = `${(used / 1024).toFixed(1)} KB（localStorage，上限通常约 5 MB）` + (used > STORAGE_WARN_BYTES ? ' ⚠️ 已超过 4 MB，请导出备份并清理已掌握的词' : '');
    const t = getMeta().lastBackupAt;
    backupLine.textContent = t ? `上次导出备份：${new Date(t).toLocaleString()}` : '还没有导出过备份。浏览器清缓存会丢失生词本，建议定期导出。';
    const v = hasEnglishVoice();
    voiceHint.hidden = v !== false || !ttsSupported;
    voiceHint.textContent = '没有检测到英文语音。发音按钮可能没有声音，请在系统设置里安装英文语音。';
  }

  function render() {
    body.replaceChildren(
      ...([
        seg('字号', 'fontSize', [[0, '小'], [1, '中'], [2, '大'], [3, '特大']]),
        seg('主题', 'theme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]),
        seg('预计阅读速度', 'wpm', WPM_OPTIONS.map((n) => [n, `${n}`] as [number, string]), '词/分钟，用于文章卡片上的“约 N 分钟”'),
        seg('发音口音', 'accent', [['en-US', '美式 en-US'], ['en-GB', '英式 en-GB']]),
        ttsSupported ? voiceHint : h('p', { class: 'muted small' }, '当前浏览器不支持语音合成，查词卡片不会显示发音按钮。'),
        toggle('点击查词时自动收录到生词本', 'autoCollect'),
        toggle('读到文末自动标记为已读', 'autoMarkRead'),
        toggle('在正文中标出生词本里的词', 'highlightKnown', '淡淡的底色，已掌握的词不标'),
        h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '阅读记录'), historyBox),
        h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '数据备份'), backupControls(), h('div', { class: 'muted small' }, '生词本、复习进度和阅读记录一起导出为一个 JSON 文件（含格式版本号）。导入时与本机数据合并，不会覆盖；也能导入旧版只含生词本的导出文件。'), backupLine),
        h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '本地存储用量'), usageLine),
        h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '离线使用'), offlineLine),
        h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, '版本'), versionLine, h('a', { href: '#/about' }, '关于与致谢（数据来源与许可）')),
        h('div', { class: 'setting' }, h('button', { class: 'btn danger', type: 'button', id: 'reset-settings', onclick: () => { resetSettings(); render(); toast('已恢复默认设置'); } }, '恢复默认设置')),
      ].filter(Boolean) as Node[]),
    );
    fillDynamic();
  }
  render();

  void (async () => {
    const info = await getVersionInfo();
    versionLine.textContent = info ? `${info.version}（${info.files} 个文件，构建于 ${info.builtAt.slice(0, 16).replace('T', ' ')} UTC）` : '开发模式（无版本信息）';
    const st = await offlineStatus(info?.version);
    offlineLine.textContent = st === 'ready' ? '✅ 已缓存全部文章和词典，断网也能使用' : st === 'installing' ? '⏳ 正在下载离线缓存（首次访问后稍等片刻，刷新一次页面即可生效）' : '当前环境未启用离线缓存（需要 HTTPS 或 localhost 的生产构建）';
  })();

  navigator.storage?.persist?.().catch(() => {});
  const offVoices = () => fillDynamic();
  onVoicesChanged(offVoices);
  const off = onChange((w) => { if (w === 'settings') fillDynamic(); if ((w === 'progress' || w === 'all') && pools) renderHistorySummary(historyBox, pools); });
  return () => off();
}
