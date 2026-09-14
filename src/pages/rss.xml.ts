/**
 * RSS feed (/rss.xml) — the default-locale (English) article feed.
 *
 * Uses @astrojs/rss (already a dependency). Items are sorted newest-first
 * by frontmatter `date`, capped at 50. Codes / patch-note style sites get
 * frequent updates — RSS lets readers and aggregators follow without
 * manually re-visiting.
 *
 * A `<link rel="alternate">` for auto-discovery is injected in BaseLayout.
 */
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { site, siteUrl } from '~/config/site';
import { getCollection } from 'astro:content';
import { parseEntryId } from '~/lib/content';
import { newestFirst } from '~/lib/content-utils';
import { defaultLocale } from '~/i18n/routing';
import { detailPath } from '~/lib/url';

export const GET: APIRoute = async (context) => {
  const all = await getCollection('wiki');
  const items = all
    .filter((e) => {
      const parsed = parseEntryId(e.id);
      // Only default-locale, published articles (no noindex, no drafts).
      return parsed?.locale === defaultLocale && !e.data.noindex && !e.data.draft;
    })
    .sort(newestFirst)
    .slice(0, 50);

  return rss({
    title: site.name,
    description: site.description,
    // siteUrl (from SITE_URL env / site config) — no hardcoded demo domain:
    // a fork without context.site must not emit the template's URL.
    site: context.site ?? siteUrl,
    items: items.map((e) => {
      const parsed = parseEntryId(e.id);
      const slug = parsed?.slug ?? '';
      return {
        title: e.data.title,
        description: e.data.description,
        pubDate: e.data.date,
        // ABSOLUTE URL — the trailing slash it carries is now CORRECT
        // (trailingSlash:'always'); the historical bug was passing relative
        // links under 'never', where rss added a slash the site 404'd on.
        link: `${siteUrl}${detailPath(e.data.category, slug, defaultLocale)}`,
        categories: [e.data.category],
      };
    }),
    // xhtml language tag — helps RSS readers detect content language.
    customData: `<language>en</language>`,
  });
};

// Static endpoint — prerendered at build time.
export const prerender = true;
