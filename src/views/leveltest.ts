// #/level — 难度自测 (level self-test). Intro + history → yes/no vocabulary check → 3 short reading passages → result.
// #/level?r=<takenAt> shows a saved result; #/level?seed=N makes the next test deterministic (tests / sharing).
// Scoring and thresholds: src/shared/leveltest.ts.
import { append, clear, h, toast } from '../dom.ts';
import { loadLevelTest } from '../data.ts';
import { BANDS, BAND_PASS, FA_WARN, LEVELS, PSEUDO_N, READ_PASS, VOCAB_PER_BAND, makePlan, scoreTest } from '../shared/leveltest.ts';
import type { Answers, LevelResult, Suggestion, TestPlan } from '../shared/leveltest.ts';
import { addLevelResult, getLatestLevel, getLevelResults, getSuggestion, onChange, setSettings } from '../store.ts';

const fmtDate = (t: number) => new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const estLabel = (e: string) => (e === 'A2' ? 'A2 及以下' : e === 'C1+' ? 'C1 以上' : e);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const randomSeed = () => (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647) + 1;

export async function mountLevelTest(root: HTMLElement, query: URLSearchParams): Promise<() => void> {
  root.append(h('p', { class: 'muted' }, '加载中…'));
  const data = await loadLevelTest();
  const zhOf = new Map<string, string>();
  for (const b of BANDS) for (const x of data.bands[b]) zhOf.set(x.w, x.zh);
  let seedParam = Number(query.get('seed')) || 0;
  let offKeys: (() => void) | null = null;
  let inTest = false;
  const setKeys = (fn: ((e: KeyboardEvent) => void) | null) => {
    offKeys?.();
    offKeys = null;
    if (!fn) return;
    document.addEventListener('keydown', fn);
    offKeys = () => document.removeEventListener('keydown', fn);
  };
  const put = (...c: (Node | string | null)[]) => { clear(root); append(root, c); };
  const focusHead = () => (root.querySelector('h1, h2') as HTMLElement | null)?.focus();
  const setHash = (hash: string) => { if (location.hash !== hash) history.replaceState(null, '', hash); };

  // ---------------------------------------------------------------- intro + history
  function renderHome() {
    inTest = false;
    setKeys(null);
    setHash(seedParam ? `#/level?seed=${seedParam}` : '#/level');
    const latest = getLatestLevel();
    const results = getLevelResults();
    put(
      h('div', { class: 'lt-head' }, h('h1', { tabindex: '-1' }, '难度自测')),
      h('section', { class: 'lt-intro' },
        h('p', null, '用大约 5 分钟估算你的英语阅读水平，推荐从 B1、B2 还是 C1 读起。可以随时重测，每次抽到的题都不一样。'),
        h('ol', { class: 'lt-steps' },
          h('li', null, h('strong', null, '认词'), `：${VOCAB_PER_BAND * BANDS.length} 个来自 CEFR 词表（A2–C2）的单词，加 ${PSEUDO_N} 个编造的假词。只回答「认识」或「不认识」，约 2 分钟。`),
          h('li', null, h('strong', null, '阅读'), '：3 段取自本站文章的短文（B1 / B2 / C1），每段 3 道选择题，约 3 分钟。')),
        h('p', { class: 'muted small' }, '结果只保存在本机浏览器，会随「导出 JSON」一起备份。'),
        h('button', { class: 'btn primary lt-start', type: 'button', id: 'lt-start', onclick: () => startTest() }, latest ? '再测一次' : '开始自测')),
      latest ? latestBox(latest) : null,
      suggestionBox(getSuggestion()),
      results.length ? historyBox(results) : null,
    );
  }

  function latestBox(r: LevelResult) {
    return h('section', { class: 'lt-latest', id: 'lt-latest', 'aria-label': '上次结果' },
      h('div', { class: 'lt-latest-main' },
        h('span', { class: 'muted small' }, `上次自测 · ${fmtDate(r.takenAt)}`),
        h('span', null, '推荐从 ', h('strong', { class: `badge lv lv-${r.recommended}` }, r.recommended), ' 读起'),
        h('span', { class: 'muted small' }, `估计水平 ${estLabel(r.estimate)} · 综合 ${r.score} 分`)),
      h('a', { class: 'btn small', href: `#/level?r=${r.takenAt}` }, '查看详情'));
  }

  function suggestionBox(s: Suggestion) {
    if (s.kind === 'test') return null;
    const go = (s.kind === 'up' || s.kind === 'down') && s.target && s.target !== 'classics' ? s.target : null;
    return h('section', { class: `lt-suggest lt-s-${s.kind}`, id: 'lt-suggest', dataset: { kind: s.kind, retake: String(s.retake) }, 'aria-label': '升降级建议' },
      h('h2', null, s.kind === 'up' ? '📈 可以升级了' : s.kind === 'down' ? '📉 建议先降一级' : s.kind === 'more' ? '📚 继续读' : '👍 难度合适'),
      h('p', null, s.text),
      h('p', { class: 'muted small lt-stats' }, LEVELS.map((l) => `${l}：已读 ${s.stats[l].read} 篇 · 每篇 ${s.stats[l].rate} 个生词`).join('；')),
      h('div', { class: 'lt-actions' },
        go ? h('button', { class: 'btn', type: 'button', id: 'lt-suggest-go', onclick: () => { setSettings({ lastLevel: go }); location.hash = '#/'; } }, `去读 ${go} 文章`) : null,
        s.target === 'classics' ? h('a', { class: 'btn', href: '#/classics' }, '去读名著') : null));
  }

  function historyBox(results: LevelResult[]) {
    return h('section', { class: 'lt-history', id: 'lt-history', 'aria-label': '自测记录' },
      h('h2', null, `自测记录（${results.length}）`),
      h('ul', { class: 'lt-hist-list' }, ...[...results].reverse().map((r) =>
        h('li', { class: 'lt-hist-row', dataset: { t: String(r.takenAt) } },
          h('a', { href: `#/level?r=${r.takenAt}` },
            h('span', { class: 'lt-hist-date' }, fmtDate(r.takenAt)),
            h('span', { class: `badge lv lv-${r.recommended}` }, r.recommended),
            h('span', { class: 'muted small' }, `估计 ${estLabel(r.estimate)} · ${r.score} 分 · 词汇量约 ${r.vocab.size}` + (r.reliable ? '' : ' · ⚠ 假词误认多')))))));
  }

  // ---------------------------------------------------------------- the test
  function startTest() {
    const seed = seedParam || randomSeed();
    seedParam = 0; // a seed from the URL is used once; 再测一次 always draws a fresh sample
    runTest(makePlan(data, seed));
  }

  function runTest(plan: TestPlan) {
    inTest = true;
    setHash('#/level');
    const t0 = Date.now();
    const ans: Answers = { vocab: {}, reading: plan.reading.map((ri) => ri.questions.map(() => -1)) };
    const N = plan.vocab.length;
    let i = 0;
    const total = N + plan.reading.length;
    const bar = h('div', { class: 'lt-bar', role: 'progressbar', 'aria-label': '自测进度', 'aria-valuemin': '0', 'aria-valuemax': String(total) }, h('span', { class: 'lt-bar-fill' }));
    const setBar = (n: number) => { bar.setAttribute('aria-valuenow', String(n)); (bar.firstChild as HTMLElement).style.width = `${(n / total) * 100}%`; };
    const quit = h('button', { class: 'linkbtn', type: 'button', id: 'lt-quit', onclick: () => { if (confirm('退出自测？本次答案不会保存。')) renderHome(); } }, '退出');

    const word = () => {
      setBar(i);
      const it = plan.vocab[i];
      const answer = (yes: boolean) => { ans.vocab[it.w] = yes; i++; i < N ? word() : passage(0); };
      put(
        h('div', { class: 'lt-head' }, h('h1', { tabindex: '-1' }, '第 1 部分：认词'), quit),
        bar,
        h('p', { class: 'muted small lt-hint' }, '看到这个词，能想起它的一个意思就选「认识」。其中混有编造的假词，选「认识」会扣分——不确定就选「不认识」。'),
        h('div', { class: 'lt-wordbox', id: 'lt-wordbox', 'aria-live': 'polite' },
          h('span', { class: 'muted small', id: 'lt-count' }, `${i + 1} / ${N}`),
          h('span', { class: 'lt-word', id: 'lt-word', lang: 'en' }, it.w)),
        h('div', { class: 'lt-yn' },
          h('button', { class: 'btn lt-no', type: 'button', id: 'lt-no', onclick: () => answer(false) }, '不认识', h('kbd', null, 'N')),
          h('button', { class: 'btn primary lt-yes', type: 'button', id: 'lt-yes', onclick: () => answer(true) }, '认识', h('kbd', null, 'Y'))),
        h('div', { class: 'lt-sub' },
          i > 0 ? h('button', { class: 'linkbtn', type: 'button', id: 'lt-back', onclick: () => { i--; word(); } }, '← 上一个') : h('span'),
          h('span', { class: 'muted small lt-keys' }, '快捷键：Y / → 认识，N / ← 不认识')),
      );
      setKeys((e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const k = e.key.toLowerCase();
        if (k === 'y' || k === 'arrowright') { e.preventDefault(); answer(true); }
        else if (k === 'n' || k === 'arrowleft') { e.preventDefault(); answer(false); }
      });
      if (i === 0) focusHead();
    };

    const passage = (pi: number) => {
      setKeys(null);
      setBar(N + pi);
      const ri = plan.reading[pi];
      const last = pi === plan.reading.length - 1;
      const nextBtn = h('button', { class: 'btn primary', type: 'button', id: 'lt-next', disabled: true, onclick: () => (last ? finish() : passage(pi + 1)) }, last ? '查看结果' : '下一篇 →');
      const sync = () => { nextBtn.disabled = ans.reading[pi].some((x) => x < 0); };
      put(
        h('div', { class: 'lt-head' }, h('h1', { tabindex: '-1' }, `第 2 部分：阅读（${pi + 1} / ${plan.reading.length}）`), quit),
        bar,
        h('article', { class: 'lt-passage', id: 'lt-passage', lang: 'en', dataset: { id: ri.passage.id, level: ri.passage.level } },
          ...ri.passage.text.map((p) => h('p', null, p)),
          h('p', { class: 'muted small lt-src', lang: 'zh-CN' }, `节选自本站文章《${ri.passage.title}》`)),
        h('form', { class: 'lt-questions', onsubmit: (e: Event) => e.preventDefault() },
          ...ri.questions.map((q, qi) => h('fieldset', { class: 'lt-q', dataset: { q: String(qi) } },
            h('legend', { lang: 'en' }, `${qi + 1}. ${q.q}`),
            ...q.options.map((o, oi) => {
              const id = `lt-q${qi}-o${oi}`;
              return h('label', { class: 'lt-opt', for: id, lang: 'en' },
                h('input', { type: 'radio', name: `q${qi}`, id, value: String(oi), checked: ans.reading[pi][qi] === oi, onchange: () => { ans.reading[pi][qi] = oi; sync(); } }),
                h('span', null, o));
            })))),
        h('div', { class: 'lt-actions' }, pi > 0 ? null : h('button', { class: 'btn', type: 'button', id: 'lt-prev', onclick: () => { i = N - 1; word(); } }, '← 回到认词'), nextBtn),
      );
      sync();
      focusHead();
    };

    const finish = () => {
      setBar(total);
      const r = scoreTest(plan, ans, data.bandSizes, Date.now(), Date.now() - t0);
      addLevelResult(r);
      inTest = false;
      renderResult(r, true);
    };
    word();
  }

  // ---------------------------------------------------------------- result
  function renderResult(r: LevelResult, fresh = false) {
    setKeys(null);
    setHash(`#/level?r=${r.takenAt}`);
    const s = getSuggestion();
    const isLatest = getLatestLevel()?.takenAt === r.takenAt;
    put(
      h('div', { class: 'lt-head' }, h('h1', { tabindex: '-1' }, fresh ? '自测结果' : `自测结果 · ${fmtDate(r.takenAt)}`), h('a', { class: 'linkbtn', href: '#/level', id: 'lt-home' }, '← 自测首页')),
      h('section', { class: 'lt-result', id: 'lt-result', dataset: { rec: r.recommended, est: r.estimate } },
        h('p', { class: 'lt-rec-line' }, '推荐从 ', h('strong', { class: `badge lv lv-${r.recommended} lt-rec`, id: 'lt-rec' }, r.recommended), ' 级文章读起'),
        h('p', { class: 'lt-est' }, `估计阅读水平：${estLabel(r.estimate)} · 综合 ${r.score} / 100 · 估计词汇量约 ${r.vocab.size} 词`),
        r.reliable ? null : h('p', { class: 'lt-warn', id: 'lt-warn', role: 'note' }, `⚠ 你把 ${r.vocab.pseudo.yes} / ${r.vocab.pseudo.n} 个假词选成了「认识」（超过 ${pct(FA_WARN)}），认词部分可能不准。建议重测，只在确定时选「认识」。`),
        h('div', { class: 'lt-actions' },
          h('button', { class: 'btn primary', type: 'button', id: 'lt-go', onclick: () => { setSettings({ lastLevel: r.recommended }); location.hash = '#/'; } }, `去读 ${r.recommended} 文章`),
          h('button', { class: 'btn', type: 'button', id: 'lt-retake', onclick: () => startTest() }, '再测一次'))),
      isLatest ? suggestionBox(s) : null,
      h('section', { class: 'lt-breakdown', 'aria-label': '得分明细' },
        h('h2', null, '认词'),
        h('table', { class: 'lt-table', id: 'lt-vocab-table' },
          h('caption', { class: 'sr-only' }, '各级词汇认词结果（已按假词误认率校正）'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, '词汇级别'), h('th', { scope: 'col' }, '选认识'), h('th', { scope: 'col' }, '校正后'), h('th', { scope: 'col' }, ''))),
          h('tbody', null, ...BANDS.map((b) => h('tr', { dataset: { band: b } },
            h('th', { scope: 'row' }, b),
            h('td', null, `${r.vocab.bands[b].yes} / ${r.vocab.bands[b].n}`),
            h('td', null, pct(r.vocab.corrected[b])),
            h('td', { class: 'lt-barcell' }, h('span', { class: 'lt-mini' + (r.vocab.corrected[b] >= BAND_PASS ? ' pass' : ''), style: `width:${Math.round(r.vocab.corrected[b] * 100)}%` })))))),
        h('p', { class: 'muted small' }, `假词选「认识」：${r.vocab.pseudo.yes} / ${r.vocab.pseudo.n}（误认率 ${pct(r.vocab.falseAlarm)}）。校正公式：(命中率 − 误认率) ÷ (1 − 误认率)。一级校正后 ≥ 60% 算通过；认词水平 = 从 A2 起连续通过的最高一级：${r.vocab.level === 'A1' ? 'A2 未通过' : r.vocab.level}。`),
        h('h2', null, '阅读'),
        h('ul', { class: 'lt-read', id: 'lt-read' }, ...LEVELS.map((l) => h('li', { dataset: { level: l } }, `${l} 短文：答对 ${r.reading.levels[l].correct} / ${r.reading.levels[l].n}` + (r.reading.levels[l].correct >= Math.min(READ_PASS, r.reading.levels[l].n) && r.reading.levels[l].n ? ' ✓' : '')))),
        h('p', { class: 'muted small' }, `每段答对 ≥ 2 题算通过；阅读水平 = 从 B1 起连续通过的最高一级：${r.reading.level === 'A2' ? 'B1 未通过' : r.reading.level}。推荐级别取认词和阅读中较低的一个（两者都要跟得上），范围 B1–C1。`),
        r.unknown.length ? h('details', { class: 'lt-words', id: 'lt-unknown' },
          h('summary', null, `选了「不认识」的词（${r.unknown.length}）`),
          h('ul', null, ...r.unknown.map((w) => h('li', null, h('span', { lang: 'en' }, w), ' ', h('span', { class: 'muted' }, zhOf.get(w) ?? ''))))) : null,
        r.pseudoYes.length ? h('p', { class: 'muted small', id: 'lt-pseudo-yes' }, `这些是编造的假词：${r.pseudoYes.join('、')}`) : null),
      h('p', { class: 'muted small lt-credit' }, '数据：CEFR-J 词表、Octanove C1/C2 词表、ECDICT 释义；短文节选自本站文章，题目为原创。'),
    );
    focusHead();
  }

  // ---------------------------------------------------------------- entry
  const rq = Number(query.get('r'));
  const saved = rq ? getLevelResults().find((x) => x.takenAt === rq) : undefined;
  if (saved) renderResult(saved);
  else renderHome();
  if (rq && !saved) toast('没有找到这条自测记录');
  const off = onChange((w) => { if (!inTest && (w === 'all' || w === 'levelTest') && !root.querySelector('#lt-result')) renderHome(); });
  return () => { off(); setKeys(null); };
}

