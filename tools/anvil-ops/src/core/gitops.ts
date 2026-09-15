import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { defaultRun, runValidation, type RunFn } from './content.js';
import { loadSiteConfig } from './site.js';
import { OpsError } from './errors.js';

export interface SubmitResult {
  branch: string;
  prUrl: string;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// --- staged-secret safety net ------------------------------------------------

/**
 * Filename-level secret patterns: .env* files, PEM/key files, and
 * *-secret.json (mirrors the repo's own .gitignore key patterns
 * `*-secret.json` / `*.pem` / `*.key`).
 */
export function looksLikeSecretFile(path: string): boolean {
  return /(^|\/)\.env($|\.)/.test(path) || /\.(pem|key)$/i.test(path) || /-secret\.json$/i.test(path);
}

// Content-scan budget: a Google service-account key is ~2-3 KB; 64 KB covers
// padded/exported variants without reading multi-megabyte JSON into memory.
const SECRET_SCAN_BYTES = 64 * 1024;
// PEM family headers all share "BEGIN ... PRIVATE KEY" (RSA/EC/ENCRYPTED variants included).
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// GSC key JSON shape: {"type": "service_account", ..., "private_key": "-----BEGIN..."}
const PRIVATE_KEY_JSON_FIELD = /"private_key"\s*:/;

function readFileHead(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export interface StagedSecretHit {
  path: string;
  reason: string;
}

/** The key file .env's GSC_SERVICE_ACCOUNT_JSON points at (undefined for inline JSON / no .env). */
function gscKeyPathFromDotenv(root: string): string | undefined {
  let raw: string | undefined;
  try {
    raw = parseDotenv(readFileSync(join(root, '.env'), 'utf8'))['GSC_SERVICE_ACCOUNT_JSON'];
  } catch {
    return undefined; // no .env / unreadable — nothing to cross-check
  }
  const v = raw?.trim();
  if (!v || v.startsWith('{')) return undefined; // inline JSON lives in .env itself, not as a file
  return resolve(root, v);
}

/**
 * Multi-layer sweep of what `git add -A` just staged. The original filename
 * net (`.env` only) missed Google-style key files (anvilwiki-1234-abcd.json)
 * that users drop in the repo root — staging one pushed a live private key to
 * the (usually public) origin on the very next commit. Layers:
 *   1. filename patterns (.env*, *.pem, *.key, *-secret.json);
 *   2. content scan of staged .json / extensionless files for private-key
 *      material (first 64 KB);
 *   3. the exact key file referenced by .env's GSC_SERVICE_ACCOUNT_JSON.
 * `root` is the git toplevel (= site.root; submit aborts earlier otherwise) —
 * `git diff --cached --name-only` paths are relative to it.
 */
export function findStagedSecrets(stagedFiles: string[], root: string): StagedSecretHit[] {
  const hits = new Map<string, string>();
  for (const f of stagedFiles) {
    if (looksLikeSecretFile(f)) hits.set(f, 'matches a secret filename pattern (.env*, *.pem, *.key, *-secret.json)');
  }
  const gscKeyPath = gscKeyPathFromDotenv(root);
  if (gscKeyPath) {
    for (const f of stagedFiles) {
      if (hits.has(f)) continue;
      if (resolve(root, f) === gscKeyPath) hits.set(f, 'is the GSC service account key referenced by .env (GSC_SERVICE_ACCOUNT_JSON)');
    }
  }
  for (const f of stagedFiles) {
    if (hits.has(f)) continue;
    // Only .json and extensionless files carry hidden key material with any
    // plausibility; everything else has a type-specific extension.
    if (!/\.json$/i.test(f) && /\.[^/]+$/.test(f)) continue;
    const abs = join(root, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue; // staged deletion — nothing on disk to leak
    }
    if (!st.isFile() || st.size === 0) continue;
    const head = readFileHead(abs, SECRET_SCAN_BYTES);
    if (PRIVATE_KEY_BLOCK.test(head) || PRIVATE_KEY_JSON_FIELD.test(head)) {
      hits.set(f, 'contains private-key material (PEM block or "private_key" JSON field)');
    }
  }
  return [...hits.entries()].map(([path, reason]) => ({ path, reason }));
}

// --- submit orchestration ----------------------------------------------------

export async function submit(opts: { cwd: string; title?: string; base?: string; run?: RunFn }): Promise<SubmitResult> {
  const run = opts.run ?? defaultRun;
  const site = loadSiteConfig(opts.cwd);

  // 1. require a dirty worktree — never submit nothing
  const status = run('git', ['status', '--porcelain'], { cwd: opts.cwd });
  if (!status.stdout.trim()) {
    throw new OpsError(
      'No uncommitted changes to submit.',
      'Write content first (agent flow: .agent/skills/anvil-new-article), or make the config/content change you want to publish, then re-run submit.',
    );
  }

  // 1.5 Monorepo guard: `git add -A` stages the ENTIRE git worktree. When the
  // site root is a subdirectory of a bigger repo (monorepo, dotfiles repo), a
  // submit from here would sweep unrelated changes into the PR. Abort loudly
  // instead of guessing. realpathSync normalizes macOS /var -> /private/var
  // symlink noise so tmp/git paths compare equal.
  const toplevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: opts.cwd });
  if (toplevel.status === 0 && toplevel.stdout.trim()) {
    const gitRoot = toplevel.stdout.trim();
    const norm = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    if (norm(gitRoot) !== norm(site.root)) {
      throw new OpsError(
        `Refusing to submit: the git repository root (${gitRoot}) is not the site root (${site.root}).`,
        'submit stages the whole git worktree (git add -A), so running it inside a larger repo would sweep unrelated changes into the PR. Run anvil-ops from a checkout whose root IS the site repo (register it with `anvil-ops sites add <name> /path` and use --site). Nothing was staged, committed, or pushed.',
      );
    }
  }

