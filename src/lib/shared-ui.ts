/**
 * Shared UI strings helper — one lookup for the `shared` namespace.
 *
 * Every component that needs cross-page labels (ad labels, copy feedback,
 * video a11y text, …) used to repeat the same three-line dance:
 *
 *   const current = Astro.currentLocale;
 *   const sharedStrings =
 *     current && isLocale(current)
 *       ? ((getUi(current).shared ?? {}) as unknown as Record<string, string>)
 *       : {};
 *
 * Six copies drifted into the codebase, so the lookup lives here now. Call
 * it from a component's frontmatter:
 *
 *   import { currentSharedStrings } from '~/lib/shared-ui';
 *   const sharedStrings = currentSharedStrings(Astro.currentLocale);
 *
 * Non-wiki locales (landing-only htmlLangs like zh — they have no locale
 * JSON) get an empty object, so every caller keeps its own English `??`
 * fallback. Pure function of the locale — no component imports here (lib
 * must never import from src/components, that would be circular).
 */

import { getUi } from '~/i18n/ui';
import { isLocale } from '~/i18n/routing';

/** The `shared` namespace flattened to string labels (nested blocks excluded by callers' usage). */
export type SharedStrings = Record<string, string>;

/**
 * Localized `shared.*` strings for the current page's locale, or `{}` when
 * the locale has no wiki JSON (callers fall back to their English defaults).
 */
export function currentSharedStrings(currentLocale: string | undefined): SharedStrings {
  return currentLocale && isLocale(currentLocale)
    ? ((getUi(currentLocale).shared ?? {}) as unknown as SharedStrings)
    : {};
}

/**
 * Consent wiring shared by CookieConsent.astro (dispatches) and the
 * AdsterraSlot.astro inline script (consumes — the inline script is
 * untranspiled and cannot import, so it hardcodes these values; keep the
 * two in sync).
 *
 * - CONSENT_STORAGE_KEY: localStorage flag written by CookieConsent
 *   ('accepted' | 'declined').
 * - CONSENT_ACCEPTED_EVENT: document-level CustomEvent dispatched whenever
 *   consent becomes known-accepted (returning visitor or banner accept).
 */
export const CONSENT_STORAGE_KEY = 'aw-cookie-consent';
export const CONSENT_ACCEPTED_EVENT = 'aw:consent-accepted';
