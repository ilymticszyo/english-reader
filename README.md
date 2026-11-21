# English Reader（英语分级阅读）

纯静态的英语分级阅读网页：B1 / B2 / C1 三个级别，点词即查 ECDICT 中文词典（带词形还原、音标、浏览器 TTS 发音），生词本与阅读进度存在 `localStorage`。无后端、无账号。

> 当前状态：**M3 第 4 批（完成）**——主流程 + 离线（Service Worker）+ 设置/备份/关于页，300 篇 AI 生成文章（B1 / B2 / C1 各 100 篇）。

> 分词规则：年代写法（1870s、'90s、1920s）是**单个非词记号**：不计入字数与覆盖率，阅读器里也不可点击（不会再被拆成 `s`）。

## 快速开始

```bash
npm install
npm run dev        # 生成数据 + 启动 Vite 开发服务器
npm run build      # 生成数据 → 类型检查 → vite build → 生成 sw.js，输出 dist/
npm run package    # build + 把 dist/ 打包成 english-reader-dist.zip
npm run preview    # 本地预览 dist/
npm test           # 词形还原回归 + 单元测试（阅读记录/备份）+ 端到端测试（需先 npm run build）
npm run test:unit  # 只跑阅读记录 / 备份格式的单元测试
npm run screenshots
```

要求 Node ≥ 22.18（构建脚本直接运行 `.ts`，Node 24 已验证）。

第一次 `npm run data`（`build`/`dev` 会自动执行）会从 GitHub 下载 ECDICT 的 `ecdict.csv`（约 66 MB，固定到某个 commit 并校验 sha256）到 `data-src/ecdict.csv`（已 gitignore）。也可用环境变量 `ECDICT_CSV=/path/to/ecdict.csv` 指向本地文件。

### 试用 / 部署

- `npm run package` 生成 `english-reader-dist.zip`（解压后根目录就是 `index.html`）。**必须通过 http(s) 打开**，不能双击 `index.html`（`file://` 下无法加载数据和 Service Worker）：
  `cd 解压目录 && python3 -m http.server 8080`，再打开 http://localhost:8080/ 。zip 里附有 `TRY-IT.txt`。
- `vite.config.ts` 默认 `base: './'`，数据和 Service Worker 都用相对路径，路由用 hash（`#/read/b1-001`），所以 `dist/` 放在任意 HTTPS 静态托管的根目录或子目录都能用。需要固定子路径时：`BASE_PATH=/english-reader/ npm run build`。
- **GitHub Pages**：`.github/workflows/deploy.yml` 在 push 到 `main` 时构建并发布。仓库里一次性设置：Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。发布后的地址是 `https://<用户名>.github.io/<仓库名>/`。

### 离线

`npm run build` 的最后一步（`scripts/make-sw.mjs`）生成 `dist/sw.js` 和 `dist/version.json`：Service Worker 预缓存应用壳和全部文章 / 词典分片（约 600 KB），首次访问后断网也能完整使用。注册路径是相对的（`./sw.js`），在 GitHub Pages 子路径下作用域就是该子路径。版本号 = `package.json` 的 version + 全部文件内容的哈希（同样的内容总是同一个版本号）。设置页显示版本号和离线状态。

**更新流程**：新版本在后台安装并等待，**不会**在阅读过程中自动接管页面（Service Worker 里没有无条件的 `skipWaiting`）。检测到新版本时页面顶部出现一条小提示“有新版本，点击刷新”；只有点它，等待中的 Service Worker 才会激活，页面随即重新加载一次，旧缓存被删除。点“✕”可以先忽略，下次打开应用时仍会提示。

## 每批文章的工作流（M3 量产时用）

