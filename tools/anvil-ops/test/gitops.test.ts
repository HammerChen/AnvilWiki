import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireSubmitLock, findStagedSecrets, gfmFence, listStagedFiles, looksLikeSecretFile, submit, submitLockPath } from '../src/core/gitops.js';
import { defaultRun, type RunFn } from '../src/core/content.js';
import { OpsError } from '../src/core/errors.js';

interface Scripted {
  cmd: string;
  args: string[];
}

function scriptedRun(
  responses: (c: Scripted) => { status: number | null; stdout: string; stderr: string },
): RunFn & { calls: Scripted[] } {
  const calls: Scripted[] = [];
  const fn = ((cmd: string, args: string[], _opts: { cwd: string }) => {
    calls.push({ cmd, args });
    return responses({ cmd, args });
  }) as RunFn;
  (fn as unknown as { calls: Scripted[] }).calls = calls;
  return fn as RunFn & { calls: Scripted[] };
}

const ok = { status: 0, stdout: '', stderr: '' };

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-gitops-unit-'));
  writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
  return dir;
}

/** Scripted-run shorthand: dirty worktree + toplevel answers pointing at `repo`. */
function gitFlow(responses: (c: Scripted) => { status: number | null; stdout: string; stderr: string }, repo: string) {
  return scriptedRun((c) => {
    if (c.args[0] === 'status') return { ...ok, stdout: 'M file.mdx\n' };
    if (c.args[0] === 'rev-parse' && c.args[1] === '--show-toplevel') return { ...ok, stdout: repo + '\n' };
    return responses(c);
  });
}

describe('submit orchestration', () => {
  it('no uncommitted changes -> OpsError, nothing else runs', async () => {
    const run = scriptedRun((c) => (c.args[0] === 'status' ? { ...ok, stdout: '' } : ok));
    await expect(submit({ cwd: tmpRepo(), run })).rejects.toMatchObject({ name: 'OpsError' });
    expect(run.calls).toHaveLength(1);
  });

  it('validation failure -> OpsError before any checkout', async () => {
    const run = scriptedRun((c) => {
      if (c.args[0] === 'status') return { ...ok, stdout: 'M file.mdx\n' };
      if (c.cmd === 'pnpm' && c.args[0] === 'check-content') return { status: 1, stdout: 'H1 found', stderr: '' };
      return ok;
    });
    await expect(submit({ cwd: tmpRepo(), run })).rejects.toMatchObject({ name: 'OpsError' });
    expect(run.calls.some((c) => c.args.includes('checkout'))).toBe(false);
  });

  it('happy path: branch, commit, push, gh pr create; PR body contains fenced validation output', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.cmd === 'gh') return { ...ok, stdout: 'https://github.com/o/r/pull/9\n' };
      return ok;
    }, repo);
    const r = await submit({ cwd: repo, title: 'add boss guide', run });
    expect(r.branch).toMatch(/^ops\/submit-\d{8}-\d{4}$/);
    expect(r.prUrl).toBe('https://github.com/o/r/pull/9');
    const gh = run.calls.find((c) => c.cmd === 'gh')!;
    expect(gh.args[0]).toBe('pr');
    const body = gh.args[gh.args.indexOf('--body') + 1];
    expect(body).toContain('check-content');
    // validation summaries are raw tool output — must be fenced (GFM injection)
    expect(body).toContain('```\n');
    const push = run.calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toContain(r.branch);
  });
});

