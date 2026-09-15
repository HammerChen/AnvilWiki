# Spec: Fallback 页 SEO 信号收敛(noindex + sitemap 排除)

- 日期:2026-09-15
- 状态:已实施(随 v2.27.0)
- 来源:群友「誓言」提交的外部代码审查报告(2026-09-15,总评 8.5/10)——P1 发现,当日核实属实并发版修复。致谢落位:README 中英 Credits 段、docs/README 致谢节、landing footer credits(en+zh)、CHANGELOG、roadmap 候选池来源标注。

## 1. 问题(审查报告 P1,dist 实证)

非默认语言访问不存在的文章时,模板回退渲染英文(PRD §9.3,详情页可达性铁律),生成 fallback URL(如 `/ja/bosses/stormcaller/`,demo 站共 7 个:en 9 篇 − ja 真实覆盖 2 篇)。修复前这些页面同时:

1. self-canonical(BaseLayout 无条件 `canonical = Astro.url.pathname`);
2. 在 sitemap 中(@astrojs/sitemap 按构建产物收录,filter 只排 frontmatter-noindex 与空列表页);
3. `<html lang="en">`(ArticlePage 传 `contentLocale={servedLocale}`);
4. hreflang 仅声明 `en` + `x-default`(页面侧早已按真实覆盖,astro.config 的 coverage 注释记载了这半边的刻意设计)。

结果:Google 看到两个 self-canonical、都被 sitemap 提交的重复英文 URL——hreflang 半边做对了,canonical/sitemap 半边是真实缺口。

## 2. 方案取舍

| 方案 | 评估 |
| --- | --- |
| **noindex + 移出 sitemap(采纳)** | 与 v2.4.0 空列表页先例同一模式;基础设施三件全现成(BaseLayout `noindex` prop / sitemap `noindexPaths` filter / 契约测试);fallback URL 保持人类直达可达,翻译落地后 `isFallback` 翻转 false 自动恢复索引(自愈);Pagefind 1.5.2 尊重 noindex,重复英文条目顺带退出站内搜索(改善)。 |
| canonical 指向英文源(否决) | 需给 BaseLayout 新增 canonical 覆盖 prop(新机制);对 Google 的索引效果与 noindex 基本等价,不划算。 |
| 保持 self-canonical(否决) | 重复内容信号持续累积,即报告所指问题本身。 |

## 3. 实现

1. **`src/lib/fallback-paths.ts`(新,零 import)**:`fallbackDetailPaths(coverage, locales, defaultLocale)` 从 coverage(`"cat/slug"` → 真实拥有 MDX 的 locale 集合)推导全部 fallback URL 原始路径。零 import 是硬约束:astro.config.ts 在 config-time 加载它,此时 vite `~` 别名尚不存在。
2. **`astro.config.ts`**:walk 后把推导结果并入 `noindexPaths`;删除旧「仅 en-noindex 文章补 fallback 排除」的 `fs.existsSync` 分支(新规则是其超集)。
3. **`ArticlePage.astro`**:`noindex={entry.data.noindex || isFallback}`(LocaleLayout 经 `...rest` 透传 BaseLayout,渲染 `noindex, nofollow`)。
4. **rss.xml / llms.txt 零改动**:只按真实 MDX entry 生成,fallback 非独立 entry。

## 4. 验证(v2.27.0 批内实测)

- 八门禁全绿;test 259→264(fallbackDetailPaths 单测 + astro.config/ArticlePage wiring 契约)。
- dist:7 个 fallback URL 全部 `noindex, nofollow`;2 个真实 ja 翻译页(emberfang/all-codes)保持索引;en canonical 页零变化;sitemap 仅剩真实 ja 文章 URL。
- 构建日志:astro-icon「Failed to load icons」与「Entry … was not found.」两类警告清零(后者根因=getEntry 对缺失 id 必 warn,getEntryWithFallback 改 getCollection 建 map 匹配,同文件 4 个 helper 先例)。

## 5. 有意不做

- canonical 覆盖 prop(见 §2)。
- 对 fallback URL 做 404/重定向:违背 PRD §9.3 可达性(社交分享的直链永不断)。
- ja 文章覆盖率 2/9:demo 有意为之(主英文 + ja 样例,fork 用户整体替换内容),运营指标不立项。
