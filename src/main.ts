import './style.css';
import { clear, h } from './dom.ts';
import { closeCard } from './popup.ts';
import { parseHash } from './router.ts';
import { applyAppearance, getSettings, setSettings } from './store.ts';
import { mountAbout } from './views/about.ts';
import { registerSW } from './pwa.ts';
import { mountClassicReader } from './views/classic-reader.ts';
import { mountClassics } from './views/classics.ts';
import { mountList } from './views/list.ts';
import { mountReader } from './views/reader.ts';
import { mountSettings } from './views/settings.ts';
import { mountWords } from './views/words.ts';

applyAppearance();

const app = document.getElementById('app')!;
const nav = h('nav', { class: 'topnav', 'aria-label': '主导航' },
  h('a', { class: 'brand', href: '#/', 'aria-label': 'English Reader 首页' }, h('span', { 'aria-hidden': 'true' }, '📖'), h('span', { class: 'brand-txt' }, ' English Reader')),
  h('div', { class: 'navlinks' },
    h('a', { href: '#/', dataset: { nav: 'list' } }, '文章'),
    h('a', { href: '#/classics', dataset: { nav: 'classics' } }, '名著'),
    h('a', { href: '#/words', dataset: { nav: 'words' } }, '生词本'),
    h('a', { href: '#/settings', dataset: { nav: 'settings' } }, '设置'),
    h('button', { class: 'iconbtn', type: 'button', id: 'nav-theme', 'aria-label': '切换主题', onclick: () => {
      const order = ['light', 'dark', 'system'] as const;
      setSettings({ theme: order[(order.indexOf(getSettings().theme) + 1) % 3] });
      syncTheme();
    } })));
const main = h('main', { id: 'main', class: 'main' });
const footer = h('footer', { class: 'site-footer muted small' }, h('a', { href: '#/about' }, '关于与致谢'), ' · 数据：ECDICT、CEFR-J、Octanove · 名著原文：Project Gutenberg');
app.append(nav, main, footer);
registerSW();

function syncTheme() {
  const t = getSettings().theme;
  const b = document.getElementById('nav-theme')!;
  b.textContent = t === 'light' ? '☀️' : t === 'dark' ? '🌙' : '🌓';
  b.title = `主题：${t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'}（点击切换）`;
}
syncTheme();

let cleanup: (() => void) | null = null;
let token = 0;

async function render() {
  const my = ++token;
  cleanup?.();
  cleanup = null;
  closeCard();
  const view = h('div', { class: 'view' });
  main.replaceChildren(view);
  const route = parseHash();
  for (const a of nav.querySelectorAll<HTMLElement>('[data-nav]')) {
    const navOf = route.name === 'read' ? 'list' : route.name === 'classic' ? 'classics' : route.name;
    const on = a.dataset.nav === navOf;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
  main.className = `main view-${route.name}`;
  let c: () => void;
  try {
    if (route.name === 'read') c = await mountReader(view, route.id!, route.query);
    else if (route.name === 'classic') c = await mountClassicReader(view, route.id!, route.query);
    else if (route.name === 'classics') {
      window.scrollTo({ top: 0 });
      c = await mountClassics(view);
    } else if (route.name === 'words') c = mountWords(view);
    else if (route.name === 'settings') c = mountSettings(view);
    else if (route.name === 'about') c = mountAbout(view);
    else {
      window.scrollTo({ top: 0 });
      c = await mountList(view);
    }
  } catch (e) {
    console.error(e);
    view.replaceChildren(h('div', { class: 'empty' }, h('p', null, '加载失败：' + (e as Error).message), h('a', { class: 'btn', href: '#/' }, '返回首页')));
    return;
  }
  if (my !== token) c(); // a newer navigation superseded us
  else cleanup = c;
  if (route.name === 'words' || route.name === 'settings' || route.name === 'about') window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', render);
render();
