import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  organizationJsonLd,
  websiteJsonLd,
  articleJsonLd,
  breadcrumbJsonLd,
  itemListJsonLd,
  faqPageJsonLd,
  pageTitle,
} from '~/lib/seo';
import { fallbackDetailPaths } from '~/lib/fallback-paths';
import { site } from '~/config/site';

/** Repo-root-relative source text (contract-test helper, handbook.test.ts style). */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('SEO helpers', () => {
  describe('organizationJsonLd', () => {
    it('returns a valid Organization schema', () => {
      const json = organizationJsonLd();
      expect(json['@type']).toBe('Organization');
      expect(json['@context']).toBe('https://schema.org');
      expect(typeof json.name).toBe('string');
      expect(json.url).toMatch(/^https?:\/\//);
      expect(json.logo).toMatch(/\.png$/);
    });
  });

  describe('websiteJsonLd', () => {
    it('returns a valid WebSite schema with locale', () => {
      const json = websiteJsonLd('en');
      expect(json['@type']).toBe('WebSite');
      expect(json.inLanguage).toBe('en');
    });
  });

  describe('articleJsonLd', () => {
    it('includes all required Article fields', () => {
      const json = articleJsonLd({
        title: 'Test Article',
        description: 'A test article description.',
        datePublished: new Date('2026-01-01'),
        category: 'bosses',
        slug: 'test-slug',
        locale: 'en',
      });
      expect(json['@type']).toBe('Article');
      expect(json.headline).toBe('Test Article');
      expect(json.datePublished).toContain('2026-01-01');
      expect(json.image).toMatch(/^https?:\/\//);
      expect(json.mainEntityOfPage['@id']).toMatch(/\/bosses\/test-slug\/$/);
    });

    it('uses dateModified when provided, otherwise falls back to datePublished', () => {
      const published = new Date('2026-01-01');
      const modified = new Date('2026-06-01');
      const withModified = articleJsonLd({
        title: 'T',
 description: 'Desc that is long enough for validation here.',
        datePublished: published,
        dateModified: modified,
        category: 'bosses',
        slug: 's',
        locale: 'en',
      });
      expect(withModified.dateModified).toContain('2026-06-01');

      const noModified = articleJsonLd({
        title: 'T',
 description: 'Desc that is long enough for validation here.',
        datePublished: published,
        category: 'bosses',
        slug: 's',
        locale: 'en',
      });
      expect(noModified.dateModified).toContain('2026-01-01');
    });
  });

  describe('breadcrumbJsonLd', () => {
    it('produces a 3-level breadcrumb (Home → Category → Article)', () => {
      const json = breadcrumbJsonLd({
        category: 'bosses',
        categoryLabel: 'All Bosses',
        title: 'Emberfang Guide',
        slug: 'emberfang',
        locale: 'en',
      });
      expect(json['@type']).toBe('BreadcrumbList');
      expect(json.itemListElement).toHaveLength(3);
      expect(json.itemListElement[0].name).toBe('Home');
      expect(json.itemListElement[1].name).toBe('All Bosses');
      expect(json.itemListElement[2].name).toBe('Emberfang Guide');
    });
  });

  describe('itemListJsonLd', () => {
    it('numbers items starting from 1', () => {
      const json = itemListJsonLd({
        category: 'bosses',
        categoryLabel: 'All Bosses',
        locale: 'en',
        items: [
          { title: 'A', slug: 'a' },
          { title: 'B', slug: 'b' },
        ],
      });
      expect(json['@type']).toBe('ItemList');
      expect(json.itemListElement[0].position).toBe(1);
      expect(json.itemListElement[1].position).toBe(2);
    });
  });

  describe('faqPageJsonLd', () => {
    it('maps Q&A pairs to Question/Answer schema', () => {
      const json = faqPageJsonLd([
        { question: 'What is X?', answer: 'X is Y.' },
      ]);
      expect(json['@type']).toBe('FAQPage');
      expect(json.mainEntity[0]['@type']).toBe('Question');
      expect(json.mainEntity[0].acceptedAnswer.text).toBe('X is Y.');
    });
  });

  describe('pageTitle', () => {
    it('appends the site name with an em dash', () => {
      const t = pageTitle('Hello');
      expect(t).toContain('Hello');
      expect(t).toContain('—');
      expect(t.endsWith(site.name)).toBe(true);
    });

    it('skips the suffix when the title already carries the game name', () => {
      const t = pageTitle('Anvil Quest Boss Guide');
      expect(t).toBe('Anvil Quest Boss Guide');
    });

    it('switches to the short suffix for long titles (>50 chars)', () => {
      const long = 'Best Weapons and Armor for Early Game Players Ranked';
      const t = pageTitle(long);
      expect(t).toBe(`${long} — ${site.shortName}`);
    });
  });

  describe('fallbackDetailPaths', () => {
    const locales = ['en', 'ja'] as const;
    // Coverage shape mirrors astro.config's localeCoverage: "cat/slug" →
    // locales that really have a published MDX.
    const coverage = new Map<string, Set<string>>([
      // English-only article → /ja/ URL is a fallback page.
      ['bosses/stormcaller', new Set(['en'])],
      // Translated in both locales → both URLs are real pages.
      ['bosses/emberfang', new Set(['en', 'ja'])],
      // ja-only article → /ja/ is real; en never falls back (no /ja/-owned
      // English URL exists to begin with).
      ['guides/ja-only', new Set(['ja'])],
      // Nested slug folds into the key after the category.
      ['guides/nested/deep-slug', new Set(['en'])],
      // CJK slug keeps raw filesystem names (sitemap filter decodes first).
      ['items/熔炉之心', new Set(['en'])],
    ]);

    it('derives one path per non-default locale missing a translation of a default-locale article', () => {
      expect(fallbackDetailPaths(coverage, locales, 'en')).toEqual([
        '/ja/bosses/stormcaller',
        '/ja/guides/nested/deep-slug',
        '/ja/items/熔炉之心',
      ]);
    });

    it('never emits paths for the default locale, translated slugs, or locale-owned articles', () => {
      const paths = fallbackDetailPaths(coverage, locales, 'en');
      expect(paths).not.toContain('/en/bosses/stormcaller');
      expect(paths).not.toContain('/ja/bosses/emberfang');
      expect(paths).not.toContain('/en/guides/ja-only');
      // With a single locale there is nothing to fall back to.
      expect(fallbackDetailPaths(coverage, ['en'], 'en')).toEqual([]);
    });

    it('is deterministic across calls (sorted keys, locales in order)', () => {
      const a = fallbackDetailPaths(coverage, locales, 'en');
      const b = fallbackDetailPaths(new Map(coverage), locales, 'en');
      expect(a).toEqual(b);
      expect(a).toEqual([...a].sort());
    });
  });

  describe('fallback noindex wiring (contract)', () => {
    it('astro.config.ts derives sitemap exclusions from fallbackDetailPaths', () => {
      const config = src('astro.config.ts');
      expect(config).toContain("from './src/lib/fallback-paths'");
      expect(config).toContain('fallbackDetailPaths(coverage, locales, defaultLocale)');
    });

    it('ArticlePage passes isFallback into the noindex prop', () => {
      const page = src('src/components/article/ArticlePage.astro');
      expect(page).toContain('noindex={entry.data.noindex || isFallback}');
    });
  });
});
