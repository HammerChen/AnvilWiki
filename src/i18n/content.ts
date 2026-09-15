/**
 * Article loader with language fallback.
 *
 * Two distinct behaviors (intentional asymmetry — see PRD §9.3):
 *
 *   - getEntryWithFallback(category, slug, locale):
 *       SINGLE article. If the requested locale version is missing,
 *       fall back to English (DO NOT 404). Direct URL access must always resolve.
 *
 *   - getEntriesByCategory(category, locale):
 *       LIST page. Does NOT fall back. If the locale has no articles,
 *       return empty array → list page shows the "no articles" empty state.
 *
 * Why the asymmetry: list = accuracy (don't advertise content that doesn't exist);
 * detail = reachability (a URL shared on social media must never break).
 */

import { getCollection, type CollectionEntry } from 'astro:content';
import { defaultLocale, type Locale } from './routing';
import { slugifyTag } from '~/lib/url';
import { selectRelatedEntries, newestFirst } from '~/lib/content-utils';

export type WikiEntry = CollectionEntry<'wiki'>;

export interface ResolvedEntry {
  entry: WikiEntry;
  /** The locale actually served (may differ from requested if fell back). */
  servedLocale: Locale;
  /** True when the requested locale was missing and English was served instead. */
  isFallback: boolean;
}

/**
 * Draft visibility rule: drafts are visible in dev (author preview) but
 * excluded from the production build everywhere (pages, lists, recent,
 * related, hreflang, sitemap).
 */
const isDev = import.meta.env.DEV;

function isPublished(e: WikiEntry): boolean {
  return !e.data.draft || isDev;
}

// parseEntryId lives in lib/content-utils.ts (pure, vitest-testable).
import { parseEntryId } from '~/lib/content-utils';
export { parseEntryId };

/**
 * Load a single article. Falls back to English if the locale version is missing.
 * Returns null only when no version exists in any language (caller should 404).
 */
export async function getEntryWithFallback(
  category: string,
  slug: string,
  locale: Locale,
): Promise<ResolvedEntry | null> {
  // getCollection() + id map instead of getEntry(): a getEntry miss logs
  // "Entry … was not found." once per fallback page (every untranslated
  // /ja/… URL at build time), training the eye to ignore build warnings.
  // Same lookup, silent. getCollection returns entry.id WITH the .mdx
  // extension — strip it before matching (Astro Content Layer quirk).
  const byId = new Map<string, WikiEntry>();
  for (const e of await getCollection('wiki')) {
    byId.set(e.id.replace(/\.mdx$/, ''), e);
  }

  // 1. Try the requested locale first.
  const requested = byId.get(`${locale}/${category}/${slug}`);
  if (requested && isPublished(requested)) {
    return { entry: requested, servedLocale: locale, isFallback: false };
  }

  // 2. Fall back to English (default locale).
  if (locale !== defaultLocale) {
    const fallback = byId.get(`${defaultLocale}/${category}/${slug}`);
    if (fallback && isPublished(fallback)) {
      return { entry: fallback, servedLocale: defaultLocale, isFallback: true };
    }
  }

  return null;
}

/**
 * List all articles in a category for a locale. Does NOT fall back to English.
 * An empty result means "this locale has no translated articles in this category".
 */
export async function getEntriesByCategory(category: string, locale: Locale): Promise<WikiEntry[]> {
  const all = await getCollection('wiki');
  return all
    .filter((e) => {
      const parsed = parseEntryId(e.id);
      return isPublished(e) && parsed?.locale === locale && parsed.category === category;
    })
    .sort(newestFirst); // newest first, id tie-break (see content-utils)
}

/**
 * All locales that have at least one article for a given (category, slug).
 * Used to generate hreflang alternates. Only lists locales whose page is
 * actually built (the default-locale page exists only if an English MDX
 * exists), so alternates never point at a 404.
 */
export async function localesForEntry(category: string, slug: string): Promise<Locale[]> {
  const all = await getCollection('wiki');
  const found = new Set<Locale>();
  for (const entry of all) {
    const parsed = parseEntryId(entry.id);
    if (isPublished(entry) && parsed?.category === category && parsed.slug === slug) {
      found.add(parsed.locale);
    }
  }
  return Array.from(found);
}

/**
 * All locales that have at least one published article in a category.
 * Drives the list-page hreflang alternates: declaring a locale whose list
 * page is the empty state would advertise a thin-content page (and must
 * mirror the sitemap-side coverage in astro.config.ts).
 */
