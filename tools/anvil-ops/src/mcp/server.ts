import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runDoctor, formatDoctor } from '../core/doctor.js';
import { collectMetrics, formatMetrics } from '../core/metrics.js';
import { collectInsights, formatInsights } from '../core/insights.js';
import { runAudit, formatAudit } from '../core/audit.js';
import { submit } from '../core/gitops.js';
import { defaultRun, type RunFn } from '../core/content.js';
import { OpsError } from '../core/errors.js';
import { resolveEffectiveRoot } from '../core/sites.js';
import { canOffload, offload } from './offload.js';
import { createSubmitMutex } from './submit-mutex.js';
import type { GscClient } from '../core/providers/gsc.js';
import type { queryCloudflare, fetchAiReferrals } from '../core/providers/cloudflare.js';

export interface BuildServerOpts {
  cwd: string;
  /** Path override for the multi-site registry (tests point this at a tmp file). */
  sitesRegistryPath?: string;
  gscClientFactory?: (o: { credential: { clientEmail: string; privateKey: string }; siteUrl: string }) => GscClient;
  cfQuery?: typeof queryCloudflare;
  aiReferralsQuery?: typeof fetchAiReferrals;
  run?: RunFn;
}

function errText(e: unknown): string {
  return e instanceof OpsError ? `Error: ${e.message}\nFix: ${e.fix}` : `Error: ${String(e)}`;
}

// Read version from package.json at startup so it can never drift from the
// published package (works from both src/ via vitest and dist/ via node).
const pkgVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version as string;

// One submit at a time per process (module-level = shared by every server
// instance in the process). Exported for tests to pre-acquire/release.
export const submitMutex = createSubmitMutex();

