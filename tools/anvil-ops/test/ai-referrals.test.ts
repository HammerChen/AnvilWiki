import { describe, expect, it } from 'vitest';
import {
  AI_REFERRER_HOSTS,
  aggregateAiReferrals,
  buildAiReferralQuery,
  parseAiReferralResponse,
  fetchAiReferrals,
  isAiReferrerHost,
} from '../src/core/providers/cloudflare.js';

describe('isAiReferrerHost', () => {
  it('matches whitelist hosts exactly and as subdomains', () => {
    expect(isAiReferrerHost('chatgpt.com')).toBe(true);
    expect(isAiReferrerHost('www.perplexity.ai')).toBe(true);
    expect(isAiReferrerHost('gemini.google.com')).toBe(true);
  });

  it('is case-insensitive on the incoming host (CF reports mixed case)', () => {
    expect(isAiReferrerHost('ChatGPT.com')).toBe(true);
    expect(isAiReferrerHost('WWW.Perplexity.AI')).toBe(true);
    expect(isAiReferrerHost('sub.Claude.AI')).toBe(true);
    expect(isAiReferrerHost('GOOGLE.COM')).toBe(false);
  });

  it('rejects non-AI hosts and lookalikes', () => {
    expect(isAiReferrerHost('google.com')).toBe(false);
    expect(isAiReferrerHost('fakeperplexity.ai')).toBe(false);
    expect(isAiReferrerHost('perplexity.ai.evil.com')).toBe(false);
    expect(isAiReferrerHost('discord.com')).toBe(false);
  });
});

describe('aggregateAiReferrals', () => {
  it('keeps only AI hosts, aggregates duplicates, sorts by requests desc', () => {
    const r = aggregateAiReferrals([
      { host: 'google.com', count: 999 },
      { host: 'chatgpt.com', count: 10 },
      { host: 'chatgpt.com', count: 5 },
      { host: 'claude.ai', count: 30 },
      { host: '', count: 7 },
    ]);
    expect(r.available).toBe(true);
    expect(r.rows).toEqual([
      { host: 'claude.ai', requests: 30, pageviews: 30 },
      { host: 'chatgpt.com', requests: 15, pageviews: 15 },
    ]);
    expect(r.totals).toEqual({ requests: 45, pageviews: 45 });
  });

  it('empty groups = empty rows, zeroed totals, still available', () => {
    const r = aggregateAiReferrals([]);
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual({ requests: 0, pageviews: 0 });
  });

  it('whitelist covers the six AI assistants', () => {
    expect([...AI_REFERRER_HOSTS]).toEqual([
      'chatgpt.com',
      'chat.openai.com',
      'perplexity.ai',
      'gemini.google.com',
      'claude.ai',
      'copilot.microsoft.com',
    ]);
  });
});

describe('buildAiReferralQuery / parseAiReferralResponse', () => {
  it('groups the RUM dataset by rumRefererHost with count', () => {
    const q = buildAiReferralQuery();
    expect(q).toContain('rumOperationsGroups');
    expect(q).toContain('rumRefererHost');
    expect(q).not.toContain('rumPageUrl');
  });

  it('maps groups to host/count and skips rows without a host', () => {
    const json = {
      data: {
        viewer: {
          accounts: [
            {
              rumOperationsGroups: [
                { count: 12, dimensions: { rumRefererHost: 'chatgpt.com' } },
                { count: 3, dimensions: {} },
              ],
            },
          ],
        },
      },
    };
    expect(parseAiReferralResponse(json)).toEqual([{ host: 'chatgpt.com', count: 12 }]);
  });

  it('GraphQL errors throw OpsError with the introspection hint', () => {
    const bad = { errors: [{ message: 'Unknown field rumRefererHost' }] };
    expect(() => parseAiReferralResponse(bad)).toThrow(/Cloudflare GraphQL error/);
    try {
      parseAiReferralResponse(bad);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { fix: string }).fix).toMatch(/introspection|curl/);
    }
  });
});

describe('fetchAiReferrals', () => {
  it('missing credentials = available:false with explanation, no network call', async () => {
    const r = await fetchAiReferrals({ days: 7, fetchImpl: async () => {
      throw new Error('must not be called');
    } });
    expect(r.available).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.note).toMatch(/CF_API_TOKEN/);
  });

  it('sends a rumRefererHost query and aggregates the response', async () => {
    let captured: { url: string; body: string } | undefined;
    const fakeFetch = (async (url: string | URL | RequestInfo, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                { rumOperationsGroups: [{ count: 8, dimensions: { rumRefererHost: 'chatgpt.com' } }] },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r = await fetchAiReferrals({ apiToken: 't', accountId: 'acc', siteTag: 'tag', days: 7, fetchImpl: fakeFetch });
    expect(r.available).toBe(true);
    expect(r.rows).toEqual([{ host: 'chatgpt.com', requests: 8, pageviews: 8 }]);
    expect(captured).toBeDefined();
    const sent = JSON.parse(captured!.body) as { query: string; variables: { accountTag: string; filter: Record<string, string> } };
    expect(sent.query).toContain('rumRefererHost');
    expect(sent.variables.accountTag).toBe('acc');
    expect(sent.variables.filter._siteTag).toBe('tag');
    expect(sent.variables.filter._datetime_geq).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('HTTP 401 throws OpsError mentioning the token permission', async () => {
    const fake = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    await expect(
      fetchAiReferrals({ apiToken: 'bad', accountId: 'acc', siteTag: 'tag', days: 7, fetchImpl: fake }),
    ).rejects.toMatchObject({ fix: expect.stringMatching(/Analytics.*Read|token/i) });
  });
});
