import { describe, it, expect } from 'vitest';
import {
  localizePath,
  listPath,
  detailPath,
  homeUrl,
  slugifyTag,
  absoluteUrl,
  languageAlternates,
} from '~/lib/url';

describe('url helpers', () => {
  describe('localizePath', () => {
    it('returns the path unchanged for the default locale (en)', () => {
      expect(localizePath('/bosses', 'en')).toBe('/bosses/');
      expect(localizePath('/bosses/emberfang', 'en')).toBe('/bosses/emberfang/');
    });

    it('prepends the locale prefix for non-default locales', () => {
      expect(localizePath('/bosses', 'ja')).toBe('/ja/bosses/');
      expect(localizePath('/bosses/emberfang', 'ja')).toBe('/ja/bosses/emberfang/');
    });

    it('ensures leading slash on input without one', () => {
      expect(localizePath('about', 'en')).toBe('/about/');
      expect(localizePath('about', 'ja')).toBe('/ja/about/');
    });
  });

  describe('homeUrl', () => {
    it('returns / for default locale', () => {
      expect(homeUrl('en')).toBe('/');
    });
    it('returns /ja for non-default locale', () => {
      expect(homeUrl('ja')).toBe('/ja/');
    });
  });

  describe('listPath', () => {
    it('builds the correct list URL for each locale', () => {
      expect(listPath('bosses', 'en')).toBe('/bosses/');
      expect(listPath('bosses', 'ja')).toBe('/ja/bosses/');
      expect(listPath('codes', 'en')).toBe('/codes/');
    });
  });

  describe('detailPath', () => {
    it('builds the correct article URL for each locale', () => {
      expect(detailPath('bosses', 'emberfang', 'en')).toBe('/bosses/emberfang/');
      expect(detailPath('bosses', 'emberfang', 'ja')).toBe('/ja/bosses/emberfang/');
    });

    it('handles nested slugs', () => {
      expect(detailPath('guides', 'early-game/beginner', 'en')).toBe(
        '/guides/early-game/beginner/',
      );
      expect(detailPath('guides', 'early-game/beginner', 'ja')).toBe(
        '/ja/guides/early-game/beginner/',
      );
    });
  });
});

describe('slugifyTag (ASCII slug / raw fallback for non-ASCII)', () => {
  it('slugifies ASCII tags to lowercase kebab-case', () => {
    expect(slugifyTag('Boss Guide')).toBe('boss-guide');
    expect(slugifyTag('Fire_Warden')).toBe('fire-warden');
  });

  it('returns CJK tags raw instead of collapsing to empty', () => {
    // Folding a CJK tag leaves characters outside [a-z0-9-], so it takes the
    // raw path. Astro writes params to disk verbatim, so the built directory
    // is the raw tag and browser-encoded links (/tags/%E7%84%B0…) resolve to
    // it — while a partial ASCII strip would have collapsed this to ''.
    const zh = slugifyTag('焰牙');
    expect(zh).toBe('焰牙');
    expect(zh).not.toBe('');
  });

  it('returns mixed ASCII+CJK tags raw — a partial strip would collide them', () => {
    // Stripping only the non-ASCII would leave '焰牙 攻略' → '-' (truthy, so
    // no fallback) and BOTH 'Roblox 焰牙' and 'Roblox 攻略' → 'roblox-':
    // distinct tags crowding onto one /tags/ page. Any tag still holding a
    // non-[a-z0-9-] character after folding goes raw wholesale instead.
    expect(slugifyTag('焰牙 攻略')).toBe('焰牙 攻略');
    expect(slugifyTag('Roblox 焰牙')).not.toBe(slugifyTag('Roblox 攻略'));
    // The raw path is idempotent, like the ASCII one.
    expect(slugifyTag(slugifyTag('焰牙 攻略'))).toBe(slugifyTag('焰牙 攻略'));
  });

  it('keeps two different CJK tags distinguishable', () => {
    expect(slugifyTag('焰牙')).not.toBe(slugifyTag('风暴召唤者'));
  });

  it('keeps pure-symbol tags non-empty', () => {
    // Whatever the exact characters, the slug is stable and distinct from ''
    // — the property the raw path exists to guarantee.
    expect(slugifyTag('!!!')).toBe('!!!');
    expect(slugifyTag('  ???  ')).toBe('???');
  });
});

describe('absoluteUrl', () => {
  it('prefixes siteUrl and applies the locale prefix rules', () => {
    expect(absoluteUrl('/bosses', 'en')).toMatch(/^https:\/\/[^/]+\/bosses\/$/);
    expect(absoluteUrl('/bosses', 'ja')).toMatch(/^https:\/\/[^/]+\/ja\/bosses\/$/);
    expect(absoluteUrl('/', 'ja')).toMatch(/^https:\/\/[^/]+\/ja\/$/);
  });
});

describe('languageAlternates', () => {
  it('builds absolute hreflang entries for exactly the given locales', () => {
    const alts = languageAlternates((loc) => detailPath('bosses', 'x', loc), ['en', 'ja']);
    expect(alts).toHaveLength(2);
    expect(alts[0]).toEqual({ hreflang: 'en', href: expect.stringMatching(/\/bosses\/x\/$/) });
    expect(alts[1]).toEqual({ hreflang: 'ja', href: expect.stringMatching(/\/ja\/bosses\/x\/$/) });
  });

  it('never emits x-default (BaseLayout derives it separately)', () => {
    const alts = languageAlternates((loc) => listPath('guides', loc), ['en', 'ja']);
    expect(alts.some((a) => a.hreflang === 'x-default')).toBe(false);
  });

  it('honors a reduced locale list (single-language article)', () => {
    const alts = languageAlternates((loc) => detailPath('bosses', 'x', loc), ['ja']);
    expect(alts).toHaveLength(1);
    expect(alts[0].hreflang).toBe('ja');
  });

  it('shares one domain-assembly with absoluteUrl — same path+locale, identical href', () => {
    // languageAlternates receives already-localized paths (its buildPath
    // returns localizePath output) while absoluteUrl localizes internally;
    // both must join the domain through the same single helper so the
    // `${siteUrl}${path}` construction can't drift between them.
    const alts = languageAlternates((loc) => localizePath('/faq', loc), ['en', 'ja']);
    expect(alts.map((a) => a.href)).toEqual([absoluteUrl('/faq', 'en'), absoluteUrl('/faq', 'ja')]);
  });
});