describe('submit failure cleanup', () => {
  it('staged-secrets abort: switches back to the original branch and deletes the temp branch', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: '.env\0' };
      return ok;
    }, repo);
    await expect(submit({ cwd: repo, run })).rejects.toMatchObject({ name: 'OpsError' });
    const calls = run.calls;
    const diffIdx = calls.findIndex((c) => c.args.includes('diff'));
    const backIdx = calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === 'main');
    const delIdx = calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D');
    expect(backIdx).toBeGreaterThan(diffIdx);
    expect(delIdx).toBeGreaterThan(backIdx);
    expect(delIdx).toBeGreaterThan(-1);
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('staged-secrets abort reports (not swallows) cleanup failures', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: '.env\0' };
      if (c.args[0] === 'checkout' && c.args[1] === 'main') return { status: 1, stdout: '', stderr: 'cannot switch' };
      if (c.args[0] === 'branch') return { status: 1, stdout: '', stderr: 'cannot delete' };
      return ok;
    }, repo);
    const err: OpsError = await submit({ cwd: repo, run }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err.name).toBe('OpsError');
    expect(err.message).toMatch(/could not switch back to main/);
    expect(err.message).toMatch(/could not delete ops\/submit-/);
  });

  it('branch name collision: error carries the exact recovery command, no state change', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args[0] === 'checkout' && c.args[1] === '-b') {
        return { status: 1, stdout: '', stderr: "fatal: a branch named 'ops/submit-20260914-1010' already exists" };
      }
      return ok;
    }, repo);
    const err: OpsError = await submit({ cwd: repo, run }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpsError);
    expect(err.fix).toMatch(/git branch -D ops\/submit-\d{8}-\d{4}/);
    expect(run.calls.some((c) => c.args[0] === 'add')).toBe(false);
    expect(run.calls.some((c) => c.args[0] === 'branch')).toBe(false);
  });

  it('git add failure: unwinds, points at index.lock, never pretends to be a commit error', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args[0] === 'add') return { status: 1, stdout: '', stderr: 'fatal: Unable to create index.lock: File exists' };
      return ok;
    }, repo);
    const err: OpsError = await submit({ cwd: repo, run }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpsError);
    expect(err.fix).toMatch(/index\.lock/);
    // unwound to the original branch, temp branch deleted
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === 'main')).toBe(true);
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);
    expect(run.calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  it('push failure: keeps branch+commit, points at manual push + gh pr create (not "re-run")', async () => {
    const repo = tmpRepo();
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args[0] === 'push') return { status: 128, stdout: '', stderr: 'fatal: Authentication failed' };
      return ok;
    }, repo);
    const err: OpsError = await submit({ cwd: repo, run }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toMatch(/preserved/i);
    expect(err.fix).toMatch(/git push -u origin ops\/submit-\d{8}-\d{4}/);
    expect(err.fix).toMatch(/gh pr create/);
    expect(err.fix).toMatch(/git checkout main/);
    // branch + commit are NOT undone on push failure
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false);
    expect(run.calls.some((c) => c.cmd === 'gh')).toBe(false);
  });

  it('monorepo guard: git toplevel != site root aborts loudly before anything is staged', async () => {
    const repo = tmpRepo();
    const monorepoRun = scriptedRun((c) => {
      if (c.args[0] === 'status') return { ...ok, stdout: 'M file.mdx\n' };
      if (c.args[0] === 'rev-parse' && c.args[1] === '--show-toplevel') return { ...ok, stdout: '/home/user/big-monorepo\n' };
      return ok;
    });
    const err: OpsError = await submit({ cwd: repo, run: monorepoRun }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toMatch(/not the site root/);
    expect(err.fix).toMatch(/sites add|--site/);
    expect(monorepoRun.calls.some((c) => c.args[0] === 'add')).toBe(false);
    expect(monorepoRun.calls.some((c) => c.args[0] === 'checkout')).toBe(false);
    expect(monorepoRun.calls.some((c) => c.cmd === 'pnpm')).toBe(false);
  });
});

