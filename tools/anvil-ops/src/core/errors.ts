export class OpsError extends Error {
  constructor(
    message: string,
    public readonly fix: string,
    /**
     * Stable machine-readable discriminator (e.g. 'no-analytics-source') so
     * sibling modules can branch on an error without matching prose — wording
     * changes must never flip behavior. Optional: existing errors keep their
     * 2-arg constructor, new errors carry a code only when another module
     * actually needs to branch on it.
     */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

/**
 * Corrupt site config (wrangler.toml that no longer parses). Deliberately NOT
 * an OpsError: resolveEffectiveRoot treats an OpsError from loadSiteConfig as
 * "no site config here" and falls back to another registered site — a corrupt
 * wrangler.toml must surface loudly at the repo it was found in instead of
 * silently redirecting a write command like submit to someone else's repo.
 */
export class ConfigParseError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Failed to parse ${path}: ${cause instanceof Error ? cause.message : String(cause)} — check wrangler.toml syntax (section headers like [vars] need closing brackets, values need quotes).`,
    );
    this.name = 'ConfigParseError';
  }
}