  // 2. full validation gate before any git mutation — fail fast, no PR
  const validation = runValidation({ cwd: site.root, run });
  const failed = validation.filter((v) => !v.ok);
  if (failed.length > 0) {
    throw new OpsError(
      `Validation failed: ${failed.map((f) => f.name).join(', ')}. Nothing was committed or pushed.`,
      failed.map((f) => `${f.name}:\n${f.summary}`).join('\n---\n') + '\nFix the issues above, then re-run submit.',
    );
  }

  // 3. branch + commit + push (never main)
  const title = opts.title ?? 'ops: content update via anvil-ops';
  const branch = `ops/submit-${stamp()}`;
  const git = (args: string[]) => run('git', args, { cwd: opts.cwd });

  // Remember where to unwind to: every abort below must leave the user on
  // their original branch with no ops/submit-* branch left behind, or a
  // same-minute re-run would hit "branch already exists" with no way out.
  const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = git(['rev-parse', 'HEAD']);
  const backTo =
    headBranch.status === 0 && headBranch.stdout.trim() && headBranch.stdout.trim() !== 'HEAD'
      ? headBranch.stdout.trim()
      : headSha.status === 0
        ? headSha.stdout.trim()
        : '';

  /** Undo the branch switch (best effort); returns a report of any leftovers. */
  const unwindBranch = (): string => {
    const notes: string[] = [];
    if (backTo) {
      const back = git(['checkout', backTo]);
      if (back.status !== 0) notes.push(`could not switch back to ${backTo}: ${(back.stderr || back.stdout).trim()}`);
    }
    const del = git(['branch', '-D', branch]);
    if (del.status !== 0) notes.push(`could not delete ${branch}: ${(del.stderr || del.stdout).trim()}`);
    return notes.length ? ` Cleanup attempt: ${notes.join('; ')}.` : ' Temporary branch removed; you are back on your original branch.';
  };

