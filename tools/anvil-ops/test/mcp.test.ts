import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, submitMutex } from '../src/mcp/server.js';
import { createSubmitMutex } from '../src/mcp/submit-mutex.js';
import type { queryCloudflare, fetchAiReferrals } from '../src/core/providers/cloudflare.js';

function tmpSite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-mcp-'));
  writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nSITE_URL = "https://wiki.example.com"\nPUBLIC_CF_BEACON_TOKEN = "tag1"\n');
  writeFileSync(join(dir, '.env'), 'CF_API_TOKEN=t\nCF_ACCOUNT_ID=a\n');
  return dir;
}

const fakeCf = (async () => ({
  totals: { visits: 7 },
  pages: [{ page: 'https://wiki.example.com/', visits: 7 }],
})) as unknown as typeof queryCloudflare;

const fakeAi = (async () => ({
  available: true,
  rows: [],
  totals: { requests: 0, pageviews: 0 },
})) as unknown as typeof fetchAiReferrals;

async function connect(cwd: string) {
  const server = buildServer({ cwd, cfQuery: fakeCf, aiReferralsQuery: fakeAi });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('anvil-ops MCP server', () => {
  it('lists all five tools', async () => {
    const client = await connect(tmpSite());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['audit', 'doctor', 'insights', 'metrics', 'submit_pr']);
    expect(tools.tools.every((t) => t.description && t.description.length > 0)).toBe(true);
  });

  it('doctor tool returns markdown report', async () => {
    const client = await connect(tmpSite());
    const res = await client.callTool({ name: 'doctor', arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('# anvil-ops doctor');
    expect(res.isError).toBeFalsy();
  });

  it('metrics tool returns markdown with cf data', async () => {
    const client = await connect(tmpSite());
    const res = await client.callTool({ name: 'metrics', arguments: { days: 7 } });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('visits=7');
  });

  it('metrics with no source configured = isError with fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-mcp-'));
    writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    const client = await connect(dir);
    const res = await client.callTool({ name: 'metrics', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/doctor/);
  });

  it('insights end-to-end: stale codes from injected refresh-audit + degraded metrics', async () => {
    const run = ((_cmd: string, args: string[]) => {
      if (args[0] === 'refresh-audit') {
        return {
          status: 0,
          stdout: '| P0 | `src/content/wiki/en/codes/main.mdx` | codes | 45d | dead codes |\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as never;
    const dir = mkdtempSync(join(tmpdir(), 'ops-mcp-'));
    writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nSITE_URL = "https://x.com"\n');
    const server = buildServer({ cwd: dir, run });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: 'insights', arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('stale-codes');
    expect(text).toContain('src/content/wiki/en/codes/main.mdx');
    expect(text).toMatch(/Degradated|Degraded/);
  });

  it('submit_pr with no changes = isError', async () => {
    const client = await connect(tmpSite());
    const res = await client.callTool({ name: 'submit_pr', arguments: { title: 'x' } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/No uncommitted changes|not a git|failed/i);
  });
});

describe('submit_pr mutex (one submit at a time per process)', () => {
  it('createSubmitMutex: second acquire refused until release', () => {
    const m = createSubmitMutex();
    expect(m.tryAcquire()).toBe(true);
    expect(m.tryAcquire()).toBe(false);
    m.release();
    expect(m.tryAcquire()).toBe(true);
    m.release();
  });

  it('refuses a second submit while one is in flight, releases properly afterwards', async () => {
    const client = await connect(tmpSite());
    expect(submitMutex.tryAcquire()).toBe(true);
    try {
      const res = await client.callTool({ name: 'submit_pr', arguments: {} });
      expect(res.isError).toBe(true);
      const text = (res.content as { type: string; text: string }[])[0].text;
      expect(text).toMatch(/already in progress/i);
    } finally {
      submitMutex.release();
    }
    // after release the normal path runs again (fails on the dirty-check, not the mutex)
    const res2 = await client.callTool({ name: 'submit_pr', arguments: {} });
    const text2 = (res2.content as { type: string; text: string }[])[0].text;
    expect(text2).toMatch(/No uncommitted changes|not a git|failed/i);
    expect(text2).not.toMatch(/already in progress/);
  });
});

describe('MCP site resolution (multi-site registry)', () => {
  function registryFixture(): { registryPath: string; siteDir: string; emptyDir: string } {
    const base = mkdtempSync(join(tmpdir(), 'ops-mcp-reg-'));
    const siteDir = join(base, 'main');
    const emptyDir = join(base, 'no-site');
    mkdirSync(siteDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(siteDir, 'wrangler.toml'), '[vars]\nSITE_URL = "https://registry-site.com"\n');
    const registryPath = join(base, 'sites.toml');
    writeFileSync(
      registryPath,
      `defaultSite = "main-wiki"\n\n[[sites]]\nname = "main-wiki"\npath = "${siteDir}"\n`,
    );
    return { registryPath, siteDir, emptyDir };
  }

  it('site param resolves the command to the registered site path', async () => {
    const { registryPath, siteDir, emptyDir } = registryFixture();
    const server = buildServer({ cwd: emptyDir, sitesRegistryPath: registryPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: 'doctor', arguments: { site: 'main-wiki' } });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('https://registry-site.com');
    expect(text).toContain(siteDir);
    expect(res.isError).toBeFalsy();
  });

  it('defaultSite kicks in when cwd has no site config and site is omitted', async () => {
    const { registryPath, emptyDir } = registryFixture();
    const server = buildServer({ cwd: emptyDir, sitesRegistryPath: registryPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: 'doctor', arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('https://registry-site.com');
  });

  it('unknown site name = isError listing available sites', async () => {
    const { registryPath } = registryFixture();
    const server = buildServer({ cwd: tmpSite(), sitesRegistryPath: registryPath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const res = await client.callTool({ name: 'audit', arguments: { site: 'nope' } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/main-wiki/);
    expect(text).toMatch(/sites add/);
  });
});
