import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';
import icon from 'astro-icon';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { locales, defaultLocale } from './src/i18n/routing';
import { CONTENT_TYPES } from './src/config/navigation';
import { fallbackDetailPaths } from './src/lib/fallback-paths';

/**
 * Build a map of page path → lastmod ISO date, read from MDX frontmatter
 * (`lastModified` falling back to `date`). Used by the sitemap `serialize`
 * hook so Google gets the one sitemap field it actually trusts for crawl
 * scheduling (Google Search Central docs).
 *
 * Also collects `noindex: true` article paths — pages excluded from search
 * must not appear in the sitemap (rss.xml/llms.txt already filter them; this
 * closes the loop for the third generator). Same for English-fallback detail
 * URLs (/{locale}/… serving the default-locale article): the page renders
 * noindex via `resolved.isFallback`, so they are derived from `coverage` and
 * excluded here too (see fallbackDetailPaths).
 *
 * Also builds `coverage`: "category/slug" → locales that REALLY have an MDX
 * for it. The sitemap alternates must mirror the page-level hreflang truth:
 * a /ja/… URL that serves the English fallback declares only `en` in its
 * <head>, so the sitemap must not claim a ja version exists either — Google
 * discards conflicting hreflang clusters, which would silently undo the
 * per-page logic on exactly the duplicated-content URLs that need it most.
 *
 * Also builds `categoryCoverage`: category → locales with ≥1 published MDX.
 * (category × locale) list pages with zero articles are thin-content empty
 * states (ListPage renders them noindex) — they are excluded from the
 * sitemap here, and the list-page alternates only advertise covered locales
 * (mirroring localesForCategory on the page side).
 *
 * Plain fs scan at config time — `astro:content` is not importable here.
 */
/**
 * Extract the frontmatter block (between the opening `---` line and its
 * matching closing `---`) as one exact slice. NOT `src.split('---')[1]`,
 * which silently truncates at the first `---` INSIDE a frontmatter string
 * value — keys after it (noindex, lastModified, …) would be missed.
 */
function extractFrontmatter(src: string): string {
  // Strip a UTF-8 BOM first: on a BOM-headed file `^---` fails, yielding ''
  // and silently exempting the draft from the draft/lastModified checks.
  return src.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
}