1. 把新文章放进 `content/articles/`（`b1-006.md` …，frontmatter 同现有文章）。`build.config.json` 里的 `expectedPerLevel` 是每级的最低篇数（现为 100，M3 已完成）。
2. `npm run build`。**只有这些会让构建失败**：文章元数据不合法 / id 或标题重复 / 某级别篇数不足 / 有词在 ECDICT 里完全查不到、也不在 `terms` 里（报错信息 `NO DEFINITION`）/ 构建期与运行时词元解析不一致。
3. 打开 `reports/build-report.md`（每次构建都会重新生成，不进 git），逐项过一遍：
   - **Calibration flags**：词数、平均句长、词汇覆盖率（B1/B2 ≥ 97%，C1 ≥ 94%）不达标的文章。只做标记供人工复核，**不拒收**；决定是重写、放行还是调阈值（`build.config.json`）。
   - **fallback**：ECDICT 不认识的词形，词元是按后缀规则猜的 → 确认后写进 `lemma`，或是专名就写进 `terms`。
   - **form-more-common-than-lemma**：被点的词比它的“词元”更常见且有独立义项（例如 number→numb）→ 很可能错了，在 `lemma` 里改成它自己。
   - **ambiguous**：ECDICT 有多个候选词元（lives→life/live），默认取最常见的；不合适就在 `lemma` 里指定。
   - **lexicalized-ing-candidate**：有独立名词义、但目前还显示动词的 -ing 词 → 如果名词义才是常用义，加进 `lexicalizedIng`。
   - **hyphen**（仅供参考）：连字符词 ECDICT 没有整词时，卡片会按顺序列出每个组成部分的释义（如 well-explained → well + explain）；整词在 ECDICT 里就直接显示整词。只有当一句合并释义明显更好时才加进 `terms`。某个部分查不到释义会报 `NO DEFINITION`（构建失败）。
   - **no-cefr**：词元不在 CEFR 词表里（只影响覆盖率统计）。
4. 所有人工修正只改一个文件：`content/lemma-overrides.json`，区块有 `lemma / lexicalizedIng / lexicalizedAdj / formSelfFirst / cefr / leadDefs / terms`：
   - `lemma`：`{"number": "number", "are": "be"}`——形 → 词元（写成自己表示“它自己就是词元”）。
   - `lexicalizedIng`：词汇化的 -ing 名词（building、meeting、morning、feeling、painting、wedding、ceiling…）。这些词主卡显示它自己的词条，动词词元（build）的词条折叠在下方。**不在这个名单里的 -ing 词保持原行为（running → run）**；不做上下文词性判断。
   - `lexicalizedAdj`：词汇化的形容词性分词（tired、scared、boring、interested、excited、surprised、worried、complicated、amazing…）。机制与 `lexicalizedIng` 相同：主卡显示这个词自己的（形容词）词条，动词词元（scare）的词条折叠在下方，生词本以这个词本身为键；覆盖率按这个词自己的 CEFR 等级算。只收“形容词义明显占主导”的词；动词性分词（written、given、closed…）和 -ing 动名词（running…）不在其中，保持原行为。
   - `formSelfFirst`：**词形自己的词条优先**的特例词（目前 fireworks、phonics、scissors、born、later）。这些词的“词形”本身就有独立词条，且比词元（firework、phonic、scissor、bear、late）更常用或意思不同：主卡先显示词形自己的词条，词元的词条折叠在下方，生词本以词形本身为键；CEFR 如果词形自己没有就回退到词元。**以后遇到类似的词（构建报告里的 `form-more-common-than-lemma`，例如 bacteria、crooked 等）就加进这里**，并在 `tests/lemma-cases.json` 的 `formSelfFirstCases` 补一条用例（`npm run test:lemma` 会检查每个词都满足上述行为）。与 `lexicalizedIng/Adj` 在机制上一致，只是用途不同，三个名单内部合并处理。
   - `cefr`：人工指定的 CEFR 等级（如 `"according": "B1"`），优先于词表。**回退规则**：词汇化词（`lexicalizedIng` / `lexicalizedAdj` / `formSelfFirst`）如果自己没有 CEFR 等级，覆盖率和词条徽章回退使用它的动词词元的等级（如 disappointed → disappoint）。
   - `leadDefs`：给某个词条在最前面加一条释义（如 according 先显示“according to：根据…”，再显示动词 accord 的折叠词条）。
   - `terms`：ECDICT 没有的专名、生造或专业术语 → 一句中文释义。
