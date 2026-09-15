import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gscQueryUrl, parseGscResponse, raceTimeout } from '../src/core/providers/gsc.js';
import { OpsError } from '../src/core/errors.js';

const fixture = JSON.parse(readFileSync('test/fixtures/gsc-response.json', 'utf8'));

describe('parseGscResponse', () => {
  it('maps keys to page/query and computes totals', () => {
    const r = parseGscResponse(fixture);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ page: 'https://wiki.example.com/bosses/emberfang', query: 'emberfang boss guide', clicks: 120 });
    expect(r.totals.clicks).toBe(150);
    expect(r.totals.impressions).toBe(7000);
    expect(r.totals.position).toBeCloseTo(6.35, 1);
  });

  it('empty rows = zeroed totals, not an error', () => {
    const r = parseGscResponse({ rows: [] });
    expect(r.rows).toEqual([]);
    expect(r.totals.clicks).toBe(0);
  });

  it('API error shape throws OpsError with fix', () => {
    const bad = { error: { code: 403, message: 'User does not have sufficient permission' } };
    expect(() => parseGscResponse(bad)).toThrow(/403/);
  });
});

describe('gscQueryUrl', () => {
  it('appends trailing slash and encodes', () => {
    expect(gscQueryUrl('https://wiki.example.com')).toBe(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/' +
        encodeURIComponent('https://wiki.example.com/') +
        '/searchAnalytics/query',
    );
  });

  it('sc-domain: properties are used verbatim (no trailing slash)', () => {
    const url = gscQueryUrl('sc-domain:example.com');
    expect(url).toContain(encodeURIComponent('sc-domain:example.com'));
    expect(url).not.toContain(encodeURIComponent('sc-domain:example.com/'));
  });
});

describe('raceTimeout (whole-request watchdog incl. token exchange)', () => {
  it('passes the settled value through when the promise wins the race', async () => {
    await expect(raceTimeout(Promise.resolve({ data: 1 }), 5_000, 'Google Search Console API request')).resolves.toEqual({ data: 1 });
  });

  it('fails loudly with an OpsError + network fix when the request never settles (gaxios default is no timeout)', async () => {
    const err: OpsError = await raceTimeout(new Promise(() => {}), 10, 'Google Search Console API request').then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toMatch(/timed out after \d+s/);
    expect(err.fix).toMatch(/googleapis\.com/);
  });
});
