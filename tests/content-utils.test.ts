import { describe, it, expect } from 'vitest';
import { parseEntryId, isPossiblyOutdated, selectRelatedEntries, STALE_AFTER_DAYS } from '~/lib/content-utils';

describe('parseEntryId', () => {
  it('parses a simple id into locale/category/slug', () => {
    expect(parseEntryId('en/bosses/emberfang')).toEqual({
      locale: 'en',
      category: 'bosses',
      slug: 'emberfang',
    });
  });

  it('strips the .mdx extension the glob loader includes in the id', () => {
    expect(parseEntryId('ja/bosses/emberfang.mdx')).toEqual({
      locale: 'ja',
      category: 'bosses',
      slug: 'emberfang',
    });
  });

  it('keeps nested slug segments joined with /', () => {
    expect(parseEntryId('en/guides/sub/deep/page')).toEqual({
      locale: 'en',
      category: 'guides',
      slug: 'sub/deep/page',
    });
  });

  it('returns null when the locale segment is not a configured locale', () => {
    expect(parseEntryId('fr/bosses/emberfang')).toBeNull();
  });

  it('returns null when there are fewer than 3 segments', () => {
    expect(parseEntryId('en/bosses')).toBeNull();
    expect(parseEntryId('en')).toBeNull();
    expect(parseEntryId('')).toBeNull();
  });
});

describe('isPossiblyOutdated', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  const fresh = new Date('2026-08-01T00:00:00Z'); // 15 days before now
  const stale = new Date('2025-08-01T00:00:00Z'); // > 1 year before now

  it('is false for categories outside STALE_CATEGORIES regardless of age', () => {
    expect(isPossiblyOutdated('guides', undefined, stale, now)).toBe(false);
    expect(isPossiblyOutdated('codes', undefined, stale, now)).toBe(false);
  });

  it('is false for a fresh stale-category article', () => {
    expect(isPossiblyOutdated('bosses', undefined, fresh, now)).toBe(false);
  });

  it('is true once the article is older than STALE_AFTER_DAYS', () => {
    const justUnder = new Date(now.getTime() - (STALE_AFTER_DAYS - 1) * 86400000);
    const justOver = new Date(now.getTime() - (STALE_AFTER_DAYS + 1) * 86400000);
    expect(isPossiblyOutdated('bosses', undefined, justUnder, now)).toBe(false);
    expect(isPossiblyOutdated('bosses', undefined, justOver, now)).toBe(true);
  });

  it('prefers lastModified over the publish date', () => {
    // Published long ago but touched recently → not outdated.
    expect(isPossiblyOutdated('tier-list', fresh, stale, now)).toBe(false);
    // Published recently but lastModified is ancient → outdated (data bug,
    // but the function must honor the explicit field).
    expect(isPossiblyOutdated('tier-list', stale, fresh, now)).toBe(true);
  });
});

describe('selectRelatedEntries', () => {
  const d = (s: string) => new Date(s);
  const mk = (id: string, tags: string[], category: string, date: string) => ({
    id,
    data: { tags, category, date: d(date) },
  });
  const current = mk('en/bosses/a.mdx', ['fire'], 'bosses', '2026-01-01');

  it('tier 1: matches by shared tags, newest first', () => {
    const pool = [mk('en/bosses/old.mdx', ['fire'], 'bosses', '2025-01-01'), mk('en/guides/new.mdx', ['fire'], 'guides', '2026-06-01')];
    const rel = selectRelatedEntries(pool, current, 2);
    expect(rel.map((e) => e.id)).toEqual(['en/guides/new.mdx', 'en/bosses/old.mdx']);
  });

  it('tier 2: fills up to the limit from the same category when tags run out', () => {
    const pool = [mk('en/bosses/b.mdx', ['ice'], 'bosses', '2026-02-01'), mk('en/bosses/c.mdx', [], 'bosses', '2026-03-01')];
    const rel = selectRelatedEntries(pool, current, 3);
    expect(rel.map((e) => e.id)).toEqual(['en/bosses/c.mdx', 'en/bosses/b.mdx']);
  });

  it('tier 3: site-wide newest only when nothing matched at all', () => {
    const pool = [mk('en/guides/x.mdx', ['craft'], 'guides', '2026-05-01')];
    const rel = selectRelatedEntries(pool, current, 3);
    expect(rel.map((e) => e.id)).toEqual(['en/guides/x.mdx']);
  });

  it('never returns the current article or duplicates, and honors the limit', () => {
    const pool = [
      current,
      mk('en/bosses/same.mdx', ['fire'], 'bosses', '2026-04-01'),
      mk('en/bosses/also.mdx', ['fire'], 'bosses', '2026-03-01'),
      mk('en/bosses/third.mdx', ['fire'], 'bosses', '2026-02-01'),
    ];
    const rel = selectRelatedEntries(pool, current, 2);
    expect(rel).toHaveLength(2);
    expect(rel.some((e) => e.id === current.id)).toBe(false);
    expect(new Set(rel.map((e) => e.id)).size).toBe(2);
  });

  it('no tag overlap and no category siblings → falls through to newest', () => {
    const pool = [mk('ja/bosses/other.mdx', ['fire'], 'bosses', '2026-07-01'), mk('en/codes/z.mdx', [], 'codes', '2026-06-01')];
    // ja entry excluded by the caller's locale filter in real use; here the
    // pure function only proves category/tag tiers then newest fallback.
    const rel = selectRelatedEntries([pool[1]], current, 3);
    expect(rel.map((e) => e.id)).toEqual(['en/codes/z.mdx']);
  });

  it('equal dates tie-break on entry id — ordering is load-order independent', () => {
    // Astro 5→6 changed the content layer's base iteration order, which
    // shuffled same-date articles on the homepage "Recent Updates" grid.
    // newestFirst must pin ties deterministically regardless of pool order.
    const mkPool = () => [
      mk('en/items/armor.mdx', ['fire'], 'items', '2026-08-31'),
      mk('en/guides/forging.mdx', ['fire'], 'guides', '2026-08-31'),
    ];
    expect(selectRelatedEntries(mkPool(), current, 2).map((e) => e.id)).toEqual([
      'en/guides/forging.mdx',
      'en/items/armor.mdx',
    ]);
    // Reversed input order → identical output (the actual regression shape).
    expect(selectRelatedEntries([...mkPool()].reverse(), current, 2).map((e) => e.id)).toEqual([
      'en/guides/forging.mdx',
      'en/items/armor.mdx',
    ]);
  });
});
