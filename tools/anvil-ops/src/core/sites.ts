import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { OpsError } from './errors.js';
import { loadSiteConfig } from './site.js';

export interface RegistrySite {
  name: string;
  path: string;
  siteUrl?: string;
}

export interface SitesRegistry {
  /** Used when --site is omitted and the cwd has no site config (MCP default). */
  defaultSite?: string;
  sites: RegistrySite[];
}

export interface ListedSite extends RegistrySite {
  /** path does not exist on disk right now (reported, not an error — repos move). */
  missing: boolean;
}

const REGISTRY_HEADER = [
  '# anvil-ops multi-site registry. Managed by `anvil-ops sites add/remove`.',
  '# Credentials NEVER live here — each site reads its own .env at its path.',
  '# defaultSite is used when --site is omitted and the cwd has no site config (MCP default).',
].join('\n');

export function sitesRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'anvil-ops', 'sites.toml');
}

function siteSummary(registry: SitesRegistry): string {
  return registry.sites.length
    ? `Available sites: ${registry.sites.map((s) => s.name).join(', ')}`
    : 'The sites registry is empty.';
}

/**
 * Registry site names: non-empty, no whitespace/control chars, must start
 * alphanumeric. Keeps `sites list` tables and `--site <name>` ergonomics sane.
 * Lives in core so HAND-EDITED registries are validated by the same rule as
 * `sites add` input (src/cli/flags.ts re-exports this for the CLI surface).
 */
export function validateSiteName(name: string): string {
  const n = name.trim();
  if (!n) {
    throw new OpsError('Site name must not be empty.', 'Use a short slug, e.g. `anvil-ops sites add main-wiki /path/to/repo`.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) {
    throw new OpsError(
      `Site name "${name}" contains unsupported characters.`,
      'Use letters, digits, dots, dashes and underscores, starting alphanumeric (e.g. main-wiki, site2).',
    );
  }
  return n;
}

function validateSite(site: RegistrySite, index: number): void {
  const label = `sites[${index}]`;
  if (!site.name?.trim()) {
    throw new OpsError(
      `Invalid sites registry entry ${label}: name is required.`,
      'Every [[sites]] entry needs a non-empty name. Fix the file or re-add the site with `anvil-ops sites add <name> <path>`.',
    );
  }
  // Hand-edited files bypass `sites add` — enforce the SAME charset rule or a
  // name like "my site" breaks --site lookups quietly.
  try {
    validateSiteName(site.name);
  } catch {
    throw new OpsError(
      `Invalid sites registry entry ${label}: name "${site.name}" contains unsupported characters (allowed: letters, digits, dots, dashes, underscores; must start alphanumeric).`,
      `Fix the name of entry ${index} in the registry file, or remove and re-add the site with \`anvil-ops sites remove\` + \`sites add\`.`,
    );
  }
  if (!site.path || !isAbsolute(site.path)) {
    throw new OpsError(
      `Invalid sites registry entry ${label} (${site.name}): path must be an absolute path, got "${site.path}".`,
      `Set path = "/absolute/path/to/repo" under [[sites]] for ${site.name}, or re-add the site with \`anvil-ops sites add ${site.name} /absolute/path\`.`,
    );
  }
}

export function loadSitesRegistry(path?: string): SitesRegistry {
  const p = path ?? sitesRegistryPath();
  if (!existsSync(p)) return { sites: [] };
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new OpsError(
      `Failed to parse sites registry at ${p}: ${e instanceof Error ? e.message : String(e)}`,
      'Fix the TOML syntax (comments start with #) or delete the file and re-add your sites with `anvil-ops sites add <name> <path>`.',
    );
  }
  const raw = parsed as { defaultSite?: unknown; sites?: unknown };
  const entries = Array.isArray(raw.sites) ? raw.sites : [];
  if (raw.sites !== undefined && !Array.isArray(raw.sites)) {
    throw new OpsError(
      `Invalid sites registry at ${p}: [[sites]] must be an array of tables.`,
      'Each site is a `[[sites]]` table with name, path and optional siteUrl. See `anvil-ops sites add --help`.',
    );
  }
  const sites = entries.map((entry, i) => {
    const s = entry as Partial<RegistrySite>;
    const site: RegistrySite = {
      name: typeof s.name === 'string' ? s.name : '',
      path: typeof s.path === 'string' ? s.path : '',
      siteUrl: typeof s.siteUrl === 'string' && s.siteUrl.trim() ? s.siteUrl : undefined,
    };
    validateSite(site, i);
    return site;
  });
  const registry: SitesRegistry = { sites };
  if (typeof raw.defaultSite === 'string' && raw.defaultSite.trim()) registry.defaultSite = raw.defaultSite;
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.name)) {
      throw new OpsError(
        `Invalid sites registry at ${p}: duplicate site name "${s.name}".`,
        'Site names must be unique. Remove the duplicate entry, or rename one site with `anvil-ops sites remove` + `sites add`.',
      );
    }
    seen.add(s.name);
  }
  return registry;
}