5. 改完重新 `npm run build`，再 `npm run test:lemma`。有新的易错词就补进 `tests/lemma-cases.json`。

## 名著赏析（#/classics）

顶部导航「名著」，独立于 B1/B2/C1 三个分级池（不计入覆盖率门禁，构建报告里只做参考统计）。共 100 篇公版名著选段（Project Gutenberg；参考级别 B1 32 · B2 35 · C1 33，共 76 位作者），每篇：英文导读 Background → 原文 The Excerpt → 本篇注释 → 英文赏析 Appreciation → Sentences to imitate（3–5 句原文仿写句）。

- 源文件：`content/classics/cl-NNN.md`（frontmatter 含 `edition: Project Gutenberg #N`、`url`、`year`、`pdNote`、`pdVerified: true`，缺一即构建失败）；注释行 `- form | English note | 中文` 或 `- form => 词典词 | note | 中文`（方言/误导词指向正确词条）。
- 共用古旧词表：`content/classics/archaisms.json`（thee, hath, 'tis, o'er …）；名著专用人名地名：`content/classics/terms.json`（只进名著词典，不影响文章）。
- 原文抽取：`PG_DIR=<存放 pgN.txt 的目录> node scripts/classics-extract.mjs fill` 按 frontmatter 的 `sourceStart`/`sourceEnd` 重新生成 `## Excerpt`（去掉 PG 页眉页脚、插图说明、`_斜体_` 标记）。
- 构建输出 `public/data/classics/{index.json, cl-NNN.json, archaisms.json, dict.json}`；`dict.json` 只含主词典缺少的词形/词条。Service Worker 自动预缓存，`version.json` 中有 `classics` 计数。
- 截图：`node scripts/screenshots-classics.mjs` → `screenshots/classics-*.png`。

## 阅读记录（0.6.0）

- **已读标记**：读到文末自动标记已读（设置里可关），文章/名著页顶部和文末的按钮可手动标记或改回未读。
- **列表**：B1/B2/C1 文章列表和名著列表的卡片上有「✓ 已读」徽标；「只看未读」复选框隐藏已读的（在读的仍显示），可与话题/状态/作者/难度筛选叠加。
- **进度**：文章列表、名著列表和设置页都显示四条进度线：B1、B2、C1、名著（已读 X / 100）。只统计当前内容里存在的 ID。
- **阅读位置**：在读的文章/选段记住滚动位置（正文的比例，不是像素），重新打开时恢复。
- **存储**：仍是 `localStorage` 的 `ra:v1:progress`，按文章 ID（`b1-001` / `cl-001` …）为键：`{ status: 'unread'|'reading'|'read', scroll: 0..1, updatedAt, readAt? }`。`readAt` 是读完的时间，改回未读时删除。`ra:v1:meta.schema` 从 1 升到 2：旧数据在首次加载时原地迁移（保留所有条目和未知字段，已读条目补 `readAt = updatedAt`），迁移前的原值另存一份在 `ra:v1:progress.bak-v1`。
- **导出**：一个 JSON 文件 `{ schema: 2, app: 'english-reader', exportedAt, history, vocab, settings }`——`history` 就是上面的阅读记录，`vocab` 是生词本。（0.7.0 起为 schema 3，多一个 `review`，见下节。）
- **导入**：只合并，不覆盖。生词按原规则合并（次数取大、例句合并、两边都掌握才算掌握）；阅读记录逐篇取较新的那次改动（所以另一台设备上「改回未读」也会生效），同一时间则取更靠后的状态，`readAt` 取最早。设置不导入。兼容旧文件：schema 1（`progress` 字段或只有 `vocab`）、没有 schema 的 `{ vocab }` 或裸生词本对象；schema 高于当前版本（0.7.0 起为 3）的文件会被拒绝并提示更新。
- 纯逻辑在 `src/shared/history.ts`，单元测试 `scripts/test-unit.ts`；截图 `node scripts/screenshots-history.mjs` → `screenshots/history-*.png`。

