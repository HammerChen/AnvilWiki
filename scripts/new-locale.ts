/**
 * new-locale.ts
 *
 * Scaffolds a new UI language: rewrites src/i18n/routing.ts (locales +
 * LOCALE_LABELS), src/i18n/ui.ts (imports + messages map), copies
 * src/locales/en.json → src/locales/<locale>.json, and creates the content
 * directory src/content/wiki/<locale>/.
 *
 * Adding a language manually means touching 4 places in sync — exactly the
 * mechanical-but-error-prone work a script should own (AGENTS.md rule #5).
 *
 * Usage:
 *   pnpm new-locale            # interactive: asks for the locale code
 *   pnpm new-locale zh         # one-shot
 *
 * After running: translate the copied <locale>.json (it starts as an English
 * clone) and drop translated MDX under src/content/wiki/<locale>/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLinePrompt } from './lib/prompt';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');
const write = (p: string, content: string) =>
  fs.writeFileSync(path.resolve(ROOT, p), content, 'utf8');

const KNOWN_LABELS: Record<string, string> = {
  en: 'English',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  id: 'Bahasa Indonesia',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  tr: 'Türkçe',
  pl: 'Polski',
};

/**
 * replace() + proof it matched. A silent no-op rewrite would print "✅ added"
 * while leaving the file untouched — a half-applied state the user only
 * discovers at the next (skipped) typecheck.
 */
function mustReplace(
  content: string,
  re: RegExp,
  replacement: string | ((substring: string, ...groups: string[]) => string),
  what: string,
): string {
  if (!re.test(content)) {
    console.error(`❌ Could not apply the ${what} rewrite — the source pattern did not match. Edit the file manually.`);
    process.exit(1);
  }
  // String.replace overloads reject the union type; both branches return string.
  return typeof replacement === 'string'
    ? content.replace(re, replacement)
    : content.replace(re, replacement);
}

async function main() {
  const rl = createLinePrompt();
  const arg = process.argv[2]?.trim();
  const locale = (
    arg || (await rl.ask('New locale code (e.g. zh, ko, es): '))
  )
    .trim()
    .toLowerCase();
  rl.close();

  if (!/^[a-z]{2,3}$/.test(locale)) {
    console.error(`❌ "${locale}" doesn't look like a locale code (2-3 letters).`);
    process.exit(1);
  }

  // --- 1. routing.ts: locales array + LOCALE_LABELS -------------------------
  const routingPath = 'src/i18n/routing.ts';
  let routing = read(routingPath);
  if (new RegExp(`'${locale}'`).test(routing)) {
    console.error(`❌ "${locale}" is already in ${routingPath}. Nothing to do.`);
    process.exit(1);
  }
  routing = mustReplace(
    routing,
    /export const locales = \[([^\]]+)\] as const;/,
    (_m: string, inner: string) => `export const locales = [${inner.trim()}, '${locale}'] as const;`,
    'routing.ts locales array',
  ) as string;
  const label = KNOWN_LABELS[locale] ?? locale.toUpperCase();
  routing = mustReplace(
    routing,
    /export const LOCALE_LABELS: Record<Locale, string> = \{([\s\S]*?)\n\};/,
    (_m: string, inner: string) =>
      `export const LOCALE_LABELS: Record<Locale, string> = {${inner.replace(/\s*$/, '')}\n  ${locale}: '${label}',\n};`,
    'routing.ts LOCALE_LABELS map',
  ) as string;
  write(routingPath, routing);
  console.log(`✅ ${routingPath} — added '${locale}' (${label})`);

  // --- 2. ui.ts: import + messages entry ------------------------------------
  const uiPath = 'src/i18n/ui.ts';
  let ui = read(uiPath);
  ui = mustReplace(
    ui,
    // The PATH side accepts hyphens ([\w-]+) — same shape as UI_IMPORT_BLOCK_RE
    // in lib/apply-rewrites.ts (v2.25.0): with `\w+` only, a re-run next to a
    // `zh-tw.json` import matched nothing and failed with ❌.
    /(import \w+ from '~\/locales\/[\w-]+\.json';\n)(?!(?:import \w+ from '~\/locales\/[\w-]+\.json';\n)+)/,
    `$1import ${locale} from '~/locales/${locale}.json';\n`,
    'ui.ts locale import',
  );
  ui = mustReplace(
    ui,
    /const messages: Record<Locale, Record<string, unknown>> = \{([\s\S]*?)\n\};/,
    (_m: string, inner: string) =>
      `const messages: Record<Locale, Record<string, unknown>> = {${inner.replace(/\s*$/, '')}\n  ${locale}: ${locale} as Record<string, unknown>,\n};`,
    'ui.ts messages map',
  );
  write(uiPath, ui);
  console.log(`✅ ${uiPath} — import + messages entry added`);

  // --- 3. locales/<locale>.json — clone of en.json (translate from here) ----
  const jsonPath = `src/locales/${locale}.json`;
  if (!fs.existsSync(path.resolve(ROOT, jsonPath))) {
    write(jsonPath, read('src/locales/en.json'));
    console.log(`✅ ${jsonPath} — created (English clone; translate the strings)`);
  } else {
    console.log(`ℹ️  ${jsonPath} already exists — left untouched.`);
  }

  // --- 4. content directory --------------------------------------------------
  const contentDir = path.resolve(ROOT, 'src/content/wiki', locale);
  fs.mkdirSync(contentDir, { recursive: true });
  console.log(`✅ src/content/wiki/${locale}/ — created (drop translated MDX here)`);

  console.log('\n📌 Next steps:');
  console.log(`   • Translate src/locales/${locale}.json (starts as English).`);
  console.log(`   • Copy + translate MDX under src/content/wiki/${locale}/<category>/.`);
  console.log('   • Run pnpm check-config to verify three-place consistency.');
  console.log('   • Run pnpm build — /' + locale + '/ routes will be generated automatically.');
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
