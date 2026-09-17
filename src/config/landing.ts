/**
 * Landing page configuration — text content for the project landing pages
 * at /landing (English) and /zh/landing (中文). They introduce the AnvilWiki
 * template itself, NOT the demo game.
 *
 * This is separate from site.ts (which holds the DEMO GAME config).
 * The landing page represents the PROJECT, so its copy lives here.
 *
 * This is the facade of a 5-module family (split in v2.31.1 to keep every
 * file small; the public API and every import path are unchanged):
 *   - landing-types.ts   LandingLocale + LandingContent
 *   - landing-shared.ts  PROJECT_VERSION + GitHub URLs + COMMUNITY_SITES
 *   - landing-en.ts      English copy
 *   - landing-zh.ts      Chinese copy
 *
 * 👉 This file is NOT part of the "apply template" config layer — fork users
 *    don't need to touch it. It describes the AnvilWiki open-source project.
 */

export { COMMUNITY_SITES, PROJECT_VERSION } from './landing-shared';
export type { LandingContent, LandingLocale } from './landing-types';

import { en } from './landing-en';
import { zh } from './landing-zh';
import type { LandingContent, LandingLocale } from './landing-types';

export const landingContent: Record<LandingLocale, LandingContent> = { en, zh };

/** Landing-page routes per locale (for language switching + hreflang). */
/**
 * Landing root URL for a landing locale. trailingSlash:'always' — every
 * internal link must end "/" or each visit 308s once (see lib/url.ts).
 * Consumed by LandingLayout for the logo href and the language-switcher
 * fallback, so the slash lives here rather than at the call sites.
 */
export const landingPath = (locale: LandingLocale) =>
  locale === 'en' ? '/landing/' : `/zh/landing/`;
