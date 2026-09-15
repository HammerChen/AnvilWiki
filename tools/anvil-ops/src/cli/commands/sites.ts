import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadSitesRegistry,
  saveSitesRegistry,
  sitesRegistryPath,
  listSites,
  type RegistrySite,
} from '../../core/sites.js';
import { OpsError } from '../../core/errors.js';
import { validateSiteName } from '../flags.js';

function pad(cell: string, width: number): string {
  return cell + ' '.repeat(Math.max(0, width - cell.length));
}

export function sitesListCommand(): number {
  const path = sitesRegistryPath();
  const sites = listSites(path);
  process.stdout.write(`Sites registry: ${path}\n`);
  if (sites.length === 0) {
    process.stdout.write('No sites registered. Add one with `anvil-ops sites add <name> /absolute/path/to/repo`.\n');
    return 0;
  }
  const rows = sites.map((s) => ({
    name: s.name,
    path: s.path,
    siteUrl: s.siteUrl ?? '-',
    status: s.missing ? 'missing' : 'ok',
  }));
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    path: Math.max(4, ...rows.map((r) => r.path.length)),
    siteUrl: Math.max(7, ...rows.map((r) => r.siteUrl.length)),
  };
  process.stdout.write(
    [pad('name', w.name), pad('path', w.path), pad('siteUrl', w.siteUrl), 'status'].join('  ') + '\n',
  );
  for (const r of rows) {
    process.stdout.write([pad(r.name, w.name), pad(r.path, w.path), pad(r.siteUrl, w.siteUrl), r.status].join('  ') + '\n');
  }
  const missing = rows.filter((r) => r.status === 'missing');
  if (missing.length) {
    process.stdout.write(
      `${missing.length} site(s) point at a path that no longer exists — fix or \`anvil-ops sites remove <name>\`.\n`,
    );
  }
  return 0;
}

export function sitesAddCommand(opts: { name: string; path: string; url?: string }): number {
  const name = validateSiteName(opts.name);
  const path = resolve(opts.path);
  if (!existsSync(path)) {
    throw new OpsError(
      `Path does not exist: ${path}`,
      'Register an existing checkout of the site repo (the directory with wrangler.toml / .env).',
    );
  }
  if (!statSync(path).isDirectory()) {
    throw new OpsError(
      `Path is not a directory: ${path}`,
      'Register the checkout directory itself (the folder containing wrangler.toml / .env), not a file inside it.',
    );
  }
  const registryPath = sitesRegistryPath();
  const registry = loadSitesRegistry(registryPath);
  if (registry.sites.some((s) => s.name === name)) {
    throw new OpsError(
      `Site "${name}" is already registered (-> ${registry.sites.find((s) => s.name === name)!.path}).`,
      `Remove it first (\`anvil-ops sites remove ${name}\`) or pick another name.`,
    );
  }
  const site: RegistrySite = { name, path };
  if (opts.url) site.siteUrl = opts.url.trim().replace(/\/+$/, '');
  registry.sites.push(site);
  saveSitesRegistry(registry, registryPath);
  process.stdout.write(`Added site "${name}" -> ${path}${site.siteUrl ? ` (siteUrl ${site.siteUrl})` : ''}\n`);
  process.stdout.write(`Registry: ${registryPath}\n`);
  return 0;
}

export function sitesRemoveCommand(name: string): number {
  const registryPath = sitesRegistryPath();
  const registry = loadSitesRegistry(registryPath);
  const site = registry.sites.find((s) => s.name === name);
  if (!site) {
    throw new OpsError(
      `Site "${name}" is not in the sites registry. ${
        registry.sites.length ? `Available sites: ${registry.sites.map((s) => s.name).join(', ')}` : 'The registry is empty.'
      }`,
      'Check the name with `anvil-ops sites list`.',
    );
  }
  registry.sites = registry.sites.filter((s) => s.name !== name);
  if (registry.defaultSite === name) registry.defaultSite = undefined;
  saveSitesRegistry(registry, registryPath);
  process.stdout.write(`Removed site "${name}" (was ${site.path}).\n`);
  return 0;
}
