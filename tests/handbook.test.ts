/**
 * Handbook parity + frontmatter gate (docs/handbook/{en,zh}/*.md).
 *
 * The in-site docs center renders zh chapters at /zh/landing/docs with
 * hreflang pairs pointing at the en version — a missing half would produce
 * a lying hreflang or a dead alternate. 1:1 parity is therefore a hard
 * requirement, enforced here (build-time Zod covers field TYPES, this test
 * covers language PAIRING + ordering sanity).
 *
 * Pure fs scan (no astro:content under Vitest — see lib/url notes).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chaptersForLocale,
  shortTitle,
  handbookPath,
  manualListRows,
  parseHandbookId,
  prevNext,
  sortChapters,
  type ChapterLike,
} from '~/lib/handbook';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HANDBOOK_DIR = path.resolve(ROOT, 'docs/handbook');

function listChapters(locale: string): string[] {
  const dir = path.join(HANDBOOK_DIR, locale);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

function readFrontmatter(locale: string, file: string): Record<string, string> {
  const raw = fs.readFileSync(path.join(HANDBOOK_DIR, locale, file), 'utf8');
  const fm = raw.split('---')[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe('handbook: en/zh parity (hard requirement)', () => {
  it('zh chapters mirror en chapters slug-for-slug', () => {
    expect(listChapters('zh'), 'every en chapter must have a zh twin (and vice versa)').toEqual(
      listChapters('en'),
    );
  });

  it('en and zh twins share manual + order', () => {
    for (const file of listChapters('en')) {
      const en = readFrontmatter('en', file);
      const zh = readFrontmatter('zh', file);
      expect(zh.manual, `${file}: manual differs between locales`).toBe(en.manual);
      expect(zh.order, `${file}: order differs between locales`).toBe(en.order);
    }
  });

  it('frontmatter carries the required fields', () => {
    for (const locale of ['en', 'zh']) {
      for (const file of listChapters(locale)) {
        const fm = readFrontmatter(locale, file);
        for (const key of ['title', 'description', 'manual', 'order']) {
          expect(fm[key], `${locale}/${file}: missing "${key}"`).toBeTruthy();
        }
        expect(['learn', 'dev'], `${locale}/${file}: manual must be learn|dev`).toContain(
          fm.manual,
        );
      }
    }
  });

  it('order is unique within each manual', () => {
    for (const locale of ['en', 'zh']) {
      const seen = new Map<string, string>();
      for (const file of listChapters(locale)) {
        const fm = readFrontmatter(locale, file);
        const key = `${fm.manual}:${fm.order}`;
        expect(seen.has(key), `${locale}/${file}: duplicate order ${key} (also ${seen.get(key)})`)
          .toBe(false);
        seen.set(key, file);
      }
    }
  });
});

describe('shortTitle: nav label derivation', () => {
  it('takes the text before the first colon', () => {
    expect(shortTitle('去哪挖候选:每天 20 分钟,把候选池填到 10 个')).toBe('去哪挖候选');
    expect(shortTitle('Run Your Site: See It Working in Three Steps')).toBe('Run Your Site');
  });

  it('prefers the earliest colon and handles full-width colons', () => {
    expect(shortTitle('A:B:C')).toBe('A');
    expect(shortTitle('开广告：时机与接入')).toBe('开广告');
  });

  it('appendix dot rule: keeps the part after " · "', () => {
    expect(shortTitle('附录 A · 作死红线总检查表')).toBe('作死红线总检查表');
    expect(shortTitle('Appendix A · The Red-Line Master List')).toBe('The Red-Line Master List');
  });

  it('falls back to the full title', () => {
    expect(shortTitle('加栏目与加语言')).toBe('加栏目与加语言');
  });

  it('frontmatter override wins when non-empty', () => {
    expect(
      shortTitle('让 AI 替你运营:GSC 数据接入、metrics 与 MCP', 'AI 运营与 GSC 接入'),
    ).toBe('AI 运营与 GSC 接入');
    expect(shortTitle('Run Ops with AI: GSC setup, metrics & MCP', 'AI ops & GSC setup')).toBe(
      'AI ops & GSC setup',
    );
  });

  it('blank or absent override falls back to derivation', () => {
    expect(shortTitle('Run Ops with AI: GSC setup, metrics & MCP', '   ')).toBe('Run Ops with AI');
    expect(shortTitle('加栏目与加语言', undefined)).toBe('加栏目与加语言');
  });
});

describe('handbook search contract (Pagefind)', () => {
  const src = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), 'utf8');

  it('HandbookChapter opts chapters into the search index', () => {
    // Pagefind's rule: once ANY page on the site marks a data-pagefind-body
    // (ArticlePage does), unmarked pages are excluded from the index
    // entirely. Losing this attribute would silently drop all 41 lessons ×
    // 2 locales out of site search while every gate stays green.
    expect(src('src/components/landing/HandbookChapter.astro')).toContain('data-pagefind-body');
  });

  it('landing content pages opt into the search index (community digest, comparison, landing home)', () => {
    // 2026-09-13 全站搜索批:搜索入口从 docs 页扩到所有 landing 页,内容侧
    // 同步进索引——社群精华页是用户点名的核心诉求(搜群聊精华要能命中)。
    // These are page-level bodies; the floating WeChat QR widget stays
    // unmarked so its card copy never becomes a result.
    expect(src('src/components/landing/CommunityHighlights.astro')).toContain('data-pagefind-body');
    expect(src('src/components/landing/ComparisonPage.astro')).toContain('data-pagefind-body');
    for (const page of ['src/pages/landing.astro', 'src/pages/zh/landing.astro']) {
      const html = src(page);
      expect(html, `${page} marks its sections for Pagefind`).toContain('data-pagefind-body');
      // QR float must sit outside the marked wrapper (never indexed).
      expect(html.indexOf('data-pagefind-body')).toBeLessThan(html.indexOf('<Community'));
    }
  });

  it('LandingLayout ships the search button by default (whole site is searchable)', () => {
    const layout = src('src/components/landing/LandingLayout.astro');
    expect(layout).toContain('search = true');
    // Mobile menu search entry reuses the same dialog as the header trigger.
    expect(layout).toContain('data-open-search');
    // 2026-09-13 移动端无反应修复:SearchButton 直接绑定 [data-open-search]
    // (不再经由布局脚本的 .click() 代理),inline 脚本保持 ES2018 语法可被
    // 老内核(微信 X5/旧 WKWebView)解析——?. 与 ?? 在不可转译的 inline 脚本
    // 里是整段 SyntaxError,搜索全盘失效。锚在 SearchButton 侧,防回退。
    const searchButton = src('src/components/header/SearchButton.astro');
    const inlineScript = searchButton.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(inlineScript).toContain("querySelectorAll('[data-open-search]')");
    expect(inlineScript).not.toMatch(/\?\?|\?\./);
  });

  it('postbuild lowers the Pagefind bundles to ES2018 (old-webview input mount)', () => {
    // pagefind-ui.js ships with optional chaining — a SyntaxError on WeChat
    // X5 / pre-13.4 Safari kernels, so PagefindUI never mounts and the search
    // dialog opens with NO input inside. The postbuild transpile step lowers
    // every dist/pagefind/*.js in place; dropping it silently re-breaks
    // search on those phones while every other gate stays green.
    const pkg = JSON.parse(src('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.postbuild).toContain('node scripts/transpile-pagefind.mjs');
    expect(src('scripts/transpile-pagefind.mjs')).toContain("target: ['es2018']");
    // Per-deploy cache fingerprint: the CF zone clamps browser max-age, so
    // every HTML import of the UI bundle must carry a ?v=<hash> query or
    // fixed bundles take hours to reach returning phones.
    expect(src('scripts/transpile-pagefind.mjs')).toContain('pagefind-ui.js?v=');
    // 2026-09-14 修复:指纹替换只允许命中模板字面量 URL(文件名后随反引号)。
    // 全局盲替换会把 ?v= 注进 bundle 内部的正则字面量(basePath 派生用的
    // import.meta.url.match),`?` 在正则里是量词,注入后该正则对任何 URL
    // 永远失配——当前 esbuild shim 使其惰性,收窄防未来构建形态变化踩雷。
    expect(src('scripts/transpile-pagefind.mjs')).toContain('(?=`)');
    // 2026-09-14 astro 7 迁移:Vite 8 默认 CSS 压缩器(Lightning CSS)会把
    // `@media (min-width:…)` 重写成区间语法(`width>=640px`),2023 年前的内核
    // (旧 X5、Safari <16.4)整条丢弃 = Tailwind 全部断点失效;构建管线钉住
    // esbuild 压缩 + postbuild 对渲染期内联样式(不吃 cssMinify)降级收口。
    expect(src('astro.config.ts')).toContain("cssMinify: 'esbuild'");
    expect(src('scripts/transpile-pagefind.mjs')).toContain('min-$1:');
  });

  it('every is:inline script in src stays ES2018-parseable (old-webview syntax gate)', () => {
    // 2026-09-14 修复批:上一条只锚了 SearchButton 单文件,同日的公告关闭
    // 脚本带着可选链落进产物,微信 X5/pre-13.4 Safari 上整段 SyntaxError,
    // 公告 × 直接失灵——门禁缺的不是纪律而是覆盖面。升级为全仓扫描:任何
    // is:inline 脚本体内不得出现可选链 / 空值合并 / 可选 catch 绑定。
    // 处理型 <script>(Vite 打包转译)不受此约束。
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith('.astro') ? [p] : [];
      });
    const offenders: string[] = [];
    for (const file of walk(path.resolve(ROOT, 'src'))) {
      const content = fs.readFileSync(file, 'utf8');
      const re = /<script[^>]*is:inline[^>]*>([\s\S]*?)<\/script>/g;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(content))) {
        n += 1;
        const hits: string[] = [];
        if (/\?\./.test(m[1])) hits.push('optional chaining');
        if (/\?\?/.test(m[1])) hits.push('nullish coalescing');
        if (/catch\s*\{/.test(m[1])) hits.push('optional catch binding');
        if (hits.length) {
          offenders.push(`${path.relative(ROOT, file)} [script #${n}]: ${hits.join(', ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('manualListRows: stage grouping', () => {
  const ch = (stage?: string) => ({ data: { stage } });

  it('inserts a header only when the stage differs from the previous chapter', () => {
    expect(manualListRows([ch('A'), ch('A'), ch('B'), ch()])).toEqual([
      { type: 'stage', label: 'A' },
      { type: 'chapter', chapter: { data: { stage: 'A' } } },
      { type: 'chapter', chapter: { data: { stage: 'A' } } },
      { type: 'stage', label: 'B' },
      { type: 'chapter', chapter: { data: { stage: 'B' } } },
      { type: 'chapter', chapter: { data: {} } },
    ]);
  });

  it('re-opens the header when a stage resumes after an unstaged chapter', () => {
    const rows = manualListRows([ch('A'), ch(), ch('A')]);
    expect(rows.filter((r) => r.type === 'stage')).toEqual([
      { type: 'stage', label: 'A' },
      { type: 'stage', label: 'A' },
    ]);
  });

  it('renders flat when no chapter has a stage (dev manual)', () => {
    expect(manualListRows([ch(), ch(), ch()])).toEqual([
      { type: 'chapter', chapter: { data: {} } },
      { type: 'chapter', chapter: { data: {} } },
      { type: 'chapter', chapter: { data: {} } },
    ]);
  });
});

describe('lib/handbook pure functions', () => {
  const mk = (id: string, manual: 'learn' | 'dev', order: number): ChapterLike => ({
    id,
    data: { manual, order },
  });
  const list = [
    mk('zh/deploy', 'learn', 5),
    mk('en/pick', 'learn', 1),
    mk('en/deploy', 'learn', 4),
    mk('en/customize', 'dev', 2),
    mk('en/pick2', 'learn', 2),
    mk('en/arch', 'dev', 1),
  ];

  it('parseHandbookId strips .md and rejects junk', () => {
    expect(parseHandbookId('en/pick-your-game.md')).toEqual({ locale: 'en', slug: 'pick-your-game' });
    expect(parseHandbookId('zh/launch')).toEqual({ locale: 'zh', slug: 'launch' });
    expect(parseHandbookId('fr/launch')).toBeNull();
    expect(parseHandbookId('noseparator')).toBeNull();
    expect(parseHandbookId('en/')).toBeNull();
  });

  it('sortChapters: learn before dev, order ascending', () => {
    const sorted = sortChapters(list).map((c) => c.id);
    expect(sorted).toEqual(['en/pick', 'en/pick2', 'en/deploy', 'zh/deploy', 'en/arch', 'en/customize']);
  });

  it('chaptersForLocale filters one locale', () => {
    expect(chaptersForLocale(list, 'zh').map((c) => c.id)).toEqual(['zh/deploy']);
  });

  it('prevNext stays inside the same manual', () => {
    const en = chaptersForLocale(list, 'en');
    // Last learn chapter: has a dev chapter after it globally, but next must be null.
    expect(prevNext(en, 'en/deploy')).toEqual({
      prev: { id: 'en/pick2', data: { manual: 'learn', order: 2 } },
      next: null,
    });
    expect(prevNext(en, 'en/pick2').next?.id).toBe('en/deploy');
    expect(prevNext(en, 'en/customize').next).toBeNull();
    expect(prevNext(en, 'en/arch').prev).toBeNull();
    expect(prevNext(en, 'en/missing')).toEqual({ prev: null, next: null });
  });

  it('handbookPath builds locale-correct URLs', () => {
    expect(handbookPath('en', 'pick-your-game')).toBe('/landing/docs/pick-your-game/');
    expect(handbookPath('zh', 'pick-your-game')).toBe('/zh/landing/docs/pick-your-game/');
    expect(handbookPath('zh', '', true)).toBe('/zh/landing/docs/');
  });
});
