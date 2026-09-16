# AnvilWiki 扩展路线图 v1.5 / v1.6(Draft)

> 2026-08-15 专家团 4 视角审计(产品/SEO/创作者体验/可持续变现)产出。
> 状态:**已交付**——v1.5/v1.6(及后续 v1.7)均已实现发版,主线见 [roadmap.md](../roadmap.md) 演化表与 CHANGELOG。本文件保留为决策存档。

## 设计原则(全程不变)

- 纯 Astro 零 JS runtime,守住 Lighthouse 4×100 开箱契约
- 一切可选功能 = env 门控 + 默认关闭(与 AdSense/Giscus 同模式)
- Code/Config/Content 三层分离不被破坏
- 不触碰既有"不做"清单:社区运营、课程引用、comparison-table 交互、非 AdSense 广告网络、多 niche 架构改造

---

## v1.5.0「内链 + 时效性 + 表达力」(全部 S 级,一次发版)

主题:让已有的数据(tags、lastModified、videos)开始干活,补齐 wiki 最高频的内容表达组件。

| # | 功能 | 内容 | 涉及层 |
|---|------|------|--------|
| 1 | 标签系统落地 | `/[locale]/tags/` 索引页 + `/[locale]/tags/[tag]/` 聚合页;文章页 tag 从 `<span>` 改为链接;进 sitemap;demo 文补 tags | Code+Content |
| 2 | 游戏版本号 | frontmatter `gameVersion: z.string().optional()`;ArticlePage/BossStatCard 徽章展示;配合"90 天未更新"提示提升精度 | Code+Content |
| 3 | 最近更新页 | `/[locale]/recent`(复用 `getRecentEntries` + ListPage);nav 可选入口 | Code |
| 4 | Callout 提示框组件 | `<Callout type="info|warn|tip|danger">`,MDX 可用,零 JS,lucide 图标,样式走 `--brand` 变量 | Code |
| 5 | 折叠面板组件 | `<Accordion>`/原生 `<details>` 样式化,用于多阶段打法/剧透/平台差异 | Code |
| 6 | draft 草稿机制 | schema `draft: z.boolean().default(false)`;dev 可见、build 过滤;new-post 支持 `--draft` | Code |
| 7 | VideoObject JSON-LD | `lib/seo.ts` 加 builder,文章页由 `videos` frontmatter 生成 | Code |
| 8 | 404 页增强 | Pagefind 搜索框 + 热门文章/分类入口 | Code |
| 9 | 赞助/打赏 | `.github/FUNDING.yml` + env 门控 `SponsorCard.astro`(`PUBLIC_SPONSOR_URL`/`PUBLIC_SPONSOR_IMAGE_URL` 空 = 不渲染) | Code+Config |
| 10 | wrangler 引导闭环 | apply-template CLI 增加一步:提示写入 `[vars]` 或选择删除 wrangler.toml;README Deploy 按钮与 Pages 文档流程对齐 | Config+scripts |

配套:README/CHANGELOG/docs(content-format 补 Callout/Accordion/gameVersion/draft 章节)、tests 补 ads/sponsor 门控回归测试、demo 内容补 tags 与 gameVersion 示例。

---

## v1.6.0「创作者维护工具 + 部署自动化」(M 级为主)

主题:把"30 分钟部署"从文档承诺变成一键现实,把多语言维护从人肉变成脚本。

| # | 功能 | 内容 | 涉及层 |
|---|------|------|--------|
| 1 | 翻译覆盖率检查 | `pnpm check-i18n`:各 locale 相对 en 的文章缺失清单 + `src/locales/*.json` key diff + frontmatter 漂移;接入 CI | Code |
| 2 | GitHub Actions 一键初始化 | fork 后跑一次 setup workflow:写 SITE_URL、处理 wrangler.toml、可选清 demo 内容 | Config |
| 3 | apply-template 内容层自动化 | demo 内容清理 + 骨架文生成,消除 fork 后最大手动删改面积 | scripts+Content |
| 4 | 死链/内链检查 | check-sitemap 扩展:MDX 正文相对链接 ↔ 实际条目 slug 对账 | Code |
| 5 | Cloudflare Web Analytics | `PUBLIC_CF_BEACON_TOKEN` 门控(BaseLayout),零脚本损耗的 GA 替代 | Code+Config |
| 6 | fork 同步上游指南 | docs/staying-up-to-date.md + 版本策略说明(SemVer、config 层兼容承诺) | docs |
| 7 | README 获客强化 | CompareTable 进 README、仓库 topics、英文 FAQ、demo 内容加密(1-2 篇 tier-list 范式) | Content |
| 8 | 真实用户 Showcase | "用了模板?提 PR 加到 showcase"区块,被动征集不运营 | landing |

## v1.7+(按真实用户反馈触发,现在不排期)

- og:image 自动生成(satori,M)
- 图片画廊 + lightbox + ImageObject schema(M-L)
- 多作者体系 / authors collection(M)
- 对比表/掉落表 MDX 组件(M)
- 独立文档站 dogfooding,docs.anvilwiki.dev(PRD 15.3 伏笔)
- 联盟链接组件 AffiliateLink.astro(M)
- PWA 离线(M,需轻量 precache 保 Lighthouse)
- 地图/坐标组件、difficulty 字段、内容 lint(H1 禁用等)——低优先