describe('staged-secret safety net layers', () => {
  function stageHit(responses: (c: Scripted) => { status: number | null; stdout: string; stderr: string }, repo: string) {
    return submit({ cwd: repo, run: gitFlow(responses, repo) }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e: OpsError) => e,
    );
  }

  it('filename layer: a staged *.pem aborts with the file named', async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, 'server.pem'), 'not really a key\n');
    const err = await stageHit((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: 'server.pem\0' };
      return ok;
    }, repo);
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toContain('server.pem');
    expect(err.fix).toMatch(/restore --staged/);
    expect(err.fix).toMatch(/Nothing was committed or pushed/);
  });

  it('content layer: GSC key JSON under an innocent name aborts on private-key material', async () => {
    const repo = tmpRepo();
    writeFileSync(
      join(repo, 'anvilwiki-1234-abc.json'),
      JSON.stringify({ type: 'service_account', project_id: 'x', private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n' }),
    );
    const err = await stageHit((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: 'anvilwiki-1234-abc.json\0' };
      return ok;
    }, repo);
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toContain('anvilwiki-1234-abc.json');
    expect(err.message).toMatch(/private-key material/);
  });

  it('.env path layer: the GSC_SERVICE_ACCOUNT_JSON target aborts even with an innocent name', async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, '.env'), 'GSC_SERVICE_ACCOUNT_JSON=./gsc-robot.txt\n');
    writeFileSync(join(repo, 'gsc-robot.txt'), 'placeholder bytes\n');
    const err = await stageHit((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: 'gsc-robot.txt\0' };
      return ok;
    }, repo);
    expect(err).toBeInstanceOf(OpsError);
    expect(err.message).toContain('gsc-robot.txt');
    expect(err.message).toMatch(/GSC_SERVICE_ACCOUNT_JSON/);
  });

  it('normal JSON and extensionless files do not false-positive — submit completes', async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, 'data.json'), JSON.stringify({ title: 'boss guide', tags: ['boss'] }));
    writeFileSync(join(repo, 'LICENSE'), 'MIT License\n');
    const run = gitFlow((c) => {
      if (c.args[0] === 'rev-parse') return { ...ok, stdout: 'main\n' };
      if (c.args.includes('diff')) return { ...ok, stdout: 'data.json\0LICENSE\0' };
      if (c.cmd === 'gh') return { ...ok, stdout: 'https://github.com/o/r/pull/1\n' };
      return ok;
    }, repo);
    const r = await submit({ cwd: repo, run });
    expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(run.calls.some((c) => c.args[0] === 'commit')).toBe(true);
  });

  it('looksLikeSecretFile covers the mirrored .gitignore key patterns', () => {
    expect(looksLikeSecretFile('.env')).toBe(true);
    expect(looksLikeSecretFile('.env.local')).toBe(true);
    expect(looksLikeSecretFile('config/app.key')).toBe(true);
    expect(looksLikeSecretFile('cert.pem')).toBe(true);
    expect(looksLikeSecretFile('upload-secret.json')).toBe(true);
    expect(looksLikeSecretFile('article.mdx')).toBe(false);
    expect(looksLikeSecretFile('src/content/wiki/en/codes/main.mdx')).toBe(false);
    expect(looksLikeSecretFile('environment')).toBe(false);
  });

  it('findStagedSecrets dedupes and reports each hit once with its layer', () => {
    const hits = findStagedSecrets(['.env', '.env', 'a.pem'], '/root');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.path).sort()).toEqual(['.env', 'a.pem']);
  });
});

