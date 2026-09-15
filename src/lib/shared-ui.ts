/**
 * Shared UI strings helper — one lookup for the `shared` namespace.
 *
 * Every component that needs cross-page labels (ad labels, copy feedback,
 * video a11y text, …) used to repeat the same three-line lookup dance, each
 * copy re-asserting the result past the type system with a double-hop cast.
 * Six drifted copies later, the lookup lives here. Call it from a
 * component's frontmatter:
 *
 *   import { currentSharedStrings } from '~/lib/shared-ui';
 *   const sharedStrings = currentSharedStrings(Astro.currentLocale);
 *
 * The result is typed as `Partial<SharedUi>` — the real en.json structure,
 * every key optional. Non-wiki locales (landing-only htmlLangs like zh —
 * they have no locale JSON) get an empty object, so every caller keeps its
 * own English `??` fallback; a typo'd key fails typecheck instead of
 * silently rendering `undefined`. Pure function of the locale — no
 * component imports here (lib must never import from src/components, that
 * would be circular).
 */

import { getUi, type SharedUi } from '~/i18n/ui';
import { isLocale } from '~/i18n/routing';

/**
 * Localized `shared.*` strings for the current page's locale, or `{}` when
 * the locale has no wiki JSON (callers fall back to their English defaults).
 */
export type SharedStrings = Partial<SharedUi>;

export function currentSharedStrings(currentLocale: string | undefined): SharedStrings {
  return currentLocale && isLocale(currentLocale) ? getUi(currentLocale).shared : {};
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