  const checkout = git(['checkout', '-b', branch]);
  if (checkout.status !== 0) {
    throw new OpsError(
      `git checkout -b ${branch} failed.`,
      `${checkout.stdout}\n${checkout.stderr}\nFix: a leftover branch from an earlier failed submit is the usual cause — delete it with \`git branch -D ${branch}\` (or wait a minute for a fresh timestamp), then re-run submit.`,
    );
  }
  // Check the add: a failed `git add -A` (stale index.lock, permission error)
  // used to masquerade as a commit failure with misleading guidance.
  const add = git(['add', '-A']);
  if (add.status !== 0) {
    const cleanup = unwindBranch();
    throw new OpsError(
      `git add failed. ${cleanup}`,
      `${add.stdout}\n${add.stderr}\nFix: a stale index.lock is the usual cause — remove it (\`rm -f .git/index.lock\` from the repo root) and close other git processes, then re-run submit. Nothing was committed or pushed.`,
    );
  }
  // Safety net for secrets: abort BEFORE anything is committed/pushed. The
  // staged list is the full `git add -A` result — see findStagedSecrets for
  // the three detection layers.
  const staged = git(['diff', '--cached', '--name-only']);
  const stagedFiles = staged.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const secretHits = findStagedSecrets(stagedFiles, site.root);
  if (secretHits.length > 0) {
    const cleanup = unwindBranch();
    const listed = secretHits.map((h) => `${h.path} (${h.reason})`).join(', ');
    throw new OpsError(
      `Refusing to commit staged credential material: ${listed}. ${cleanup}`,
      'Move key files OUTSIDE the repository (e.g. ~/.keys/), then unstage them (git restore --staged <file>), add their names/patterns to .gitignore, and re-run submit. Nothing was committed or pushed.',
    );
  }
  const commit = git(['commit', '-m', title]);
  if (commit.status !== 0) {
    const cleanup = unwindBranch();
    throw new OpsError(`git commit failed. ${cleanup}`, `${commit.stdout}\n${commit.stderr}\nFix: check git user config (user.name/user.email) and re-run. Nothing was committed or pushed.`);
  }
  const push = git(['push', '-u', 'origin', branch]);
  if (push.status !== 0) {
    // Commit already done — "re-run" guidance would collide with "No
    // uncommitted changes". Point at manual push + PR, or backing out.
    throw new OpsError(
      `git push origin ${branch} failed — the commit is preserved on the ${branch} branch and nothing was published.`,
      `${push.stdout}\n${push.stderr}\nFix: repair credentials/remote first (gh auth status, git remote -v), then finish by hand: \`git push -u origin ${branch}\` followed by \`gh pr create\` — or go back with \`git checkout ${backTo || 'main'}\` (the ${branch} branch stays for a retry).`,
    );
  }

  // 4. open PR via gh
  // Validation summaries are raw tool output — fence them so paths/backticks/
  // markdown in check output can't inject GFM into the PR body.
  const body =
    validation.map((v) => `## ${v.name} ${v.ok ? 'PASS' : 'FAIL'}\n\`\`\`\n${v.summary}\n\`\`\``).join('\n\n') +
    '\n\n---\nSubmitted via `anvil-ops submit`. Merge after review; Cloudflare Pages deploys automatically.';
  const pr = run('gh', ['pr', 'create', '--title', title, '--base', opts.base ?? 'main', '--body', body], { cwd: opts.cwd });
  if (pr.status !== 0) {
    throw new OpsError(
      `gh pr create failed — branch ${branch} is pushed with the commit kept on it; you are still on that branch.`,
      `${pr.stdout}\n${pr.stderr}\nFix: ensure gh is authenticated (gh auth status), then run \`gh pr create --title ${JSON.stringify(title)}\` from the repo, or \`git checkout main\` to go back (the ${branch} branch stays for a retry).`,
    );
  }
  return { branch, prUrl: pr.stdout.trim() };
}