describe('submit integration (real git, local bare origin)', () => {
  it('creates branch, commits, pushes to origin; gh is faked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-gitops-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execSync(`git init -q -b main "${origin}" --bare`);
    execSync(`git init -q -b main "${work}"`);
    execSync(`git -C "${work}" config user.email t@t.t`);
    execSync(`git -C "${work}" config user.name t`);
    execSync(`git -C "${work}" remote add origin "${origin}"`);
    writeFileSync(join(work, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    execSync(`git -C "${work}" add -A`);
    execSync(`git -C "${work}" commit -q -m init`);

    writeFileSync(join(work, 'new-article.mdx'), '---\ntitle: T\n---\nbody\n');

    const mixedRun: RunFn = (cmd, args, opts2) => {
      if (cmd === 'gh') return { status: 0, stdout: 'https://github.com/o/r/pull/1\n', stderr: '' };
      if (cmd === 'pnpm') return ok; // skip real validation in this git-flow test
      return defaultRun(cmd, args, opts2);
    };

    const r = await submit({ cwd: work, title: 'integration test', run: mixedRun });
    expect(r.prUrl).toContain('pull/1');
    const branches = execSync(`git --git-dir="${origin}" branch --list`).toString();
    expect(branches).toContain(r.branch);
  });

  it('secrets abort restores the original branch and removes the temp branch (real git)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-gitops-abort-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execSync(`git init -q -b main "${origin}" --bare`);
    execSync(`git init -q -b main "${work}"`);
    execSync(`git -C "${work}" config user.email t@t.t`);
    execSync(`git -C "${work}" config user.name t`);
    execSync(`git -C "${work}" remote add origin "${origin}"`);
    writeFileSync(join(work, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    execSync(`git -C "${work}" add -A`);
    execSync(`git -C "${work}" commit -q -m init`);

    // Untracked article (the submission) + an un-ignored .env that `git add -A`
    // will stage — the safety net must abort and fully unwind.
    writeFileSync(join(work, 'new-article.mdx'), '---\ntitle: T\n---\nbody\n');
    writeFileSync(join(work, '.env'), 'SECRET=1\n');

    const mixedRun: RunFn = (cmd, args, opts2) => {
      if (cmd === 'gh') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'pnpm') return ok; // skip real validation in this git-flow test
      return defaultRun(cmd, args, opts2);
    };

    await expect(submit({ cwd: work, title: 'secrets abort', run: mixedRun })).rejects.toMatchObject({ name: 'OpsError' });
    expect(execSync(`git -C "${work}" rev-parse --abbrev-ref HEAD`).toString().trim()).toBe('main');
    expect(execSync(`git -C "${work}" branch --list`).toString()).not.toContain('ops/submit-');
  });

  it('real GSC key JSON staged under an innocent name aborts before commit (real git)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-gitops-keyjson-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execSync(`git init -q -b main "${origin}" --bare`);
    execSync(`git init -q -b main "${work}"`);
    execSync(`git -C "${work}" config user.email t@t.t`);
    execSync(`git -C "${work}" config user.name t`);
    execSync(`git -C "${work}" remote add origin "${origin}"`);
    writeFileSync(join(work, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    execSync(`git -C "${work}" add -A`);
    execSync(`git -C "${work}" commit -q -m init`);

    writeFileSync(join(work, 'new-article.mdx'), '---\ntitle: T\n---\nbody\n');
    // The O1 headline scenario: Google-downloaded key dropped in the repo root.
    writeFileSync(
      join(work, 'anvilwiki-1234-abc.json'),
      JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n' }),
    );

    const mixedRun: RunFn = (cmd, args, opts2) => {
      if (cmd === 'gh') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'pnpm') return ok;
      return defaultRun(cmd, args, opts2);
    };

    const err: OpsError = await submit({ cwd: work, title: 'key json', run: mixedRun }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err.message).toMatch(/anvilwiki-1234-abc\.json/);
    // nothing leaked: no commit, no push, worktree back on main
    expect(execSync(`git -C "${work}" rev-parse --abbrev-ref HEAD`).toString().trim()).toBe('main');
    expect(execSync(`git -C "${origin}" branch --list`).toString()).not.toContain('ops/submit-');
  });
});

describe('round-15 audit fixes', () => {
  const setupRepo = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execSync(`git init -q -b main "${origin}" --bare`);
    execSync(`git init -q -b main "${work}"`);
    execSync(`git -C "${work}" config user.email t@t.t`);
    execSync(`git -C "${work}" config user.name t`);
    execSync(`git -C "${work}" remote add origin "${origin}"`);
    writeFileSync(join(work, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    execSync(`git -C "${work}" add -A`);
    execSync(`git -C "${work}" commit -q -m init`);
    return work;
  };
  const mixedRun: RunFn = (cmd, args, opts2) => {
    if (cmd === 'gh') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'pnpm') return ok;
    return defaultRun(cmd, args, opts2);
  };

  it('HIGH regression: CJK-named staged key file aborts submit (real git, was silently bypassed)', async () => {
    const work = setupRepo('ops-gitops-cjkkey-');
    writeFileSync(join(work, 'new-article.mdx'), '---\ntitle: T\n---\nbody\n');
    // With git's default quotePath=true the staged list used to carry this
    // path C-quoted ("350..."), matching no safety-net layer, so commit+push
    // proceeded with zero warnings.
    writeFileSync(join(work, '谷歌密钥.json'), '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n"}');

    const err: OpsError = await submit({ cwd: work, title: 'cjk key', run: mixedRun }).then(
      () => {
        throw new Error('should have thrown');
      },
      (e) => e,
    );
    expect(err.message).toContain('谷歌密钥.json');
    expect(execSync(`git -C "${work}" rev-parse --abbrev-ref HEAD`).toString().trim()).toBe('main');
    expect(execSync(`git -C "${join(work, '..', 'origin.git')}" branch --list`).toString()).not.toContain('ops/submit-');
  });

  it('listStagedFiles returns decoded paths (unit via real git)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-gitops-quote-'));
    execSync('git init -q', { cwd: dir });
    writeFileSync(join(dir, '谷歌.json'), '{}');
    execSync('git add -A', { cwd: dir });
    expect(listStagedFiles(defaultRun, dir)).toContain('谷歌.json');
  });

  it('content layer has no extension gate: key material in .md/.txt is caught', () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, 'notes.md'), '```json\n"private_key": "-----BEGIN PRIVATE KEY-----"\n```');
    writeFileSync(join(repo, 'draft.txt'), '-----BEGIN RSA PRIVATE KEY-----');
    const hits = findStagedSecrets(['notes.md', 'draft.txt'], repo);
    expect(hits.map((h) => h.path).sort()).toEqual(['draft.txt', 'notes.md']);
  });

  describe('acquireSubmitLock (cross-process)', () => {
    it('refuses while the owner pid is alive; release allows reacquire', () => {
      const repo = tmpRepo();
      const l1 = acquireSubmitLock(repo);
      expect(() => acquireSubmitLock(repo)).toThrowError(OpsError);
      l1.release();
      const l2 = acquireSubmitLock(repo);
      l2.release();
    });

    it('steals a stale lock whose owner pid is dead', () => {
      const repo = tmpRepo();
      const lockPath = submitLockPath(repo);
      // 100000000 exceeds every real pid_max (Linux 4194304, macOS 99998) —
      // provably dead, so the lock is stolen and rewritten with our pid.
      writeFileSync(lockPath, '100000000\n');
      const l = acquireSubmitLock(repo);
      const [stolenPid, stolenTs] = readFileSync(lockPath, 'utf8').trim().split('\n');
      expect(stolenPid).toBe(String(process.pid));
      expect(Number(stolenTs)).toBeGreaterThan(Date.now() - 60_000);
      l.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it('steals a lock whose pid was recycled but which is older than the stale window', () => {
      const repo = tmpRepo();
      const lockPath = submitLockPath(repo);
      // OUR pid (provably alive) squatting on a 31-minute-old lock: the OS
      // can hand a dead submit's pid to an unrelated process, so liveness
      // alone would deadlock forever — age is the tiebreaker.
      writeFileSync(lockPath, `${process.pid}\n${Date.now() - 31 * 60_000}\n`);
      const l = acquireSubmitLock(repo);
      expect(readFileSync(lockPath, 'utf8').trim().split('\n')[0]).toBe(String(process.pid));
      l.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it('still refuses a fresh timestamped lock with a live pid (age steal must not shortcut safety)', () => {
      const repo = tmpRepo();
      const lockPath = submitLockPath(repo);
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
      expect(() => acquireSubmitLock(repo)).toThrowError(OpsError);
      unlinkSync(lockPath);
    });

    it('a timestamp-less lock from an older version still refuses a live pid (no age shortcut)', () => {
      const repo = tmpRepo();
      const lockPath = submitLockPath(repo);
      // 1.0.4 wrote pid only. Missing timestamp → age check disabled →
      // fail-closed on a live pid, exactly as before.
      writeFileSync(lockPath, `${process.pid}\n`);
      expect(() => acquireSubmitLock(repo)).toThrowError(OpsError);
      unlinkSync(lockPath);
    });
  });

  describe('gfmFence', () => {
    it('plain summary gets a triple-backtick fence', () => {
      expect(gfmFence('check passed\n2 files ok')).toBe('```');
    });

    it('a summary containing backtick runs gets a longer fence so it cannot break out', () => {
      expect(gfmFence('a```b')).toBe('````');
      expect(gfmFence('a````b')).toBe('`````');
    });
  });
});
