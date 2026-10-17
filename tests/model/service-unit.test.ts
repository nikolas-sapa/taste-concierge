import { fixtureOption } from '../../src/server/practical/resolve';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Brief } from '../../src/contracts/concierge';
import type { PracticalFixture } from '../../src/contracts/server';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { createModelService, MODEL_SNAPSHOT, type ModelService } from '../../src/server/model/responses';
import { MODEL_RESERVATION_MICROS, PRICING_SOURCE } from '../../src/server/model/constants';
import * as admission from '../../src/server/admission/ledger';

// Synthetic local policy, fake key, source rows and transport responses. No paid/live calls.
const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Unit film' }],
  diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };
const fixtures: PracticalFixture[] = ['dining', 'attractions'].map((category, i) => ({
  fixtureId: `unit-${i}`, sourceEntityId: `unit-source-${i}`, name: `Synthetic source venue ${i}`,
  category: category as 'dining' | 'attractions', cityId: 'athens', coordinates: ATHENS_ORIGIN,
  sourceUrl: 'https://example.invalid/unit', sourceRevision: 'unit', retrievedAt: new Date().toISOString(),
  license: 'CC0', verification: 'source-reported',
}));
const selection = () => ({ items: fixtures.map((f, index) => ({ fixtureRef: f.fixtureId, category: f.category,
  role: 'primary', order: index + 1, reasonCodes: ['within-radius'] })) });
const response = (value: unknown = selection()) => ({ model: MODEL_SNAPSHOT, status: 'completed',
  usage: { input_tokens: 100, output_tokens: 50 }, output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

async function prepared(transport: typeof fetch, ceiling = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'concierge-model-unit-'));
  const config = { keyFile: join(directory, 'unit-key'), evidenceDir: directory, projectRoot: process.cwd(), maxSpendUsd: ceiling };
  const policy = { version: 1, model: MODEL_SNAPSHOT, authorized: true,
    authorizationSource: 'synthetic unit authorization, NOT real allowance', ceilingMicros: Math.floor(ceiling * 1_000_000), priorSpentMicros: 0,
    pricing: { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, regionalUplift: 1.1,
      source: PRICING_SOURCE, verifiedAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 } };
  const ledger = { version: 1, policyDigest: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    consumedMicros: 0, halted: false, charges: [] };
  await writeFile(config.keyFile, 'synthetic-model-unit-key', { mode: 0o600 });
  await writeFile(join(directory, 'model-policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await writeFile(join(directory, 'model-budget.json'), JSON.stringify(ledger), { mode: 0o600 });
  return { directory, config, service: createModelService(config, transport) };
}

test('valid response renders independent names only, persists charge before transport and does not reset on restart', async () => {
  let calls = 0;
  let directory = '';
  const transport = (async (url, options) => {
    calls++;
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body));
    expect(body.store).toBe(false); expect(body.tools).toEqual([]); expect(body.max_output_tokens).toBe(1024);
    const disk = JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8'));
    expect(disk.charges).toHaveLength(calls);
    return new Response(JSON.stringify(response()));
  }) as typeof fetch;
  const preparedService = await prepared(transport, 0.34);
  directory = preparedService.directory;
  let reopened: ModelService | undefined;
  try {
    const result = await preparedService.service.generateBaseline(brief, fixtures);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unit readiness');
    expect(result.items.map(i => i.name)).toEqual(fixtures.map(f => f.name));
    expect(result.items.every(i => i.source === 'generic-llm')).toBe(true);
    expect(result.items.every(i => /^[a-f0-9]{64}$/.test(i.ref))).toBe(true);
    const captures = (await readdir(directory)).filter(f => /^model-[a-f0-9]{64}\.json$/.test(f));
    expect(captures).toHaveLength(1);
    const capture = await readFile(join(directory, captures[0]), 'utf8');
    expect(capture).not.toContain('synthetic-model-unit-key');
    await preparedService.service.close();
    reopened = createModelService(preparedService.config, transport);
    expect(await reopened.isReady()).toBe(false);
    expect(await reopened.generateBaseline(brief, fixtures)).toMatchObject({ status: 'unavailable' });
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).consumedMicros).toBe(MODEL_RESERVATION_MICROS);
  } finally { await reopened?.close(); await preparedService.service.close(); await rm(directory, { recursive: true, force: true }); }
});

test.each(['refusal', 'incomplete', 'foreign-ref', 'wrong-snapshot', 'free-fact'] as const)
  ('%s response is unavailable, consumes 1 allocation and never retries', async kind => {
    let calls = 0;
    const payload = response();
    if (kind === 'refusal') payload.output[0].content = [{ type: 'refusal', text: 'Synthetic refusal' }];
    if (kind === 'incomplete') payload.status = 'incomplete';
    if (kind === 'wrong-snapshot') payload.model = 'synthetic-wrong-model';
    if (kind === 'foreign-ref' || kind === 'free-fact') {
      const output = selection();
      if (kind === 'foreign-ref') output.items[0].fixtureRef = 'foreign-ref';
      else Object.assign(output.items[0], { hours: 'invented' });
      payload.output[0].content[0].text = JSON.stringify(output);
    }
    const { directory, service } = await prepared((async () => { calls++; return new Response(JSON.stringify(payload)); }) as typeof fetch);
    try {
      expect(await service.generateBaseline(brief, fixtures)).toEqual({ status: 'unavailable', reason: 'invalid-output' });
      expect(calls).toBe(1);
      expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).charges).toHaveLength(1);
    } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
  });