## 生词复习（0.7.0，#/review）

- **入口**：首页（文章列表）和生词本页都有「今日待复习 N 个」（到期 X · 新词 Y），点进 `#/review`。导航仍高亮「生词本」。
- **闪卡**：正面只有单词 + 🔊 朗读（Web Speech API；浏览器不支持时不显示按钮，并提示“当前浏览器不支持朗读”）。翻面显示音标、词典释义（最多 5 条，词典没加载完时先用收词时的快照）、收词时的原文例句（收词时点的词形高亮），以及「出自：文章标题」链接，回到原文并高亮那句；有多条例句时其余折叠。翻面后还可以点「已经掌握，不再复习」（可撤销）。
- **评分**：忘了 / 模糊 / 记得 / 简单，按钮上显示下次间隔。快捷键：空格（或回车）翻面，1–4 评分。手机上评分按钮固定在屏幕底部。
- **排期（简化 SM-2，按天）**：初始 ease 2.5，范围 1.3–3.0；忘了 −0.2、模糊 −0.15、记得 ±0、简单 +0.15。
  - 新词（或刚忘记的词）：忘了 → 今天（本轮稍后再出现一次），模糊 / 记得 → 1 天，简单 → 4 天；
  - 第二次答对：模糊 2、记得 3、简单 6 天；
  - 之后：模糊 = 上次 × 1.2，记得 = 上次 × ease，简单 = 上次 × ease × 1.3（都至少比上次多 1 天，上限 365 天）；
  - 忘了（遗忘）：reps 清零、`lapses` +1（新词第一次就忘不算遗忘），重新从 1 天开始。
  - 新间隔从实际复习那天算起（拖延复习不会让间隔虚涨）。
- **“今天”按本地日历日**：`due` 存成本地日期 `YYYY-MM-DD`（不是时间戳），到本地零点才算到期；换时区或夏令时不会让卡片提前或推迟几个小时。
- **今日待复习** = 已到期的复习卡（不限数量，最早到期的先出）+ 还没复习过的新词（最早收录的先出，每天最多引入 20 个新词）。已掌握的词不复习、不计数。
- **筛选**（写在 URL 里，可以收藏：`#/review?pool=B1&cefr=B2&a=b1-002`；三项同时生效）：
  - 来源 `pool`：B1 / B2 / C1 文章、名著——词的任意一条例句来自该处即算；没有例句的词只在「全部来源」里；
  - 词汇等级 `cefr`：A1–C2 或「无等级」（词典里这个词本身的 CEFR）；
  - 文章 `a`：某一篇文章 / 名著选段（下拉列表只列出当前来源下、出现在未掌握生词例句里的文章，带标题）。
  - 新词每日上限是全局的（不同筛选共用）。
- **存储**：`localStorage` 的 `ra:v1:review`，按生词本的词为键：`{ due: 'YYYY-MM-DD', interval, ease, reps, lapses, lastGrade: 0..3, updatedAt, firstDay? }`（`firstDay` 是第一次复习的日期，用于新词每日上限）。生词本里没有复习记录的词就是新词。
  - `ra:v1:meta.schema` 从 2 升到 3：只新增 `ra:v1:review`（已有的保留），生词本和阅读记录不变；升级前的 meta 另存在 `ra:v1:meta.bak-v2`。从 schema 1 升级的仍会先做阅读记录迁移并留 `ra:v1:progress.bak-v1`。
  - 从生词本移除一个词会同时删除它的复习记录（「撤销」会连复习进度一起恢复）；加载、导入、导出时都会清掉生词本里已没有的词的复习记录，所以不会留下孤立的待复习卡。标为「已掌握」的词保留复习记录，取消掌握后按原排期继续。
