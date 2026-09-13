/**
 * Postbuild hardening for the Pagefind bundles (runs right after
 * `pagefind --site dist`).
 *
 * 1. Transpile in place down to ES2018: pagefind-ui.js / pagefind.js ship
 *    untranspiled and full of optional chaining (?.) — a SyntaxError on old
 *    in-app webviews (WeChat X5, pre-13.4 Safari WebKit). PagefindUI then
 *    never mounts and the search dialog opens with no input inside.
 * 2. Cache-bust the runtime fetches with a per-deploy version query. The
 *    zone-level Browser Cache TTL clamps cache-control to 4h, which would
 *    keep serving a fixed bundle (or stale index hashes) for up to 4 hours
 *    after every deploy; a content-hash query on the UI import (HTML), the
 *    entry/worker references (pagefind.js) makes each deploy take effect
 *    immediately. Import specifiers, wasm and fragment assets are untouched.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const dist = join(process.cwd(), 'dist');
const dir = join(dist, 'pagefind');

// 1. Syntax lowering for every bundle.
const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
let lowered = 0;
for (const file of files) {
  const path = join(dir, file);
  const source = await readFile(path, 'utf8');
  const { code } = await transform(source, {
    loader: 'js',
    target: ['es2018'],
    charset: 'utf8',
  });
  if (code !== source) {
    await writeFile(path, code);
    lowered++;
  }
}

// 2. Per-deploy version query (hash of the lowered UI bundle).
const ui = await readFile(join(dir, 'pagefind-ui.js'), 'utf8');
const v = createHash('sha256').update(ui).digest('hex').slice(0, 10);
const versioned = (s) =>
  s.replace(/pagefind-entry\.json|pagefind-worker\.js|pagefind\.js/g, (m) => `${m}?v=${v}`);

for (const file of files) {
  const path = join(dir, file);
  const source = await readFile(path, 'utf8');
  const next = versioned(source);
  if (next !== source) await writeFile(path, next);
}

// 3. Version the UI import in every built HTML page.
const walkHtml = async (d) => {
  const entries = [];
  for (const name of await readdir(d, { withFileTypes: true })) {
    const p = join(d, name.name);
    if (name.isDirectory()) entries.push(...(await walkHtml(p)));
    else if (name.name.endsWith('.html')) entries.push(p);
  }
  return entries;
};
const htmlPages = await walkHtml(dist);
let bustHtml = 0;
for (const path of htmlPages) {
  const source = await readFile(path, 'utf8');
  if (!source.includes('/pagefind/pagefind-ui.js')) continue;
  await writeFile(path, source.replaceAll('/pagefind/pagefind-ui.js', `/pagefind/pagefind-ui.js?v=${v}`));
  bustHtml++;
}

console.log(
  `[transpile-pagefind] lowered ${lowered}/${files.length} bundles to ES2018; ` +
    `cache-bust v=${v} applied to ${bustHtml} pages`,
);
