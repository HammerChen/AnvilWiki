import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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
 *   2. content scan of EVERY staged file (first 64 KB) for private-key
 *      material — key material pasted into an .md draft leaks exactly as hard
 *      as a misnamed .json, so there is deliberately no extension gate;
 *   3. the exact key file referenced by .env's GSC_SERVICE_ACCOUNT_JSON.
 * `root` is the git toplevel (= site.root; submit aborts earlier otherwise) —
 * staged paths are relative to it and arrive decoded via listStagedFiles.
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

/**
 * Staged file list for the secret sweep. `-z` + `core.quotePath=false` are
 * load-bearing: with git's default quotePath=true, any non-ASCII / quote /
 * control-char path comes back C-quoted (`"\350\257..."`), and a quoted
 * string matches no filename pattern, fails no content scan on its real
 * path, and never equals the .env-referenced key path — all three
 * safety-net layers would silently miss a staged key file while commit+push
 * proceeded. `\0` separators also make newline-in-filename safe.
 */
export function listStagedFiles(run: RunFn, cwd: string): string[] {
  const staged = run('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z'], { cwd });
  return staged.stdout.split('\0').filter(Boolean);
}

export interface SubmitLock {
  release(): void;
}

/**
 * Cross-process interlock for submit. The CLI and the MCP server (possibly
 * several MCP server processes on one machine) can target the same site, and
 * two concurrent submits would each `git add -A` the worktree and open two
 * PRs for one batch; the in-process submit-mutex (src/mcp/submit-mutex.ts)
 * stays as the fast path, this file lock is the cross-process truth. Keyed by
 * the site realpath (different sites never contend) and stored in tmpdir to
 * dodge .git-layout quirks (a linked worktree's .git is a file). A lock left
 * behind by a crashed run is stolen: the owner pid is liveness-probed
 * (process.kill(pid, 0); EPERM counts as alive — conservative), a dead or
 * unreadable owner is reclaimed, and a lock held for over SUBMIT_LOCK_STALE_MS
 * is stolen even when its pid looks alive (the OS recycles pids, so liveness
 * alone cannot tell a reused pid from a genuine long-running submit).
 */
/** Where a site's submit lock lives (tmpdir, keyed by the site realpath).
 * Exported for tests and for surfacing the exact cleanup path in errors. */
export function submitLockPath(siteRoot: string): string {
  let key: string;
  try {
    key = createHash('sha1').update(realpathSync(siteRoot)).digest('hex').slice(0, 16);
  } catch {
    key = createHash('sha1').update(resolve(siteRoot)).digest('hex').slice(0, 16);
  }
  return join(tmpdir(), `anvil-ops-submit-${key}.lock`);
}

/** 30 min ≈ 2x the worst legitimate hold: the MCP offload watchdog is 10 min
 * and CLI validation includes a build, but a 30-minute hold means the machine
 * is effectively dead anyway — far likelier the pid was recycled. */
const SUBMIT_LOCK_STALE_MS = 30 * 60 * 1000;

export function acquireSubmitLock(siteRoot: string): SubmitLock {
  const lockPath = submitLockPath(siteRoot);
  const pidAlive = (pid: number): boolean => {
    if (pid <= 0 || !Number.isFinite(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      // Line 2 is the creation timestamp — the age-based steal needs it
      // because a recycled pid defeats the liveness probe.
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
      return {
        release(): void {
          try {
            unlinkSync(lockPath);
          } catch {
            /* best effort — a stolen/cleaned lock must not break the caller */
          }
        },
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST' || attempt >= 4) {
        throw new OpsError(
          `Could not acquire the submit lock at ${lockPath}.`,
          'Another submit may be running for this site. If none is, delete the lock file and re-run submit.',
        );
      }
      let ownerPid = -1;
      let createdAt = Number.NaN; // absent → age check disabled (1.0.4-era locks)
      try {
        const [pidLine, tsLine] = readFileSync(lockPath, 'utf8').split('\n');
        ownerPid = Number.parseInt(pidLine.trim(), 10);
        createdAt = Number.parseInt(tsLine?.trim() ?? '', 10);
      } catch {
        ownerPid = -1; // unreadable → treat as dead and steal
      }
      const stale =
        Number.isFinite(createdAt) && Date.now() - createdAt > SUBMIT_LOCK_STALE_MS;
      if (pidAlive(ownerPid) && !stale) {
        throw new OpsError(
          `Another submit is already running for this site (pid ${ownerPid}).`,
          'Wait for it to finish — a lock held for over 30 minutes is stolen automatically on the next run — or, if no submit is actually running, delete the lock file and re-run submit.',
        );
      }
      // Dead owner, or a recycled pid squatting on a >30-min-old lock: steal.
      // unlink+retry converges (last writer wins the wx create).
      try {
        unlinkSync(lockPath);
      } catch {
        /* another waiter stole it first — retry */
      }
    }
  }
}

/**
 * A markdown fence strictly longer than any backtick run inside `s` (min 3),
 * so tool output containing triple backticks can't close the fence early and
 * inject GFM into the PR body.
 */
export function gfmFence(s: string): string {
  const longest = (s.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

export async function submit(opts: { cwd: string; title?: string; base?: string; run?: RunFn }): Promise<SubmitResult> {
  const run = opts.run ?? defaultRun;
  const site = loadSiteConfig(opts.cwd);

  // 1. require a dirty worktree — never submit nothing (cheap read-only
  // probe, taken before the cross-process lock so trivial errors stay cheap)
  const status = run('git', ['status', '--porcelain'], { cwd: opts.cwd });
  if (!status.stdout.trim()) {
    throw new OpsError(
      'No uncommitted changes to submit.',
      'Write content first (agent flow: .agent/skills/anvil-new-article), or make the config/content change you want to publish, then re-run submit.',
    );
  }

  // Cross-process interlock (CLI + MCP + offloaded workers all funnel here).
  const lock = acquireSubmitLock(site.root);
  try {
    return await runSubmit(opts, site, run);
  } finally {
    lock.release();
  }
}

async function runSubmit(
  opts: { cwd: string; title?: string; base?: string; run?: RunFn },
  site: ReturnType<typeof loadSiteConfig>,
  run: RunFn,
): Promise<SubmitResult> {

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
  // the three detection layers and listStagedFiles for why the list must be
  // fetched unquoted.
  const stagedFiles = listStagedFiles(run, opts.cwd);
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
  // markdown in check output can't inject GFM into the PR body. The fence is
  // sized per summary: a longer backtick run inside the output would close a
  // fixed ``` fence early.
  const body =
    validation
      .map((v) => {
        const fence = gfmFence(v.summary);
        return `## ${v.name} ${v.ok ? 'PASS' : 'FAIL'}\n${fence}\n${v.summary}\n${fence}`;
      })
      .join('\n\n') +
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
