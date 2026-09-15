import { collectInsights, formatInsights } from '../../core/insights.js';
import type { RunFn } from '../../core/content.js';
import type { GscCredential } from '../../core/env.js';
import type { GscClient } from '../../core/providers/gsc.js';
import type { queryCloudflare } from '../../core/providers/cloudflare.js';
import type { fetchAiReferrals } from '../../core/providers/cloudflare.js';

export async function insightsCommand(
  flags: {
    cwd?: string;
    days: number;
    run?: RunFn;
    gscClientFactory?: (o: { credential: GscCredential; siteUrl: string }) => GscClient;
    cfQuery?: typeof queryCloudflare;
    aiReferralsQuery?: typeof fetchAiReferrals;
  },
): Promise<number> {
  const report = await collectInsights({
    cwd: flags.cwd ?? process.cwd(),
    days: flags.days,
    run: flags.run,
    gscClientFactory: flags.gscClientFactory,
    cfQuery: flags.cfQuery,
    aiReferralsQuery: flags.aiReferralsQuery,
  });
  process.stdout.write(formatInsights(report.list, report.degraded, report.aio, report.notes));
  return 0;
}
