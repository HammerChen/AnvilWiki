/**
 * Fallback URL derivation — the sitemap-side twin of the page-level
 * fallback noindex (ArticlePage passes `resolved.isFallback` into its
 * layout's `noindex` prop).
 *
 * A URL /{locale}/{category}/{slug} where the DEFAULT locale owns the
 * article but `locale` does not is an English-fallback page: still built
 * and human-reachable (direct links must never 404 — PRD §9.3), but it
 * renders English content with `noindex` and must therefore stay out of
 * the sitemap (a sitemap URL asking to be excluded is a self-contradictory
 * signal; see the sitemap filter in astro.config.ts).
 *
 * This module is deliberately IMPORT-FREE: astro.config.ts loads it at
 * config time, before the `~` vite alias exists — anything transitively
 * importing `~/...` (lib/url, config/site) would break `pnpm build`.
 *
 * `coverage` mirrors astro.config's `localeCoverage`: "category/slug"
 * (raw filesystem names, no percent-encoding) → set of locales that really
 * have a published MDX for it. Returned paths use the same raw convention;
 * the sitemap filter decodes `pathname` before lookup (CJK slugs).
 */
export function fallbackDetailPaths(
  coverage: Map<string, Set<string>>,
  locales: readonly string[],
  defaultLocale: string,
): string[] {
  const paths: string[] = [];
  for (const locale of locales) {
    if (locale === defaultLocale) continue;
    for (const covKey of Array.from(coverage.keys()).sort()) {
      const cov = coverage.get(covKey);
      if (cov?.has(defaultLocale) && !cov.has(locale)) {
        paths.push(`/${locale}/${covKey}`);
      }
    }
  }
  return paths;
}
