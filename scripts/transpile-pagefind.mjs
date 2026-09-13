/**
 * Transpile Pagefind's bundles down to ES2018 in place (runs in postbuild,
 * right after `pagefind --site dist`).
 *
 * Why: pagefind-ui.js / pagefind.js ship untranspiled and full of optional
 * chaining (?.) — a SyntaxError on old in-app webviews (WeChat X5, pre-13.4
 * Safari WebKit). PagefindUI then never mounts and the search dialog opens
 * with no input inside: on those phones search is silently dead. esbuild
 * lowers the syntax in place; import specifiers, the wasm/fragment assets
 * and the minified shape of everything else are untouched.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

const dir = join(process.cwd(), 'dist', 'pagefind');
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

console.log(`[transpile-pagefind] lowered ${lowered}/${files.length} bundles to ES2018`);
