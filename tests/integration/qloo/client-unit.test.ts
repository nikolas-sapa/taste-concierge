import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { initializeLedger, type ProviderPolicy } from '../../../src/server/admission/ledger';
import { createQlooClient } from '../../../src/server/qloo/client';

// Local transport faults and synthetic policy only. No live API requests/acceptance claims.
async function prepared(transport: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'concierge-client-unit-'));
  const now = Date.now();
  const policy: ProviderPolicy = { version: 1, verified: true, priorUsageKnown: true,
    source: 'synthetic unit policy, not verified provider limits', expiresAt: now + 60_000, minIntervalMs: 0,
    windows: ['rate', 'quota'].map(kind => ({ id: `unit-${kind}`, kind: kind as 'rate' | 'quota',
      startsAt: now - 1000, endsAt: now + 60_000, ceiling: 100, usedBeforeLedger: 0 })),
    payload: { categoryTagIds: { dining: 'unit-dining', attractions: 'unit-museum' },
      origin: { latitude: 0, longitude: 0 }, athensCityNames: ['Unit city'] } };
  const keyFile = join(directory, 'key');
  const policyFile = join(directory, 'policy.json');
  await writeFile(keyFile, 'synthetic-unit-secret', { mode: 0o600 });
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  await initializeLedger(join(directory, 'app-admission.json'), policy);
  return { directory, client: createQlooClient({ keyFile, policyFile, evidenceDir: directory, projectRoot: process.cwd() }, transport) };
}

test('unknown policy gives unconfigured and exactly zero transport attempts', async () => {
  let attempts = 0;
  const client = createQlooClient({ keyFile: '', policyFile: '', evidenceDir: '', projectRoot: process.cwd() },
    (async () => { attempts++; throw new Error('unexpected transport'); }) as typeof fetch);
  expect(await client.isReady()).toBe(false);
  await expect(client.runOperation(() => client.search({ kind: 'movie', text: 'Unit seed' }))).rejects.toMatchObject({ reason: 'configuration' });
  expect(attempts).toBe(0);
});

test('failed durable charge permits zero transport calls', async () => {
  let attempts = 0;
  const { directory, client } = await prepared((async () => { attempts++; return new Response('{}'); }) as typeof fetch);
  try {
    await expect(client.runOperation(async () => {
      await unlink(join(directory, 'app-admission.json'));
      return client.search({ kind: 'movie', text: 'Unit seed' });
    })).rejects.toMatchObject({ reason: 'configuration' });
    expect(attempts).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([[401, 'authentication'], [403, 'authentication'], [429, 'rate-limit'], [500, 'upstream']] as const)
  ('HTTP %i maps to %s, consumes 1 attempt and never retries', async (status, reason) => {
    let attempts = 0;
    const { directory, client } = await prepared((async (url, options) => {
      expect(new URL(String(url)).origin).toBe('https://hackathon.api.qloo.com');
      expect(options?.redirect).toBe('error');
      attempts++; return new Response('Synthetic fault body', { status });
    }) as typeof fetch);
    try {
      await expect(client.runOperation(() => client.search({ kind: 'movie', text: 'Unit seed' })))
        .rejects.toMatchObject({ reason });
      expect(attempts).toBe(1);
      const disk = JSON.parse(await readFile(join(directory, 'app-admission.json'), 'utf8'));
      expect(disk.charges).toHaveLength(1);
      expect(Object.keys(disk.reservations)).toHaveLength(0);
      if (status === 403 || status === 429) expect(await client.isReady()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('operation cap allows 5 attempts, rejects attempt 6; raw-byte provenance reproducible', async () => {
  let attempts = 0;
  const { directory, client } = await prepared((async () => {
    attempts++; return new Response('{ "results": [] }', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  try {
    await expect(client.runOperation(async () => {
      for (let index = 0; index < 6; index++) {
        const result = await client.search({ kind: 'movie', text: 'Unit seed' });
        const capture = JSON.parse(await readFile(join(directory, result.evidence.privateRef), 'utf8'));
        expect(Buffer.from(capture.rawBody, 'base64').toString('utf8')).toBe('{ "results": [] }');
        expect(JSON.stringify(capture)).not.toContain('synthetic-unit-secret');
      }
    })).rejects.toMatchObject({ reason: 'configuration' });
    expect(attempts).toBe(5);
    expect(JSON.parse(await readFile(join(directory, 'app-admission.json'), 'utf8')).charges).toHaveLength(5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('network error consumes 1 attempt; empty 404 search is an honest no-match', async () => {
  const failed = await prepared((async () => { throw new Error('synthetic network failure'); }) as typeof fetch);
  const empty = await prepared((async () => new Response('', { status: 404 })) as typeof fetch);
  try {
    await expect(failed.client.runOperation(() => failed.client.search({ kind: 'movie', text: 'Unit seed' })))
      .rejects.toMatchObject({ reason: 'network' });
    expect(JSON.parse(await readFile(join(failed.directory, 'app-admission.json'), 'utf8')).charges).toHaveLength(1);
    const result = await empty.client.runOperation(() => empty.client.search({ kind: 'movie', text: 'Unit seed' }));
    expect(result.body).toEqual({ results: [] });
  } finally {
    await rm(failed.directory, { recursive: true, force: true });
    await rm(empty.directory, { recursive: true, force: true });
  }
});

test('request abort before admission sends 0; abort after first call preserves 1 charge and sends no second', async () => {
  let attempts = 0;
  const { directory, client } = await prepared((async () => { attempts++; return new Response('{"results":[]}'); }) as typeof fetch);
  try {
    const before = new AbortController(); before.abort();
    await expect(client.runOperation(() => client.search({ kind: 'movie', text: 'Unit seed' }), before.signal))
      .rejects.toMatchObject({ reason: 'timeout' });
    expect(attempts).toBe(0);
    const after = new AbortController();
    await expect(client.runOperation(async () => {
      await client.search({ kind: 'movie', text: 'Unit seed' });
      after.abort();
      return client.search({ kind: 'artist', text: 'Unit artist' });
    }, after.signal)).rejects.toMatchObject({ reason: 'timeout' });
    expect(attempts).toBe(1);
    const disk = JSON.parse(await readFile(join(directory, 'app-admission.json'), 'utf8'));
    expect(disk.charges).toHaveLength(1);
    expect(Object.keys(disk.reservations)).toHaveLength(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('health becomes unconfigured when already-open durable ledger is corrupt', async () => {
  const { directory, client } = await prepared((async () => new Response('{"results":[]}')) as typeof fetch);
  try {
    expect(await client.isReady()).toBe(true);
    await writeFile(join(directory, 'app-admission.json'), '{broken');
    expect(await client.isReady()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