test('failed charge, missing policy and symlink budget each deny with zero transport calls', async () => {
  let calls = 0;
  const transport = (async () => { calls++; return new Response(JSON.stringify(response())); }) as typeof fetch;
  const failed = await prepared(transport);
  const absent = await prepared(transport);
  const escaped = await prepared(transport);
  const outside = await mkdtemp(join(tmpdir(), 'concierge-model-outside-unit-'));
  try {
    expect(await failed.service.isReady()).toBe(true);
    await unlink(join(failed.directory, 'model-budget.json'));
    expect(await failed.service.generateBaseline(brief, fixtures)).toMatchObject({ status: 'unavailable' });
    await unlink(join(absent.directory, 'model-policy.json'));
    expect(await absent.service.generateBaseline(brief, fixtures)).toMatchObject({ status: 'unavailable' });
    await writeFile(join(outside, 'budget.json'), await readFile(join(escaped.directory, 'model-budget.json')), { mode: 0o600 });
    await unlink(join(escaped.directory, 'model-budget.json'));
    await symlink(join(outside, 'budget.json'), join(escaped.directory, 'model-budget.json'));
    expect(await escaped.service.isReady()).toBe(false);
    expect(calls).toBe(0);
  } finally {
    for (const entry of [failed, absent, escaped]) { await entry.service.close(); await rm(entry.directory, { recursive: true, force: true }); }
    await rm(outside, { recursive: true, force: true });
  }
});

test('abort after paid attempt consumes allocation; all later sends cancelled', async () => {
  const controller = new AbortController(); let calls = 0;
  const { directory, service } = await prepared((async () => { calls++; controller.abort(); throw new Error('synthetic cancellation'); }) as typeof fetch);
  try {
    expect(await service.generateBaseline(brief, fixtures, controller.signal)).toMatchObject({ status: 'unavailable' });
    expect(await service.generateBaseline(brief, fixtures, controller.signal)).toMatchObject({ status: 'unavailable' });
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).charges).toHaveLength(1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('out-of-radius selection rejects even with valid JSON schema fields', async () => {
  const distant = { ...fixtures[0], fixtureId: 'unit-distant', coordinates: { latitude: 0, longitude: 0 } };
  const output = selection(); output.items[0].fixtureRef = distant.fixtureId;
  const { directory, service } = await prepared((async () => new Response(JSON.stringify(response(output)))) as typeof fetch);
  try {
    expect(await service.generateBaseline(brief, [...fixtures, distant])).toMatchObject({ status: 'unavailable', reason: 'invalid-output' });
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed durable write sends 0 and poisons admission, no automatic refund/retry', async () => {
  let calls = 0;
  const { directory, service } = await prepared((async () => { calls++; return new Response(JSON.stringify(response())); }) as typeof fetch);
  try {
    expect(await service.isReady()).toBe(true);
    const fault = vi.spyOn(admission, 'durableWrite').mockRejectedValueOnce(new Error('synthetic fsync fault'));
    expect(await service.generateBaseline(brief, fixtures)).toMatchObject({ status: 'unavailable' });
    fault.mockRestore();
    expect(calls).toBe(0);
    expect(await service.isReady()).toBe(false);
    expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).charges).toHaveLength(0);
  } finally { vi.restoreAllMocks(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('treatment selection stays on ranked bound refs, baseline input strips any extra Qloo metadata', async () => {
  const value = selection(); value.items[0].reasonCodes = ['qloo-rank'];
  const requests: unknown[] = [];
  const { directory, service } = await prepared((async (_, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify(response(value)));
  }) as typeof fetch);
  try {
    const ranked = fixtures.map((f, index) => ({ fixtureRef: f.fixtureId, category: f.category!, rank: index + 1 }));
    const result = await service.interpretTreatment(brief, fixtures.map(fixtureOption), ranked);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('synthetic readiness');
    expect(result.items.every(item => ranked.some(r => r.fixtureRef === item.fixtureRef))).toBe(true);
    const withPrivateExtras = fixtures.map(f => ({ ...f, qlooEntityId: 'synthetic-private-id', affinity: 0.5 }));
    // Same transport output carries forbidden baseline code, so validation withholds it.
    expect(await service.generateBaseline(brief, withPrivateExtras)).toEqual({ status: 'unavailable', reason: 'invalid-output' });
    expect(JSON.stringify(requests[1])).not.toContain('synthetic-private-id');
    expect(JSON.stringify(requests[1])).not.toContain('affinity');
    expect(JSON.parse(await readFile(join(directory, 'model-budget.json'), 'utf8')).charges).toHaveLength(2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