- **导出 / 导入**：`{ schema: 3, app: 'english-reader', exportedAt, history, vocab, review, settings }`。导入仍只合并：复习记录逐词取 `updatedAt` 较新的那条（相同时取 reps 更多的）；文件里生词本没有的词的复习记录会被丢弃。schema 2（0.6.0）、schema 1 和没有版本号的旧生词本文件照常合并，本机的复习数据不变，新词成为新卡。
- **离线**：复习页打包在主程序里，Service Worker 预缓存全部文件和词典，断网也能复习、评分。
- 纯逻辑在 `src/shared/review.ts`（单元测试 `scripts/test-unit.ts`），页面 `src/views/review.ts`、`src/views/due.ts`；截图 `node scripts/screenshots-review.mjs` → `screenshots/review-*.png`（只写自己的文件，不删别的截图）。

## 目录结构

```
content/
  articles/*.md           文章源文件（frontmatter + 正文，段落以空行分隔）
  lemma-overrides.json    所有人工修正的唯一入口：lemma / lexicalizedIng / lexicalizedAdj / formSelfFirst / cefr / leadDefs / terms
data-src/
  ecdict.csv              （gitignore，自动下载）
  cefr/                   CEFR-J 词表 + Octanove C1/C2 词表（用于词的 CEFR 等级）
scripts/
  build-data.ts           构建期数据管线：解析文章 → 分词 → 词元还原 → 裁剪词典 → 校验 → 输出 JSON + 报告
  make-sw.mjs, sw-template.js  生成 Service Worker 预缓存清单
  package-zip.mjs         打包 dist → english-reader-dist.zip
  lib/ecdict.ts, articles.ts
  test-lemma.ts           词形还原回归测试（用完整 ECDICT）
  e2e.mjs                 Playwright 端到端测试；screenshots.mjs 截图；static-server.mjs
src/
  shared/text.ts          分词 + 词元解析（构建脚本与浏览器共用同一份代码）
  shared/types.ts
  shared/history.ts       阅读记录 + 备份格式（纯函数）
  shared/review.ts        生词复习：间隔重复排期、今日待复习、筛选、复习数据合并（纯函数）
  main.ts, router.ts, store.ts(localStorage), data.ts, popup.ts, tts.ts, dom.ts, pwa.ts, backup-ui.ts
  views/list.ts reader.ts words.ts review.ts due.ts settings.ts about.ts classics.ts classic-reader.ts history.ts
  style.css
tests/lemma-cases.json    回归用例
public/data/              （生成物，gitignore）index.json、articles/*.json、dict/forms.json、dict/entries-{b1,b2,c1}.json
screenshots/              截图（npm run screenshots）
```

## 数据与词典

- `public/data/dict/forms.json`：词形 → 词元（只含「词形 ≠ 词元」的项，来自 ECDICT 的 `exchange` 字段：自身的 `0:` 指向词元，或由词元的 `p/d/i/3/s/r/t` 反查）。
- `entries-b1|b2|c1.json`：按「该词条首次出现的最低级别」分片。读 B1 文章只加载 b1 片，读 C1 文章加载 b1+b2+c1。
- 构建失败条件和报告说明见上面的“每批文章的工作流”。报告输出到 `reports/build-report.md` 和 `.json`（gitignore）。

## 版权与来源

- 词典：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT，见 `data-src/ECDICT-LICENSE`）。
- CEFR 等级：[CEFR-J Wordlist 1.5](http://www.cefr-j.org/)（东京外国语大学 Tono 研究室，需署名）+ Octanove C1/C2 词表（CC BY-SA 4.0）。详见 `data-src/cefr/CEFR-README.md`。若将来公开发布，需要在站点上署名。
- Octanove C1/C2 词表是 CC BY-SA 4.0：站内“关于与致谢”页（`#/about`）已写明署名和许可；词典分片里 C1/C2 的 `cefr` 字段派生自该词表。
- 示例文章：均为 AI 生成的原创文本，frontmatter 中 `source: ai-generated`；列表页不显示该标记，仅在文章页底部有一行小字。