export async function localesForCategory(category: string): Promise<Locale[]> {
  const all = await getCollection('wiki');
  const found = new Set<Locale>();
  for (const entry of all) {
    const parsed = parseEntryId(entry.id);
    if (isPublished(entry) && parsed?.category === category) {
      found.add(parsed.locale);
    }
  }
  return Array.from(found);
}

/**
 * Recent articles for a locale (for homepage "Recent Updates").
 */
export async function getRecentEntries(locale: Locale, limit = 6): Promise<WikiEntry[]> {
  const all = await getCollection('wiki');
  return all
    .filter((e) => isPublished(e) && parseEntryId(e.id)?.locale === locale)
    .sort(newestFirst)
    .slice(0, limit);
}

/**
 * Related articles — three-tier fallback (Aniimo production lesson: word-level
 * tags rarely overlap, so a tags-only match left 54/56 articles with zero
 * related links). Tiers: shared tags → same category → newest site-wide (only
 * when nothing matched at all — a "Related" section of unrelated articles is
 * worse than none). Selection logic lives in selectRelatedEntries
 * (lib/content-utils.ts, vitest-loadable); this wrapper only loads the pool.
 */
export async function getRelatedEntries(
  current: WikiEntry,
  locale: Locale,
  limit = 3,
): Promise<WikiEntry[]> {
  const all = await getCollection('wiki');
  const pool = all.filter((e) => {
    if (e.id === current.id) return false;
    if (!isPublished(e)) return false;
    return parseEntryId(e.id)?.locale === locale;
  });
  return selectRelatedEntries(
    pool,
    { id: current.id, data: { tags: current.data.tags, category: current.data.category, date: current.data.date } },
    limit,
  );
}

/**
 * All tags for a locale with article counts, most-used first.
 * Does NOT fall back to English (list accuracy rule — PRD §9.3).
 */
export async function getTagsWithCounts(locale: Locale): Promise<Array<{ tag: string; count: number }>> {
  const all = await getCollection('wiki');
  const counts = new Map<string, number>();
  for (const e of all) {
    const parsed = parseEntryId(e.id);
    if (!isPublished(e) || parsed?.locale !== locale) continue;
    for (const tag of e.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    // Tie-break pinned to the collection's locale: a bare localeCompare()
    // sorts by the build machine's DEFAULT locale (ICU env drift → the same
    // content orders differently across machines). Same determinism intent
    // as newestFirst's id tie-break.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, locale));
}

/**
 * All articles in a locale carrying a given tag (matched by slugified tag).
 * Does NOT fall back to English — empty result shows the empty state.
 */
export async function getEntriesByTag(tagSlug: string, locale: Locale): Promise<WikiEntry[]> {
  const all = await getCollection('wiki');
  return all
    .filter((e) => {
      if (!isPublished(e)) return false;
      const parsed = parseEntryId(e.id);
      if (parsed?.locale !== locale) return false;
      return e.data.tags.some((t: string) => slugifyTag(t) === tagSlug);
    })
    .sort(newestFirst);
}

/**
 * All locales where at least one article carries this tag slug.
 * Used to build hreflang alternates that never point at a 404
 * (tag pages don't fall back to English).
 */
export async function localesForTag(tagSlug: string): Promise<Locale[]> {
  const all = await getCollection('wiki');
  const found = new Set<Locale>();
  for (const e of all) {
    if (!isPublished(e)) continue;
    const parsed = parseEntryId(e.id);
    if (parsed && e.data.tags.some((t: string) => slugifyTag(t) === tagSlug)) {
      found.add(parsed.locale);
    }
  }
  return Array.from(found);
}

/**
 * The display tag (original casing) for a tag slug in a locale,
 * or null when no article carries it.
 */
export async function tagLabelFor(tagSlug: string, locale: Locale): Promise<string | null> {
  const all = await getCollection('wiki');
  for (const e of all) {
    const parsed = parseEntryId(e.id);
    if (!isPublished(e) || parsed?.locale !== locale) continue;
    const match = e.data.tags.find((t: string) => slugifyTag(t) === tagSlug);
    if (match) return match;
  }
  return null;
}

// Staleness constants + predicate live in lib/content-utils.ts (pure,
// vitest-testable — this module imports astro:content and can't be loaded
// outside a build).
export { isPossiblyOutdated, STALE_AFTER_DAYS, STALE_CATEGORIES } from '~/lib/content-utils';
