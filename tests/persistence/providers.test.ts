import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { migrationStatements } from '../../scripts/migrate-runtime';
import { importRuntimeEvidence } from '../../scripts/import-runtime';
import { initializeAllowance } from '../../scripts/initialize-allowance';
import { ProviderRepository } from '../../src/server/persistence/provider';
import { createCloudQlooClient, loadCloudBindings, withCloudOperation } from '../../src/server/persistence/cloud';
import { QlooError } from '../../src/server/qloo/errors';
import type { PracticalFixture } from '../../src/contracts/server';

const databaseUrl = process.env.RUN_POSTGRES_TESTS === '1' ? process.env.PROVIDER_TEST_DATABASE_URL : undefined;
const runtimeDatabaseUrl = process.env.PROVIDER_TEST_RUNTIME_DATABASE_URL;
const schema = `taste_runtime_test_${randomBytes(8).toString('hex')}`;
const operation = { ref: 'a'.repeat(64), fence: 'b'.repeat(64), revision: 0 };
const privateOperation = { tokenHash: createHash('sha256').update(operation.ref).digest('hex'), fence: operation.fence, revision: 0 };
const fixture: PracticalFixture = { fixtureId: 'independent-fixture', sourceEntityId: 'independent-id', name: 'Independent fixture',
  category: 'dining', coordinates: { latitude: 37.98, longitude: 23.72 }, cityId: 'athens', sourceUrl: 'https://example.org/source',
  sourceRevision: '1', retrievedAt: '2026-10-17T00:00:00Z', license: 'CC0', verification: 'source-reported' };
const syntheticCapture = { status: 200, body: { results: { entities: [{ entity_id: 'synthetic-place', subtype: 'urn:entity:place' }] } } };

