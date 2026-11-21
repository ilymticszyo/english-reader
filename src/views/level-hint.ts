// Gentle 难度自测 hint on the home page: "take the test" when there is no result yet, or the upgrade / step-down /
// retake suggestion (see suggest() in shared/leveltest.ts). Dismissible; a dismissed hint stays hidden until the
// advice changes (key stored in ra:v1:levelHint — a device preference, not part of the backup).
import { h } from '../dom.ts';
import { PREFIX, getLatestLevel, getSuggestion } from '../store.ts';

const KEY = PREFIX + 'levelHint';

export function renderLevelHint(el: HTMLElement): HTMLElement {
  const s = getSuggestion();
  const latest = getLatestLevel();
  let text = '';
  if (s.kind === 'test') text = '不确定从哪个难度读起？做个 5 分钟难度自测';
  else if (s.kind === 'up') text = s.target === 'classics' ? `${s.level} 读得很轻松，可以试试名著赏析` : `${s.level} 读得很轻松，可以试试 ${s.target}`;
  else if (s.kind === 'down') text = `${s.level} 查词偏多，可以先回到 ${s.target} 读一阵`;
  else if (s.retake) text = '离上次难度自测已经有一段时间了，可以重测一次';
  const sig = `${s.kind}:${s.target ?? ''}:${s.retake}:${latest?.takenAt ?? 0}`;
  let dismissed = '';
  try { dismissed = localStorage.getItem(KEY) ?? ''; } catch { /* ignore */ }
  el.className = 'level-hint';
  el.dataset.kind = s.kind;
  el.hidden = !text || dismissed === sig;
  el.replaceChildren(
    h('a', { href: '#/level', id: 'level-hint-link' }, h('span', { 'aria-hidden': 'true' }, '🎯 '), text, ' →'),
    h('button', { class: 'iconbtn level-hint-x', type: 'button', id: 'level-hint-x', 'aria-label': '不再提示这条建议', title: '不再提示这条建议', onclick: () => { try { localStorage.setItem(KEY, sig); } catch { /* ignore */ } el.hidden = true; } }, '×'),
  );
  return el;
}
