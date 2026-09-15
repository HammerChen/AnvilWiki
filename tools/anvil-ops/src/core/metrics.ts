import { loadOpsEnv } from './env.js';
import type { GscCredential } from './env.js';
import { OpsError } from './errors.js';
import { loadSiteConfig } from './site.js';
import { createGscClient } from './providers/gsc.js';
import type { GscClient, GscQueryResult } from './providers/gsc.js';
import { queryCloudflare, fetchAiReferrals, AI_REFERRER_HOSTS } from './providers/cloudflare.js';
import type { CfQueryResult, AiReferralsResult } from './providers/cloudflare.js';

export type MetricsSource = 'gsc' | 'cf' | 'all';

export interface MetricsReport {
  days: number;
  siteUrl?: string;
  gsc?: GscQueryResult;
  cf?: CfQueryResult;
  aiReferrals?: AiReferralsResult;
  degraded: ('gsc' | 'cf')[];
  notes: string[];
}

function pad(cell: string, width: number): string {
  return cell + ' '.repeat(Math.max(0, width - cell.length));
}

export async function collectMetrics(opts: {
  cwd: string;
  days: number;
  source?: MetricsSource;
  gscClientFactory?: (o: { credential: GscCredential; siteUrl: string }) => GscClient;
  cfQuery?: typeof queryCloudflare;
  aiReferralsQuery?: typeof fetchAiReferrals;
}): Promise<MetricsReport> {
  const site = loadSiteConfig(opts.cwd);
  const env = loadOpsEnv(site.root);
  const wanted = opts.source ?? 'all';
  const degraded: ('gsc' | 'cf')[] = [];

  const gscReady = wanted !== 'cf' && env.gscServiceAccount && site.siteUrl;
  const cfReady = wanted !== 'gsc' && env.cfApiToken && env.cfAccountId && site.cfBeaconToken;
  if (!gscReady && !cfReady) {
    // The stable `code` lets insights degrade on THIS error without matching
    // prose (a wording change must not silently flip degradation behavior).
    throw new OpsError(
      'No analytics source is configured.',
      'Set GSC_SERVICE_ACCOUNT_JSON and/or CF_API_TOKEN + CF_ACCOUNT_ID in .env (site tag comes from wrangler.toml). Run `anvil-ops doctor` for a guided check.',
      'no-analytics-source',
    );
  }

  const report: MetricsReport = { days: opts.days, siteUrl: site.siteUrl, degraded, notes: [...env.problems] };

  // Sources degrade independently: a failing GSC must not hide a healthy CF
  // half of the same report (only when ALL configured sources fail do we
  // throw — never show an empty report as if it were complete).
  const failures: string[] = [];

  if (gscReady) {
    const factory = opts.gscClientFactory ?? createGscClient;
    const client = factory({ credential: env.gscServiceAccount!, siteUrl: site.siteUrl! });
    try {
      report.gsc = await client.query({ days: opts.days });
      if (report.gsc.rows.length >= 1000) {
        report.notes.push('GSC rows capped at the 1000-row API limit — long-tail queries beyond the cap are excluded.');
      }
    } catch (e) {
      failures.push(`gsc: ${e instanceof Error ? e.message : String(e)}`);
      degraded.push('gsc');
    }
  } else if (wanted !== 'cf') {
    degraded.push('gsc');
  }

  if (cfReady) {
    const q = opts.cfQuery ?? queryCloudflare;
    try {
      report.cf = await q({
        apiToken: env.cfApiToken!,
        accountId: env.cfAccountId!,
        siteTag: site.cfBeaconToken!,
        days: opts.days,
      });
      if (report.cf.pages.length >= 100) {
        report.notes.push('CF top pages capped at the 100-row query limit — pages beyond the cap are excluded.');
      }
      // AI referrals ride the same CF credentials but must never fail the whole
      // metrics pull — degrade to a note instead.
      const ai = opts.aiReferralsQuery ?? fetchAiReferrals;
      try {
        report.aiReferrals = await ai({
          apiToken: env.cfApiToken,
          accountId: env.cfAccountId,
          siteTag: site.cfBeaconToken,
          days: opts.days,
        });
      } catch (e) {
        report.notes.push(`AI referrals unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      failures.push(`cf: ${e instanceof Error ? e.message : String(e)}`);
      degraded.push('cf');
    }
  } else if (wanted !== 'gsc') {
    degraded.push('cf');
  }

  if (!report.gsc && !report.cf && failures.length > 0) {
    throw new OpsError(
      `All configured analytics sources failed:\n  ${failures.join('\n  ')}`,
      'Run `anvil-ops doctor` to check credentials, then retry. A partial report is never shown as complete.',
    );
  }
  if (failures.length > 0) {
    report.notes.push(`Failed sources excluded from this report: ${failures.join('; ')}`);
  }

  return report;
}

export function formatMetrics(report: MetricsReport, format: 'table' | 'json' | 'md'): string {
  if (format === 'json') return JSON.stringify(report, null, 2);

  const lines: string[] = [];
  if (format === 'md') {
    lines.push(`# Metrics — last ${report.days} days`);
    if (report.siteUrl) lines.push(`Site: ${report.siteUrl}`);
    lines.push('');
  }
  if (report.gsc) {
    const t = report.gsc.totals;
    lines.push(format === 'md' ? '## Google Search Console' : 'Google Search Console');
    lines.push(
      `clicks=${t.clicks} impressions=${t.impressions} ctr=${(t.ctr * 100).toFixed(1)}% position=${t.position.toFixed(1)}`,
    );
    lines.push('');
    lines.push([pad('page', 44), pad('query', 24), pad('clicks', 8), pad('impr', 8), pad('ctr', 7), 'pos'].join(' '));
    for (const r of report.gsc.rows.slice(0, 20)) {
      lines.push(
        [
          pad(r.page.slice(0, 43), 44),
          pad(r.query.slice(0, 23), 24),
          pad(String(r.clicks), 8),
          pad(String(r.impressions), 8),
          pad((r.ctr * 100).toFixed(1) + '%', 7),
          r.position.toFixed(1),
        ].join(' '),
      );
    }
    lines.push('');
  }
  if (report.cf) {
    lines.push(format === 'md' ? '## Cloudflare Web Analytics' : 'Cloudflare Web Analytics');
    lines.push(`visits=${report.cf.totals.visits}`);
    lines.push('');
    lines.push([pad('page', 60), 'visits'].join(' '));
    for (const p of report.cf.pages.slice(0, 20)) {
      lines.push([pad(p.page.slice(0, 59), 60), p.visits].join(' '));
    }
    lines.push('');
  }
  if (report.aiReferrals?.available) {
    lines.push(format === 'md' ? '## AI referrals' : `AI referrals (last ${report.days} days)`);
    if (report.aiReferrals.rows.length === 0) {
      lines.push(`No AI referrer traffic in this window (watching: ${AI_REFERRER_HOSTS.join(', ')}).`);
    } else {
      lines.push('');
      lines.push([pad('host', 28), pad('requests', 10), 'pageviews'].join(' '));
      for (const r of report.aiReferrals.rows) {
        lines.push([pad(r.host, 28), pad(String(r.requests), 10), String(r.pageviews)].join(' '));
      }
      lines.push('');
      lines.push(
        `total requests=${report.aiReferrals.totals.requests} pageviews=${report.aiReferrals.totals.pageviews}`,
      );
    }
    lines.push('');
  }
  if (report.degraded.length) {
    lines.push(`Not configured (skipped): ${report.degraded.join(', ')}. Run \`anvil-ops doctor\` to enable.`);
  }
  for (const n of report.notes) lines.push(`Note: ${n}`);
  return lines.join('\n').trim() + '\n';
}