describe.skipIf(!databaseUrl || !runtimeDatabaseUrl)('actual PostgreSQL provider persistence, synthetic upstream only', () => {
  const sql = neon(databaseUrl ?? 'postgresql://unused:unused@localhost/unused');
  const runtimeSql = neon(runtimeDatabaseUrl ?? 'postgresql://unused:unused@localhost/unused');
  const query = (statement: string, params: unknown[] = []) => sql.query(statement, params,
    { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  const transaction = (queries: Parameters<typeof sql.transaction>[0]) => sql.transaction(queries,
    { fetchOptions: { signal: AbortSignal.timeout(15000) } });
  const repository = () => new ProviderRepository(runtimeDatabaseUrl!, schema, () => privateOperation);
  let privateRoot: string;
  beforeAll(async () => {
    await query(`create schema ${schema}`);
    await query(`grant usage on schema ${schema} to taste_runtime_app`);
    for (const migration of ['001-runtime.sql', '002-provider.sql', '003-application-allowance.sql']) {
      const source = (await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8')).replace(/\btaste_runtime\b/g, schema);
      await transaction(migrationStatements(source).map(statement => query(statement)));
    }
    privateRoot = await mkdtemp(join(tmpdir(), 'taste-provider-'));
    await chmod(privateRoot, 0o700);
  }, 20000);
  afterAll(async () => {
    await query(`drop schema if exists ${schema} cascade`);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }, 15000);
  beforeEach(async () => {
    await transaction([
      query(`truncate ${schema}.provider_bindings,${schema}.provider_captures,${schema}.provider_attempts,${schema}.provider_reservations,${schema}.sessions`),
      query(`update ${schema}.provider_state set policy=null,halted=false,send_id=null,send_until=null,last_completed=null,allocated_bytes=0 where id=1`),
      query(`insert into ${schema}.sessions(id,revision,envelope,expires_at,operation_fence,lease_until)
        values(decode($1,'hex'),0,'{}',clock_timestamp()+interval '30 minutes',$2,clock_timestamp()+interval '90 seconds')`,
      [privateOperation.tokenHash, operation.fence]),
    ]);
  });
  async function enable(ceiling = 100) {
    // Only isolated test schema receives invented policy. Production remains missing/disabled.
    const now = Date.now();
    const policy = { version: 1, verified: true, priorUsageKnown: true, source: 'synthetic test, not provider authority',
      expiresAt: now + 600_000, minIntervalMs: 0, windows: ['rate', 'quota'].map(kind => ({ id: kind, kind,
        startsAt: now - 60_000, endsAt: now + 600_000, ceiling, usedBeforeLedger: 0 })),
      payload: { categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-attractions' },
        origin: { latitude: 37.98, longitude: 23.72 }, athensCityNames: ['Athens'] } };
    await query(`update ${schema}.provider_state set policy=$1::jsonb where id=1`, [JSON.stringify(policy)]);
  }

  function allowance(ceiling = 27) {
    const now = Date.now();
    return { version: 2, authority: 'application-allowance', providerUsageUnknown: true, providerQuotaUnknown: true,
      eventHost: 'https://hackathon.api.qloo.com', credentialSha256: createHash('sha256').update('synthetic-key').digest('hex'),
      source: 'synthetic evidence, no real entitlement', financialBasis: 'event-no-disclosed-fee', checkedAt: now - 1000,
      expiresAt: Math.min(now + 600_000, Date.parse('2026-11-17T04:45:00Z')), minIntervalMs: 5000,
      allowance: { id: 'synthetic-lifetime', ceiling, knownBeforeLedger: 12 },
      payload: { categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-attractions' },
        origin: { latitude: 37.98, longitude: 23.72 }, athensCityNames: ['Athens'] } };
  }
  const initializeApplication = (policy = allowance()) => initializeAllowance({ databaseUrl: databaseUrl!, databaseSchema: schema, policy });
  const cloud = (keySource = async () => 'synthetic-key', transport = vi.fn<typeof fetch>()) =>
    createCloudQlooClient({ databaseUrl: runtimeDatabaseUrl!, databaseSchema: schema, keySource }, transport);

  it('A02 twenty reservations across two repositories admit exactly three, lifetime 27 admits zero after relabeling', async () => {
    await initializeApplication();
    const instances = [repository(), repository()]; await Promise.all(instances.map(r => r.initialize()));
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => instances[i % 2].reserve(5)));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(3);
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') await instances[0].release(outcome.value);
    await query(`insert into ${schema}.provider_attempts(id,reservation,charged_at,window_ids,state)
      select lpad(to_hex(n),64,'0'),'synthetic',clock_timestamp(),'["old-unrelated-id"]','complete' from generate_series(1,15) n`);
    await query(`update ${schema}.provider_state set policy=jsonb_set(jsonb_set(policy,'{source}','"renamed source"'),'{allowance,id}','"renamed lifetime"')`);
    const restarted = [repository(), repository()]; await Promise.all(restarted.map(r => r.initialize()));
    const denied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => restarted[i % 2].reserve(5)));
    expect(denied.filter(o => o.status === 'fulfilled')).toHaveLength(0);
  }, 20000);

  it('A06 initializer preserves history and halted state, rejects repeat and runtime writes', async () => {
    await query(`insert into ${schema}.provider_attempts(id,reservation,charged_at,window_ids,state)
      values($1,'synthetic',clock_timestamp(),'["prior"]','complete')`, ['c'.repeat(64)]);
    await query(`update ${schema}.provider_state set halted=true,last_completed=clock_timestamp()`);
    await initializeApplication();
    await expect(initializeApplication()).rejects.toThrow();
    const rows = await query(`select halted,last_completed is not null as retained,(select count(*)::int from ${schema}.provider_attempts) as attempts from ${schema}.provider_state`);
    expect(rows[0]).toEqual({ halted: true, retained: true, attempts: 1 });
    await expect(initializeAllowance({ databaseUrl: runtimeDatabaseUrl!, databaseSchema: schema, policy: allowance() })).rejects.toThrow();
    await expect(runtimeSql.query(`update ${schema}.provider_state set policy=null`)).rejects.toMatchObject({ code: '42501' });
  });

  it('A06 two racing initializers commit exactly one policy, no second allowance', async () => {
    const outcomes = await Promise.allSettled([initializeApplication(), initializeApplication()]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('A02 lifetime budget is independently rechecked at charge, including unrelated prior IDs', async () => {
    await initializeApplication(); const a = repository(); await a.initialize(); const reservation = await a.reserve(5);
    await query(`insert into ${schema}.provider_attempts(id,reservation,charged_at,window_ids,state)
      select lpad(to_hex(n),64,'0'),'synthetic',clock_timestamp(),'["other-id"]','complete' from generate_series(1,11) n`);
    await expect(a.charge(reservation)).rejects.toMatchObject({ reason: 'rate-limit' });
    expect((await query(`select count(*)::int as count from ${schema}.provider_attempts`))[0].count).toBe(11);
  });

  it('A05 two clients racing twenty sends keep max one in flight and at least 5000ms completion gap', async () => {
    await initializeApplication(allowance(100));
    await query(`update ${schema}.sessions set lease_until=clock_timestamp()+interval '3 minutes'`);
    let inFlight = 0; let maximum = 0;
    const timing: { start: number; complete: number }[] = [];
    const transport = vi.fn<typeof fetch>(async () => {
      maximum = Math.max(maximum, ++inFlight);
      const sample = { start: Date.now(), complete: 0 }; timing.push(sample);
      await new Promise(resolve => setTimeout(resolve, 20));
      sample.complete = Date.now(); inFlight--;
      return new Response('{"results":[]}');
    });
    const clients = [cloud(async () => 'synthetic-key', transport), cloud(async () => 'synthetic-key', transport)];
    await Promise.all(clients.map(client => (async () => {
      for (let i = 0; i < 10; i++) await withCloudOperation(operation, () => client.runOperation(() => client.search({ kind: 'movie', text: 'Synthetic' })));
    })()));
    expect(transport).toHaveBeenCalledTimes(20); expect(maximum).toBe(1);
    for (let i = 1; i < timing.length; i++) expect(timing[i].start - timing[i - 1].complete).toBeGreaterThanOrEqual(5000);
  }, 150000);

  it.each(['reservation', 'intent', 'uncertain', 'send-owner'])('A06 initializer rejects existing %s', async state => {
    if (state === 'reservation') await query(`insert into ${schema}.provider_reservations values($1,5,clock_timestamp()+interval '1 minute',decode($2,'hex'),$3,0)`, ['c'.repeat(64), privateOperation.tokenHash, operation.fence]);
    else if (state === 'send-owner') await query(`update ${schema}.provider_state set send_id=$1,send_until=clock_timestamp()+interval '1 minute'`, ['c'.repeat(64)]);
    else await query(`insert into ${schema}.provider_attempts(id,reservation,charged_at,window_ids,state) values($1,'synthetic',clock_timestamp(),'[]',$2)`, ['c'.repeat(64), state]);
    await expect(initializeApplication()).rejects.toThrow();
  });

  it.each([401, 403, 429, 'quota', 'zero', 'uncertain'] as const)('A04 V2 synthetic %s durably stops ten reconstructed clients', async fault => {
    await initializeApplication();
    const transport = vi.fn<typeof fetch>(async () => {
      if (fault === 'uncertain') throw new Error('synthetic network uncertainty');
      return new Response(JSON.stringify(fault === 'quota' ? { error: 'credential expired quota' } : {}),
        { status: typeof fault === 'number' ? fault : 200, headers: fault === 'zero' ? { 'x-ratelimit-remaining': '0' } : {} });
    });
    const client = cloud(async () => 'synthetic-key', transport);
    await expect(withCloudOperation(operation, () => client.runOperation(() => client.search({ kind: 'movie', text: 'Synthetic' })))).rejects.toBeDefined();
    for (let i = 0; i < 10; i++) {
      const next = cloud(async () => 'synthetic-key', transport);
      await expect(withCloudOperation(operation, () => next.runOperation(() => next.search({ kind: 'movie', text: 'Synthetic' })))).rejects.toBeDefined();
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await query(`select halted,(select count(*)::int from ${schema}.provider_attempts) as attempts from ${schema}.provider_state`))[0]).toEqual({ halted: true, attempts: 1 });
  }, 20000);

  it('A01/A03/A07 malformed policies read zero credentials; rotation performs zero transports', async () => {
    const keySource = vi.fn(async () => 'synthetic-key'); const transport = vi.fn<typeof fetch>();
    for (const change of [{ verified: true }, { priorUsageKnown: true }, { windows: [] }, { authority: 'provider' },
      { financialBasis: 'paid' }, { checkedAt: Date.now() + 600_000 }, { expiresAt: 1 }, { eventHost: 'https://api.qloo.com' },
      { credentialSha256: 'INVALID' }, { providerUsageUnknown: false }]) {
      await query(`update ${schema}.provider_state set policy=$1::jsonb`, [JSON.stringify({ ...allowance(), ...change })]);
      expect(await cloud(keySource, transport).isReady()).toBe(false);
    }
    expect(keySource).toHaveBeenCalledTimes(0); expect(transport).toHaveBeenCalledTimes(0);
    await query(`update ${schema}.provider_state set policy=$1::jsonb`, [JSON.stringify(allowance())]);
    expect(await cloud(async () => 'rotated-synthetic-key', transport).isReady()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(0);
  }, 20000);

  it('missing policy reads zero credentials and performs zero sends', async () => {
    const keySource = vi.fn(async () => 'synthetic-key');
    const transport = vi.fn<typeof fetch>();
    const client = createCloudQlooClient({ databaseUrl: runtimeDatabaseUrl!, databaseSchema: schema, keySource }, transport);
    expect(await client.isReady()).toBe(false);
    expect(keySource).toHaveBeenCalledTimes(0);
    expect(transport).toHaveBeenCalledTimes(0);
    expect(await loadCloudBindings(runtimeDatabaseUrl!, [fixture], schema)).toEqual([]);
  });

  it('two independent instances admit exactly three of twenty five-attempt reservations', async () => {
    await enable(15);
    const a = repository(); const b = repository(); await a.initialize(); await b.initialize();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).reserve(5)));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(3);
    const rows = await query(`select count(*)::int as count,sum(remaining)::int as remaining from ${schema}.provider_reservations`);
    expect(rows[0]).toEqual({ count: 3, remaining: 15 });
  }, 15000);

  it('remaining window budget ten admits exactly two independent reservations', async () => {
    await enable(10);
    const instances = [repository(), repository()]; await Promise.all(instances.map(r => r.initialize()));
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => instances[i % 2].reserve(5)));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(2);
  }, 15000);

  it('single global send intent persists charge across a new instance and enforces completion gap', async () => {
    await enable(); const a = repository(); const b = repository(); await a.initialize(); await b.initialize();
    const first = await a.reserve(5); const second = await b.reserve(5);
    const charge = await a.charge(first);
    expect((await b.rpc('charge', randomBytes(32).toString('hex'), { reservation: second })).status).toBe('wait');
    await a.completeSend(charge.id, false); await a.release(first);
    const waited = await b.rpc('charge', randomBytes(32).toString('hex'), { reservation: second });
    expect(waited.status).toBe('wait'); expect(waited.waitMs).toBeGreaterThan(4000);
    const restarted = repository(); await restarted.initialize();
    const rows = await query(`select count(*)::int as count from ${schema}.provider_attempts`);
    expect(rows[0].count).toBe(1);
    await b.release(second);
  });

  it('uncertain send halts every later instance without refunding allocation or charge', async () => {
    await enable(); const a = repository(); await a.initialize();
    const reservation = await a.reserve(5); const charge = await a.charge(reservation);
    await a.completeSend(charge.id, true); await a.release(reservation);
    const b = repository(); expect(await b.isReady()).toBe(false);
    const rows = await query(`select halted,allocated_bytes::int as bytes,(select count(*)::int from ${schema}.provider_attempts) as charges from ${schema}.provider_state`);
    expect(rows[0]).toEqual({ halted: true, bytes: 2105344, charges: 1 });
  });

  it('expired send lease halts instead of taking over', async () => {
    await enable(); const a = repository(); await a.initialize();
    const reservation = await a.reserve(5); await a.charge(reservation);
    await query(`update ${schema}.provider_state set send_until=clock_timestamp()-interval '1 second'`);
    expect(await repository().isReady()).toBe(false);
    const rows = await query(`select halted,send_id is not null as retained from ${schema}.provider_state`);
    expect(rows[0]).toEqual({ halted: true, retained: true });
  });

  it('exact capture bytes and SHA survive restart with no credential response header retained', async () => {
    await enable(); const a = repository(); await a.initialize();
    const reservation = await a.reserve(5); const charge = await a.charge(reservation);
    const raw = Buffer.from(JSON.stringify(syntheticCapture.body));
    const evidence = await a.saveEvidence({ route: '/search', parameters: { query: 'synthetic' }, status: 200,
      headers: { 'content-type': 'application/json', 'x-secret-debug': 'never-retain' }, raw, receivedAt: new Date().toISOString() }, charge.id);
    await a.completeSend(charge.id, false); await a.release(reservation);
    const rows = await query(`select encode(raw,'base64') as raw,digest,metadata from ${schema}.provider_captures where id=$1`, [evidence.privateRef]);
    expect(Buffer.from(rows[0].raw, 'base64')).toEqual(raw);
    expect(rows[0].digest).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(rows[0].metadata.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('near-full evidence capacity rejects before creating a charged attempt', async () => {
    await enable(); const a = repository(); await a.initialize(); const reservation = await a.reserve(5);
    await query(`update ${schema}.provider_state set allocated_bytes=67108864-2105343`);
    await expect(a.charge(reservation)).rejects.toMatchObject({ reason: 'rate-limit' });
    const rows = await query(`select count(*)::int as count from ${schema}.provider_attempts`); expect(rows[0].count).toBe(0);
  });

  it('shared native HTTP transport writes actual DB evidence and rate-limit halt', async () => {
    await enable();
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'rate limit' }),
      { status: 429, headers: { 'content-type': 'application/json' } }));
    const client = createCloudQlooClient({ databaseUrl: runtimeDatabaseUrl!, databaseSchema: schema,
      keySource: async () => 'synthetic-key' }, transport);
    await expect(withCloudOperation(operation, () => client.runOperation(() => client.search({ kind: 'movie', text: 'Synthetic movie' })))).rejects.toMatchObject({ reason: 'rate-limit' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await client.isReady()).toBe(false);
    const rows = await query(`select count(*)::int as count from ${schema}.provider_captures`); expect(rows[0].count).toBe(1);
  });

  it('operator import preserves exact approved envelope and rejects tampering', async () => {
    const directory = join(privateRoot, randomBytes(6).toString('hex')); await mkdir(directory, { mode: 0o700 });
    const evidenceRef = 'prepared.json';
    await writeFile(join(directory, evidenceRef), JSON.stringify(syntheticCapture), { mode: 0o600 });
    await writeFile(join(directory, 'fixture-bindings.json'), JSON.stringify({ version: 1, bindings: [{ verified: true,
      qlooEntityId: 'synthetic-place', fixtureId: fixture.fixtureId, evidenceRef }] }), { mode: 0o600 });
    const options = { databaseUrl: databaseUrl!, evidenceDir: directory, projectRoot: process.cwd(),
      fixtureIds: [fixture.fixtureId], databaseSchema: schema };
    expect(await importRuntimeEvidence(options)).toBe(1);
    expect(await importRuntimeEvidence(options)).toBe(1);
    expect(await loadCloudBindings(runtimeDatabaseUrl!, [fixture], schema)).toHaveLength(1);
    await query(`update ${schema}.provider_captures set raw=convert_to('{}','UTF8')`);
    await expect(loadCloudBindings(runtimeDatabaseUrl!, [fixture], schema)).rejects.toMatchObject({ reason: 'configuration' });
  });

  it('runtime role can call RPC but cannot read private provider tables', async () => {
    const rows = await runtimeSql.query(`select ${schema}.provider_action('bindings','','{}') as result`);
    expect(rows[0].result.status).toBe('ok');
    await expect(runtimeSql.query(`select policy from ${schema}.provider_state`)).rejects.toMatchObject({ code: '42501' });
  });

  it('twelve malformed retained captures fail closed in actual cloud loader', async () => {
    const variants: unknown[] = [null, {}, { status: 500, body: syntheticCapture.body },
      { status: '200', body: syntheticCapture.body }, { status: 200, body: {} },
      { status: 200, body: { results: {} } }, { status: 200, body: { results: { entities: [] } } },
      { status: 200, body: { results: { entities: [{ entity_id: 'foreign', subtype: 'urn:entity:place' }] } } },
      { status: 200, body: { results: { entities: [{ entity_id: 'synthetic-place', subtype: 'urn:entity:movie' }] } } },
      { status: 200, rawEncoding: 'base64', rawBody: Buffer.from('not json').toString('base64') },
      { status: 200, rawEncoding: 'base64', rawBody: Buffer.from('{}').toString('base64') },
      { status: 200, body: { results: { entities: [null, 'invalid'] } } }];
    for (const [index, value] of variants.entries()) {
      const raw = Buffer.from(JSON.stringify(value));
      const digest = createHash('sha256').update(raw).digest('hex');
      await transaction([
        query(`delete from ${schema}.provider_bindings`), query(`delete from ${schema}.provider_captures`),
        query(`insert into ${schema}.provider_captures(id,raw,digest,metadata,kind) values('malformed',decode($1,'base64'),$2,'{}','import')`, [raw.toString('base64'), digest]),
        query(`insert into ${schema}.provider_bindings values('synthetic-place',$1,'malformed')`, [fixture.fixtureId]),
      ]);
      await expect(loadCloudBindings(runtimeDatabaseUrl!, [fixture], schema), `variant ${index}`).rejects.toBeDefined();
    }
  }, 15000);

  it('exact policy change is rejected even when both interval values are below local minimum', async () => {
    await enable(); const a = repository(); await a.initialize();
    await query(`update ${schema}.provider_state set policy=jsonb_set(policy,'{minIntervalMs}','1'::jsonb)`);
    expect(await a.isReady()).toBe(false);
  });

  it('canceled or changed session fence blocks charge and pre-send assertion', async () => {
    await enable(); const a = repository(); await a.initialize();
    const reservation = await a.reserve(5); const charge = await a.charge(reservation);
    await query(`update ${schema}.sessions set canceled=true`);
    await expect(a.assertSendAllowed(charge.id)).rejects.toMatchObject({ reason: 'configuration' });
    await a.completeSend(charge.id, false);
    await expect(a.charge(reservation)).rejects.toMatchObject({ reason: 'configuration' });
  });

  it.each(['after-charge', 'assert-failure', 'after-assert'] as const)('%s clears a known unsent intent, retaining charge', async phase => {
    await enable();
    const controller = new AbortController();
    const originalCharge = ProviderRepository.prototype.charge;
    const originalAssert = ProviderRepository.prototype.assertSendAllowed;
    const chargeSpy = vi.spyOn(ProviderRepository.prototype, 'charge').mockImplementation(async function (this: ProviderRepository, reservation, signal) {
      const charge = await originalCharge.call(this, reservation, signal);
      if (phase === 'after-charge') controller.abort();
      return charge;
    });
    const assertSpy = vi.spyOn(ProviderRepository.prototype, 'assertSendAllowed').mockImplementation(async function (this: ProviderRepository, id) {
      if (phase === 'assert-failure') throw new QlooError('configuration');
      await originalAssert.call(this, id);
      if (phase === 'after-assert') controller.abort();
    });
    const transport = vi.fn<typeof fetch>();
    const client = createCloudQlooClient({ databaseUrl: runtimeDatabaseUrl!, databaseSchema: schema,
      keySource: async () => 'synthetic-key' }, transport);
    try {
      await expect(withCloudOperation(operation, () => client.runOperation(
        () => client.search({ kind: 'movie', text: 'Synthetic movie' }), controller.signal,
      ))).rejects.toMatchObject({ reason: phase === 'assert-failure' ? 'configuration' : 'timeout' });
      expect(transport).toHaveBeenCalledTimes(0);
      const rows = await query(`select halted,send_id is not null as owned,
        (select count(*)::int from ${schema}.provider_attempts) as charges from ${schema}.provider_state`);
      expect(rows[0]).toEqual({ halted: false, owned: false, charges: 1 });
    } finally { chargeSpy.mockRestore(); assertSpy.mockRestore(); }
  });
});
