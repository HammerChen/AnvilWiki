/**
 * Pure content utilities — no `astro:content` import, so vitest can load
 * this module directly (the loaders in src/i18n/content.ts can't be unit
 * tested; these can). Re-exported through src/lib/content.ts for callers.
 */

import { isLocale, type Locale } from '~/i18n/routing';

/**
 * Parse an entry id like "en/bosses/emberfang" or "ja/bosses/sub/emberfang" into parts.
 * Returns null if the id doesn't match `<locale>/<category>/<...slug>`.
 */
export function parseEntryId(
  id: string,
): { locale: Locale; category: string; slug: string } | null {
  // Strip the .mdx extension that the glob loader includes in the id.
  const cleanId = id.replace(/\.mdx$/, '');
  const parts = cleanId.split('/');
  if (parts.length < 3) return null;
  const [locale, category, ...rest] = parts;
  if (!isLocale(locale)) return null;
  return { locale, category, slug: rest.join('/') };
}

/**
 * Categories whose content goes stale when the game updates (boss mechanics,
 * tier lists). Articles in these categories show a "possibly outdated" banner
 * when the last-modified date is older than STALE_AFTER_DAYS.
 */
export const STALE_CATEGORIES = ['bosses', 'tier-list'];
export const STALE_AFTER_DAYS = 90;

/**
 * True when the article is in a time-sensitive category and its
 * lastModified (or date) is older than STALE_AFTER_DAYS.
 * Pure function (testable without a build).
 */
export function isPossiblyOutdated(
  category: string,
  lastModified: Date | undefined,
  date: Date,
  now = new Date(),
): boolean {
  if (!STALE_CATEGORIES.includes(category)) return false;
  const ref = lastModified ?? date;
  const ageMs = now.getTime() - ref.getTime();
  return ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/** Minimal shape selectRelatedEntries needs — WikiEntry satisfies it. */
export interface RelatedLike {
  id: string;
  data: { tags: readonly string[]; category: string; date: Date };
}

/**
 * Newest-first comparator with a deterministic tie-break. Articles sharing a
 * `date` used to surface in whatever order the content layer happened to
 * load them — which silently changed between Astro 5 and 6 and reordered the
 * homepage "Recent Updates" grid. Tie-break on entry id makes every
 * date-sorted listing stable across Astro versions and builds.
 */
export const newestFirst = (a: RelatedLike, b: RelatedLike): number =>
  b.data.date.getTime() - a.data.date.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Related-article selection with a three-tier fallback:
 *   1. shared tags (strongest signal, newest first);
 *   2. same category, filling up to `limit`;
 *   3. newest site-wide — ONLY when nothing matched at all (a "Related"
 *      section of unrelated articles is worse than none).
 * Excludes the current article and never returns duplicates. Pure function
 * (the astro:content-dependent pool loading stays in i18n/content.ts).
 */
export function selectRelatedEntries<T extends RelatedLike>(
  pool: readonly T[],
  current: RelatedLike,
  limit = 3,
): T[] {
  const chosen: T[] = [];
  const chosenIds = new Set<string>([current.id]);

  const take = (candidates: T[]) => {
    for (const entry of candidates) {
      if (chosen.length >= limit) return;
      if (chosenIds.has(entry.id)) continue;
      chosen.push(entry);
      chosenIds.add(entry.id);
    }
  };

  // Tier 1: shared tags.
  take(pool.filter((e) => e.data.tags.some((t) => current.data.tags.includes(t))).sort(newestFirst));
  // Tier 2: same category fills the remainder.
  if (chosen.length < limit) {
    take(pool.filter((e) => e.data.category === current.data.category).sort(newestFirst));
  }
  // Tier 3: site-wide newest, only when the article is an island.
  if (chosen.length === 0) {
    take([...pool].sort(newestFirst));
  }
  return chosen;
}