export function saveSitesRegistry(registry: SitesRegistry, path?: string): void {
  for (let i = 0; i < registry.sites.length; i++) validateSite(registry.sites[i]!, i);
  const names = new Set<string>();
  for (const s of registry.sites) {
    if (names.has(s.name)) {
      throw new OpsError(
        `Duplicate site name "${s.name}" — site names must be unique.`,
        'Pick a different name for the new site, or remove the existing one first with `anvil-ops sites remove`.',
      );
    }
    names.add(s.name);
  }
  // TOML has no null/undefined: omit optional keys entirely instead of writing them.
  const doc: Record<string, unknown> = {};
  if (registry.defaultSite) doc.defaultSite = registry.defaultSite;
  const sites = registry.sites.map((s) => {
    const entry: Record<string, string> = { name: s.name, path: s.path };
    if (s.siteUrl) entry.siteUrl = s.siteUrl;
    return entry;
  });
  if (sites.length) doc.sites = sites;
  const p = path ?? sitesRegistryPath();
  mkdirSync(dirname(p), { recursive: true });
  // Temp-file + rename: a crash mid-write (or a concurrent `sites add`) must
  // never leave a truncated TOML that takes the whole registry down.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, (sites.length ? REGISTRY_HEADER + '\n\n' : '') + stringifyToml(doc) + '\n');
  renameSync(tmp, p);
}

export function resolveSitePath(name: string, path?: string): string {
  const registry = loadSitesRegistry(path);
  const site = registry.sites.find((s) => s.name === name);
  if (!site) {
    throw new OpsError(
      `Site "${name}" is not in the sites registry (${path ?? sitesRegistryPath()}). ${siteSummary(registry)}`,
      'Add it with `anvil-ops sites add <name> /absolute/path/to/repo`, or run inside a site repo to use cwd auto-discovery.',
    );
  }
  return site.path;
}

export function listSites(path?: string): ListedSite[] {
  const registry = loadSitesRegistry(path);
  return registry.sites.map((s) => ({ ...s, missing: !existsSync(s.path) }));
}

/**
 * Where a command should actually run.
 * - explicit site name wins (registry lookup);
 * - otherwise cwd auto-discovery (0.1.3 behavior);
 * - only when cwd has NO site config does defaultSite kick in (MCP default).
 */
export function resolveEffectiveRoot(opts: { site?: string; cwd: string; registryPath?: string }): string {
  if (opts.site) return resolveSitePath(opts.site, opts.registryPath);
  try {
    loadSiteConfig(opts.cwd);
    return opts.cwd;
  } catch (e) {
    // Only "no site config found" may fall through to defaultSite. A CORRUPT
    // wrangler.toml (TOML parse error) must surface — silently redirecting a
    // write command like submit_pr to another registered site's repo is the
    // worst possible interpretation of "cwd has no config".
    if (e instanceof OpsError) {
      const registry = loadSitesRegistry(opts.registryPath);
      if (registry.defaultSite) return resolveSitePath(registry.defaultSite, opts.registryPath);
      return opts.cwd; // let the command surface its own "no site config" OpsError
    }
    throw e;
  }
}
