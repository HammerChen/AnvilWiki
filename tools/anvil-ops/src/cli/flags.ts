import { OpsError } from '../core/errors.js';

export interface SiteFlags {
  site?: string;
  all?: boolean;
}

/**
 * Merge the global (--site/--all before the subcommand) and per-command flags.
 * Command-level wins; `all` defaults to false. Pure — unit-tested without
 * spinning up commander.
 */
export function mergeSiteFlags(global: SiteFlags, cmd: SiteFlags): SiteFlags & { all: boolean } {
  return { site: cmd.site ?? global.site, all: cmd.all ?? global.all ?? false };
}

/** --site <name> and --all are mutually exclusive (both positions validated). */
export function assertNotBothSiteAndAll(flags: SiteFlags): void {
  if (flags.site && flags.all) {
    throw new OpsError(
      '--site and --all are mutually exclusive.',
      'Use either --site <name> for one registered site, or --all for every registered site.',
    );
  }
}

/**
 * Registry site names: non-empty, no whitespace/control chars, must start
 * alphanumeric. The single implementation lives in core/sites.ts so the
 * registry loader enforces the same charset rule on hand-edited files;
 * re-exported here for the CLI surface (`sites add` input gate).
 */
export { validateSiteName } from '../core/sites.js';