function buildLastmodMap(
  noindexPaths: Set<string>,
  coverage: Map<string, Set<string>>,
  categoryCoverage: Map<string, Set<string>>,
): Map<string, string> {
  const map = new Map<string, string>();
  const base = path.resolve('./src/content/wiki');
  if (!fs.existsSync(base)) return map;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.mdx')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const fm = extractFrontmatter(src);
      // Drafts never publish — their dates must not leak into list-page
      // lastmod (would tell Google a page updated that didn't). Accept the
      // spellings js-yaml (the build's real frontmatter gate) resolves as
      // boolean true — lowercase-only here would disagree with the gate: a
      // `draft: True` article is excluded from the build while its lastmod
      // still feeds the sitemap (a dead URL advertised as fresh).
      if (/^draft:\s*(?:true|True|TRUE)\s*$/m.test(fm)) continue;
      const lm = fm.match(/^lastModified:\s*(.+)$/m)?.[1]?.trim();
      const dt = fm.match(/^date:\s*(.+)$/m)?.[1]?.trim();
      const iso = (lm || dt || '').replace(/['"]/g, '');
      if (!iso) continue;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) continue;

      // Path relative to the content base → locale/category/slug.
      const rel = path.relative(base, p).replace(/\.mdx$/, '');
      const [loc, cat, ...rest] = rel.split(path.sep);
      const slugPath = rest.join('/');
      const articlePath = loc === defaultLocale ? `/${cat}/${slugPath}` : `/${loc}/${cat}/${slugPath}`;
      // Same true-spelling rule as the draft check above: a `noindex: True`
      // page must not ship in the sitemap it asked out of.
      if (/^noindex:\s*(?:true|True|TRUE)\s*$/m.test(fm)) {
        noindexPaths.add(articlePath);
      }
      map.set(articlePath, date.toISOString());

      // Locale coverage for sitemap hreflang alternates (see docblock).
      const covKey = `${cat}/${slugPath}`;
      const cov = coverage.get(covKey) ?? new Set<string>();
      cov.add(loc);
      coverage.set(covKey, cov);

      // Category-level coverage: which locales have ≥1 article in this
      // category (drives list-page alternates + empty-list exclusion).
      const catCov = categoryCoverage.get(cat) ?? new Set<string>();
      catCov.add(loc);
      categoryCoverage.set(cat, catCov);

      // List pages: newest article in the category wins.
      const listPath = loc === defaultLocale ? `/${cat}` : `/${loc}/${cat}`;
      const existing = map.get(listPath);
      if (!existing || existing < date.toISOString()) {
        map.set(listPath, date.toISOString());
      }
    }
  };
  walk(base);

  // English-fallback detail URLs: built and human-reachable, but the page
  // renders noindex (ArticlePage passes `resolved.isFallback` through) — the
  // sitemap must agree, or it submits a URL that asks to be excluded.
  // Derives from `coverage` (populated by the walk above): every default-
  // locale article missing a locale's MDX contributes its /{locale}/…
  // variant — superset of the old per-article fs.existsSync check, which
  // only covered frontmatter-noindex articles.
  for (const p of fallbackDetailPaths(coverage, locales, defaultLocale)) {
    noindexPaths.add(p);
  }

  // Empty (category × locale) list pages: noindex thin content on the page
  // side (ListPage), excluded from the sitemap here. Same paths, same truth.
  for (const cat of CONTENT_TYPES) {
    const covered = categoryCoverage.get(cat);
    for (const l of locales) {
      if (covered?.has(l)) continue;
      noindexPaths.add(l === defaultLocale ? `/${cat}` : `/${l}/${cat}`);
    }
  }

  // Handbook chapters (docs/handbook/<locale>/<slug>.md) → /landing/docs/<slug>
  // (+ /zh/ prefix). Same frontmatter-driven lastmod contract; the `updated`
  // field is optional, so chapters without it simply keep the default.
  const hb = path.resolve('./docs/handbook');
  if (fs.existsSync(hb)) {
    for (const loc of ['en', 'zh']) {
      const dir = path.join(hb, loc);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue;
        const src = fs.readFileSync(path.join(dir, entry), 'utf8');
        const fm = extractFrontmatter(src);
        const iso = fm.match(/^updated:\s*(.+)$/m)?.[1]?.trim().replace(/['"]/g, '');
        if (!iso) continue;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) continue;
        const slug = entry.replace(/\.md$/, '');
        const pagePath = loc === 'en' ? `/landing/docs/${slug}` : `/zh/landing/docs/${slug}`;
        map.set(pagePath, date.toISOString());
        // Hub pages: newest chapter wins.
        const hubPath = loc === 'en' ? '/landing/docs' : '/zh/landing/docs';
        const existing = map.get(hubPath);
        if (!existing || existing < date.toISOString()) {
          map.set(hubPath, date.toISOString());
        }
      }
    }
  }

  return map;
}

const siteOrigin = process.env.SITE_URL || 'https://anvil.wiki';

// trailingSlash:'always' makes every generated URL end with "/", but the
// lookup tables above (lastmodMap / noindexPaths / coverage keys) are built
// slash-free — normalize once here instead of at every key construction.
const normalizePath = (p: string) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p);

const noindexPaths = new Set<string>();
const localeCoverage = new Map<string, Set<string>>();
const categoryCoverage = new Map<string, Set<string>>();
const lastmodMap = buildLastmodMap(noindexPaths, localeCoverage, categoryCoverage);

/**
 * Article/list hreflang alternates that match the page-level <head> truth.
 * Returns sitemap `links` items ({ lang, url }); undefined = no alternates.
 * The locale segment is anchored by its trailing slash — a bare optional
 * ([a-z]{2,3})? would greedily eat the first 3 letters of a category
 * ("bosses" → locale "bos" + category "ses") and silently drop alternates.
 */
