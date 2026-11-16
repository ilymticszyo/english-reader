# English Reader（英语分级阅读）

纯静态的英语分级阅读网页：B1 / B2 / C1 三个级别，点词即查 ECDICT 中文词典（带词形还原、音标、浏览器 TTS 发音），生词本与阅读进度存在 `localStorage`。无后端、无账号。

> 当前状态：**里程碑 M1**——骨架 + 15 篇 AI 生成示例文章（每级 5 篇），主流程已跑通。

## 快速开始

```bash
npm install
npm run dev        # 生成数据 + 启动 Vite 开发服务器
npm run build      # 生成数据 → 类型检查 → vite build，输出 dist/
npm run preview    # 本地预览 dist/
npm test           # 词形还原回归 + 端到端测试（需先 npm run build）
npm run screenshots
```

要求 Node ≥ 22.18（构建脚本直接运行 `.ts`，Node 24 已验证）。

第一次 `npm run data`（`build`/`dev` 会自动执行）会从 GitHub 下载 ECDICT 的 `ecdict.csv`（约 66 MB）到 `data-src/ecdict.csv`（已 gitignore）。也可用环境变量 `ECDICT_CSV=/path/to/ecdict.csv` 指向本地文件。

### 部署 / 路径

`vite.config.ts` 默认 `base: './'`，数据用相对路径加载，路由用 hash（`#/read/b1-001`），所以 `dist/` 可以放在任意 HTTPS 静态托管的根目录或子目录。需要固定子路径时：`BASE_PATH=/english-reader/ npm run build`。`.github/workflows/deploy.yml` 是现成的 GitHub Pages 工作流（未在真实仓库中验证）。

## 目录结构

```
content/
  articles/*.md           文章源文件（frontmatter + 正文，段落以空行分隔）
  proper-nouns.json       白名单：ECDICT 缺失的专名 / 生造术语 → 简短中文说明
  lemma-overrides.json    手工词元修正（ECDICT exchange 数据有误时）
data-src/
  ecdict.csv              （gitignore，自动下载）
  cefr/                   CEFR-J 词表 + Octanove C1/C2 词表（用于词的 CEFR 等级）
scripts/
  build-data.ts           构建期数据管线：解析文章 → 分词 → 词元还原 → 裁剪词典 → 校验 → 输出 JSON
  lib/ecdict.ts, articles.ts
  test-lemma.ts           词形还原回归测试（用完整 ECDICT）
  e2e.mjs                 Playwright 端到端测试；screenshots.mjs 截图；static-server.mjs
src/
  shared/text.ts          分词 + 词元解析（构建脚本与浏览器共用同一份代码）
  shared/types.ts
  main.ts, router.ts, store.ts(localStorage), data.ts, popup.ts, tts.ts, dom.ts
  views/list.ts reader.ts words.ts settings.ts
  style.css
tests/lemma-cases.json    回归用例
public/data/              （生成物，gitignore）index.json、articles/*.json、dict/forms.json、dict/entries-{b1,b2,c1}.json
screenshots/              M1 截图
```

## 数据与词典

- `public/data/dict/forms.json`：词形 → 词元（只含「词形 ≠ 词元」的项，来自 ECDICT 的 `exchange` 字段：自身的 `0:` 指向词元，或由词元的 `p/d/i/3/s/r/t` 反查）。
- `entries-b1|b2|c1.json`：按「该词条首次出现的最低级别」分片。读 B1 文章只加载 b1 片，读 C1 文章加载 b1+b2+c1。
- 构建失败条件：任何文章里的词在词典中查不到；运行时解析结果与构建期不一致；需要靠后缀规则兜底；某级别文章数不足（`build.config.json` 的 `expectedPerLevel`，M1 为 5，量产时改为 100）。
- 词数、平均句长、词汇覆盖率不达标时输出**警告**（M1 用于校准阈值）；`node scripts/build-data.ts --strict` 会把警告变成错误。
- 报告：`reports/coverage.json`（gitignore）。

## 版权与来源

- 词典：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT，见 `data-src/ECDICT-LICENSE`）。
- CEFR 等级：[CEFR-J Wordlist 1.5](http://www.cefr-j.org/)（东京外国语大学 Tono 研究室，需署名）+ Octanove C1/C2 词表（CC BY-SA 4.0）。详见 `data-src/cefr/CEFR-README.md`。若将来公开发布，需要在站点上署名。
- 示例文章：均为 AI 生成的原创文本，frontmatter 中 `source: ai-generated`。
