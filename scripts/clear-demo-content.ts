/**
 * clear-demo-content.ts — content-aware demo article removal for the
 * setup.yml (zero-terminal) channel, single-sourced with apply-template's
 * "Clear demo content?" through lib/apply-rewrites.ts (classifyWikiArticles).
 *
 * Deletes only files positively identified as demo content (authored around
 * the demo game, same rule as isDemoLocaleContent for locale JSONs); anything
 * else under src/content/wiki/ — the forker's own articles, rewrites of
 * demo-path files, scaffolds — is kept with a loud warning. A re-run must
 * never destroy user work.
 *
 *   pnpm exec tsx scripts/clear-demo-content.ts [--dry-run]
 *
 * Position in setup.yml: AFTER `pnpm install` (tsx needs node_modules) and
 * BEFORE `pnpm build` (demo articles carry demo categories the rewritten
 * navigation no longer declares — the build must see the cleared tree).
 * Unlike apply-template's clearDemoContent this does NOT prune emptied
 * category dirs — the workflow's find -delete never did either, and the
 * chosen-category set is not known on this channel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyWikiArticles, type WikiArticleEntry } from './lib/apply-rewrites';
import { walkFiles } from './lib/walk';

const DRY_RUN = process.argv.includes('--dry-run');

function main(): void {
  const base = path.resolve(process.cwd(), 'src/content/wiki');
  if (!fs.existsSync(base)) {
    console.log('No src/content/wiki — nothing to clear.');
    return;
  }
  // Shared walker (full recursion + stable sort) — the same file order
  // apply-template's "Clear demo content" reports, so both channels warn
  // identically. rel keeps the forward-slash `locale/category/file` shape.
  const entries: WikiArticleEntry[] = walkFiles(base, { exts: ['.mdx', '.md'] }).map((p) => ({
    rel: path.relative(base, p).split(path.sep).join('/'),
    src: fs.readFileSync(p, 'utf8'),
  }));
  const { demo, kept } = classifyWikiArticles(entries);
  for (const file of demo) {
    console.log(`🗑️  demo article: src/content/wiki/${file.rel}`);
    if (!DRY_RUN) fs.unlinkSync(path.join(base, file.rel));
  }
  for (const file of kept) {
    console.warn(`⚠️  kept (not demo content — never mentions the demo game): src/content/wiki/${file.rel}`);
  }
  console.log(
    `${DRY_RUN ? 'Would remove' : 'Removed'} ${demo.length} demo article(s), kept ${kept.length} file(s).`,
  );
}

main();