function alternatesFor(pagePath: string): Array<{ lang: string; url: string }> | undefined {
  // Article: /<cat>/<slug…> or /<locale>/<cat>/<slug…>
  const art = pagePath.match(/^\/(?:([a-z]{2,3})\/)?([a-z-]+)\/(.+)$/);
  if (art && (locales as readonly string[]).includes(art[1] ?? defaultLocale)) {
    const cov = localeCoverage.get(`${art[2]}/${art[3]}`);
    if (cov) {
      return Array.from(cov).map((l) => ({
        lang: l,
        url: new URL(
          l === defaultLocale ? `/${art[2]}/${art[3]}/` : `/${l}/${art[2]}/${art[3]}/`,
          siteOrigin,
        ).href,
      }));
    }
  }
  // Category list: only locales that actually have an article in the
  // category (empty-state lists are noindex and excluded from the sitemap —
  // advertising them as alternates would invite crawling thin content).
  const list = pagePath.match(/^\/(?:([a-z]{2,3})\/)?([a-z-]+)$/);
  if (
    list &&
    (locales as readonly string[]).includes(list[1] ?? defaultLocale) &&
    CONTENT_TYPES.includes(list[2])
  ) {
    const catCov = categoryCoverage.get(list[2]);
    if (!catCov) return undefined;
    return Array.from(catCov).map((l) => ({
      lang: l,
      url: new URL(l === defaultLocale ? `/${list[2]}/` : `/${l}/${list[2]}/`, siteOrigin).href,
    }));
  }
  return undefined;
}

// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL || 'https://anvil.wiki',
  output: 'static',
  // Astro 7 flipped the default from true to 'jsx', which strips whitespace
  // between adjacent inline elements ("word" + "word" can render joined).
  // Pin the Astro 5/6 behavior so this migration never reflows a page —
  // fork users merge the upgrade with zero visual diff by contract.
  compressHTML: true,
  // Cloudflare Pages serves directory builds at /path/ — with 'never' every
  // canonical/sitemap/internal link said /path, so each page 308'd once and
  // Google's self-described signals were all off by a hop (three-site
  // production lesson; the terminal fix is 'always' everywhere, NOT a
  // _redirects reverse-301 which loops on CF).
  trailingSlash: 'always',
  image: {
    // Emit explicit width/height on responsive <Image> output to prevent CLS.
    responsiveStyles: true,
  },
  // Prefetch all internal links on hover — faster page transitions, no
  // View Transitions runtime needed. Adds a small IntersectionObserver script.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  i18n: {
    // Spread to convert readonly tuple to mutable array (Astro's Locales type).
    locales: [...locales],
    defaultLocale,
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    mdx(),
    sitemap({
      // No `i18n` option on purpose: it fabricates hreflang alternates for
      // EVERY locale on EVERY URL, which contradicts the page-level <head>
      // on English-fallback URLs (/ja/… serving English declares only `en`).
      // Alternates are built per-URL in `serialize` from real MDX coverage.
      // noindex articles stay out of the sitemap (self-contradictory signal
      // otherwise — the page asks not to be indexed while the sitemap submits it).
      filter: (url) => !noindexPaths.has(normalizePath(decodeURIComponent(new URL(url).pathname))),
      // Inject <lastmod> from article frontmatter (see buildLastmodMap) and
      // hreflang alternates that mirror the page-level truth (see alternatesFor).
      serialize(item) {
        try {
          // Decode: non-ASCII slugs (CJK filenames) come percent-encoded in
          // item.url, while lastmodMap keys are raw filesystem names —
          // without decoding the lookup silently misses.
          const pagePath = normalizePath(decodeURIComponent(new URL(item.url).pathname));
          const lm = lastmodMap.get(pagePath);
          if (lm) item.lastmod = lm;
          // sitemap `links` = hreflang alternates (the lib's own i18n option
          // would fabricate them for every locale on every URL).
          const links = alternatesFor(pagePath);
          if (links) item.links = links;
        } catch {
          /* non-URL entries keep default behavior */
        }
        return item;
      },
    }),
    tailwind({ applyBaseStyles: false }),
    icon(),
  ],
  vite: {
    resolve: {
      alias: {
        '~': '/src',
      },
    },
    build: {
      // Astro 7 (Vite 8) defaults CSS minification to Lightning CSS, which
      // re-serializes `@media (min-width: …)` into range syntax
      // (`width>=640px`) — syntax pre-2023 kernels (old X5, Safari <16.4)
      // drop entirely, so every Tailwind breakpoint would collapse on the
      // browsers this template explicitly supports (v2.21.0 hardening).
      // esbuild minifies tight and preserves the query syntax verbatim.
      // Scoped styles inlined at render time bypass this option; the
      // postbuild script lowers any range syntax that path still emits.
      cssMinify: 'esbuild',
    },
  },
});