export function buildServer(opts: BuildServerOpts): McpServer {
  const server = new McpServer({ name: 'anvilwiki-ops', version: pkgVersion });

  // Site resolution (1.0.0): explicit `site` name wins; otherwise the server
  // start dir; only when that has no site config does registry defaultSite kick in.
  const effectiveCwd = (site: string | undefined): string =>
    resolveEffectiveRoot({ site, cwd: opts.cwd, registryPath: opts.sitesRegistryPath });

  const siteParam = z
    .string()
    .optional()
    .describe('site name from the multi-site registry (`anvil-ops sites list`); omit to use the server start directory');

  server.registerTool(
    'doctor',
    {
      title: 'anvil-ops doctor',
      description:
        'Health check for AnvilWiki site ops: wrangler.toml site config, gh CLI, GSC service account, CF Web Analytics token. Run this FIRST in any ops session before other anvil-ops tools.',
      inputSchema: {
        site: siteParam,
      },
    },
    async ({ site }) => {
      try {
        const report = await runDoctor({ cwd: effectiveCwd(site) });
        return { content: [{ type: 'text', text: formatDoctor(report) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      }
    },
  );

  server.registerTool(
    'metrics',
    {
      title: 'anvil-ops metrics',
      description:
        'Pull site traffic metrics: Google Search Console (clicks/impressions/CTR/position by page and query) + Cloudflare Web Analytics (visits by page) + AI referrals by host (chatgpt.com, perplexity.ai, ...). Requires .env credentials; run doctor first if unset.',
      inputSchema: {
        days: z.number().int().min(1).max(365).default(28).describe('lookback window in days'),
        source: z.enum(['gsc', 'cf', 'all']).default('all').describe('limit to one source'),
        site: siteParam,
      },
    },
    async ({ days, source, site }) => {
      try {
        const report = await collectMetrics({
          cwd: effectiveCwd(site),
          days: days ?? 28,
          source: source ?? 'all',
          gscClientFactory: opts.gscClientFactory,
          cfQuery: opts.cfQuery,
          aiReferralsQuery: opts.aiReferralsQuery,
        });
        return { content: [{ type: 'text', text: formatMetrics(report, 'md') }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      }
    },
  );

  server.registerTool(
    'audit',
    {
      title: 'anvil-ops audit',
      description:
        'Run the template maintenance checks (refresh-audit, check-i18n, check-content, check-links) and return one markdown report. check-links audits dist/ — run a build first for full link coverage.',
      inputSchema: {
        site: siteParam,
      },
    },
    async ({ site }) => {
      try {
        const cwd = effectiveCwd(site);
        // audit spawns 4 pnpm children (build included) — offload to a worker
        // thread so the stdio event loop stays responsive (keepalive pings).
        // Falls back in-process for injected test runs / unbuilt source.
        if (!opts.run && canOffload()) {
          const r = await offload({ kind: 'audit', cwd });
          return r.ok
            ? { content: [{ type: 'text', text: r.text }] }
            : { isError: true, content: [{ type: 'text', text: r.errorText }] };
        }
        const report = runAudit({ cwd, run: opts.run });
        return { content: [{ type: 'text', text: formatAudit(report) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      }
    },
  );

  server.registerTool(
    'insights',
    {
      title: 'anvil-ops insights',
      description:
        'Data-driven SEO action list from GSC + Cloudflare metrics plus stale-codes detection and an experimental AI Overviews page probe: low-CTR rewrites, rank 5-15 deepening, zero-impression checks, traffic-mix analysis, stale codes pages. Metrics degrade gracefully if credentials are unset (run doctor first).',
      inputSchema: {
        days: z.number().int().min(1).max(365).default(28).describe('metrics lookback window in days'),
        site: siteParam,
      },
    },
    async ({ days, site }) => {
      try {
        const report = await collectInsights({
          cwd: effectiveCwd(site),
          days: days ?? 28,
          run: opts.run,
          gscClientFactory: opts.gscClientFactory,
          cfQuery: opts.cfQuery,
          aiReferralsQuery: opts.aiReferralsQuery,
        });
        return { content: [{ type: 'text', text: formatInsights(report.list, report.degraded, report.aio, report.notes) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      }
    },
  );

  server.registerTool(
    'submit_pr',
    {
      title: 'anvil-ops submit_pr',
      description:
        'Publish workflow changes: validates (check-content + check-i18n + build), then creates branch ops/submit-*, commits, pushes, and opens a PR via gh. REQUIRES uncommitted changes in the worktree, gh CLI, and an origin remote. Never pushes main. Validation failure = nothing committed.',
      inputSchema: {
        title: z.string().optional().describe('PR / commit title'),
        base: z.string().optional().describe('PR base branch (default main)'),
        site: siteParam,
      },
    },
    async ({ title, base, site }) => {
      // Interlock BEFORE any work (including offload): parallel tool calls
      // must not double-stage the worktree and open two PRs for one batch.
      if (!submitMutex.tryAcquire()) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errText(
                new OpsError(
                  'Another submit is already in progress in this process.',
                  'Wait for the running submit_pr call to finish (one run = one branch + one PR), then re-run — your uncommitted changes are untouched.',
                ),
              ),
            },
          ],
        };
      }
      try {
        const cwd = effectiveCwd(site);
        // submit runs the full validation chain (build included) — offload to
        // a worker thread so the stdio event loop stays responsive. Falls
        // back in-process for injected test runs / unbuilt source.
        if (!opts.run && canOffload()) {
          const r = await offload({ kind: 'submit', cwd, title, base });
          return r.ok
            ? { content: [{ type: 'text', text: r.text }] }
            : { isError: true, content: [{ type: 'text', text: r.errorText }] };
        }
        const result = await submit({ cwd, title, base, run: opts.run });
        return {
          content: [{ type: 'text', text: `# PR opened\n\n- Branch: ${result.branch}\n- Pull request: ${result.prUrl}\n\nMerge after review; Cloudflare Pages deploys automatically.` }],
        };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errText(e) }] };
      } finally {
        submitMutex.release();
      }
    },
  );

  return server;
}
