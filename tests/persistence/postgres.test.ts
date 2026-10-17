import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { migrateRuntime, migrationStatements } from '../../scripts/migrate-runtime';
import { decodeSessionEnvelope, encodeSessionEnvelope, SessionCodecError } from '../../src/server/persistence/codec';
import { createPostgresBodyLimiter, createPostgresSessionRepository, postgresRuntimeReady, PostgresPersistenceError } from '../../src/server/persistence/postgres';
import type { SessionState } from '../../src/contracts/server';

const active = process.env.RUN_POSTGRES_TESTS === '1';
const empty = (): SessionState => ({ revision: 0, brief: null, resolved: null, pending: new Map(), venues: new Map(),
  result: null, expiresAt: 1, operationFence: null });
const token = () => randomBytes(32).toString('hex');
const hashed = (ref: string) => `\\x${createHash('sha256').update(ref).digest('hex')}`;

// Offline codec checks remain enabled without access to a real database.
describe('bounded versioned session codec', () => {
  it('rejects 8 invalid lease durations before database transport', async () => {
    const repository = createPostgresSessionRepository('postgresql://synthetic:synthetic@example.invalid/synthetic');
    for (const duration of [0, -1, 90_001, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.begin(token(), 0, 'update', duration)).rejects.toThrow(PostgresPersistenceError);
    }
  });

  it('rejects 8 malformed/version/duplicate/oversized variants and preserves fresh Maps', () => {
    const state = empty();
    const decoded = decodeSessionEnvelope(encodeSessionEnvelope(state));
    expect(decoded.pending).toBeInstanceOf(Map);
    expect(decoded.pending).not.toBe(state.pending);
    const envelope = JSON.parse(encodeSessionEnvelope(state));
    const invalid = [null, '{', { ...envelope, version: 2 }, { ...envelope, unknown: true },
      { ...envelope, state: { ...envelope.state, pending: [['same', {}], ['same', {}]] } },
      { ...envelope, state: { ...envelope.state, venues: {} } },
      { ...envelope, state: { ...envelope.state, revision: -1 } },
      { ...envelope, state: { ...envelope.state, result: { state: 'invalid-input', revision: 0, fields: ['x'.repeat(262144)] } } }];
    for (const item of invalid) expect(() => decodeSessionEnvelope(item)).toThrow(SessionCodecError);
  });
});

// Explicit flag permits bounded synthetic writes only on the verified dedicated free database.
describe.skipIf(!active)('real Neon persistence V02–V05/V09', () => {
  let databaseUrl: string;
  let runtimeUrl: string;
  let sql: NeonQueryFunction<false, false>;
  let runtimeSql: NeonQueryFunction<false, false>;
  let initialized = false;
  const first = () => createPostgresSessionRepository(runtimeUrl);
  const second = () => createPostgresSessionRepository(runtimeUrl);
  async function clean() {
    await sql.transaction([
      sql.query('DELETE FROM taste_runtime.sessions'), sql.query('DELETE FROM taste_runtime.session_creations'),
      sql.query('DELETE FROM taste_runtime.body_leases'),
    ]);
  }
  async function databaseQuery(statement: string, params: unknown[] = []) {
    try { return await sql.query(statement, params, { fetchOptions: { signal: AbortSignal.timeout(10000) } }); }
    catch { throw new Error('Dedicated database fixture query failed'); }
  }
  beforeAll(async () => {
    const file = readFileSync(new URL('../../.env.vercel-access', import.meta.url), 'utf8');
    const names = [...file.matchAll(/^([A-Z_][A-Z_0-9]*)=/gm)].map(m => m[1]);
    if (!names.includes('DATABASE_URL')) throw new Error('Dedicated database configuration missing');
    const match = file.match(/^DATABASE_URL=(.*)$/m)?.[1];
    if (!match) throw new Error('Dedicated database configuration missing');
    databaseUrl = match.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    sql = neon(databaseUrl);
    await migrateRuntime(databaseUrl);
    const runtimeFile = readFileSync(new URL('../../.env.runtime-access', import.meta.url), 'utf8');
    const runtimeNames = [...runtimeFile.matchAll(/^([A-Z_][A-Z_0-9]*)=/gm)].map(m => m[1]);
    if (!runtimeNames.includes('DATABASE_URL')) throw new Error('Restricted database configuration missing');
    const configuredRuntimeUrl = runtimeFile.match(/^DATABASE_URL=(.*)$/m)?.[1]?.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (!configuredRuntimeUrl) throw new Error('Restricted database configuration missing');
    runtimeUrl = configuredRuntimeUrl;
    runtimeSql = neon(runtimeUrl);
    initialized = true;
  }, 30000);
  beforeEach(clean);
  afterAll(async () => { if (initialized) await clean(); });

  it('V02: 10/10 JSON+binary hash round trips, idempotent migration and zero partial transaction writes', async () => {
    const refs = Array.from({ length: 10 }, token);
    for (const ref of refs) {
      const state = empty();
      const rows = await databaseQuery('SELECT taste_runtime.session_create($1::bytea,$2::jsonb) AS value', [hashed(ref), encodeSessionEnvelope(state)]);
      expect(rows[0].value.status).toBe('created');
      const actual = await databaseQuery('SELECT encode(id,\'hex\') AS hash, envelope FROM taste_runtime.sessions WHERE id=$1::bytea', [hashed(ref)]);
      expect(actual[0].hash).toBe(createHash('sha256').update(ref).digest('hex'));
      expect(decodeSessionEnvelope(actual[0].envelope)).toEqual({ ...state, expiresAt: expect.any(Number) });
      expect(JSON.stringify(actual)).not.toContain(ref);
    }
    const prior = await databaseQuery("SELECT encode(id,'hex') AS id, revision::text, envelope FROM taste_runtime.sessions ORDER BY id");
    await migrateRuntime(databaseUrl);
    expect(await databaseQuery("SELECT encode(id,'hex') AS id, revision::text, envelope FROM taste_runtime.sessions ORDER BY id")).toEqual(prior);
    let rejected = false;
    try {
      await sql.transaction([
        sql.query('SELECT taste_runtime.session_create($1::bytea,$2::jsonb)', [hashed(token()), encodeSessionEnvelope(empty())]),
        sql.query('SELECT taste_runtime.session_create($1::bytea,$2::jsonb)', [hashed(token()), encodeSessionEnvelope(empty())]),
        sql.query('SELECT 1/0'),
      ]);
    } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await databaseQuery("SELECT encode(id,'hex') AS id, revision::text, envelope FROM taste_runtime.sessions ORDER BY id")).toEqual(prior);
    expect(await postgresRuntimeReady(databaseUrl)).toBe(true);
    const permissions = await databaseQuery(`SELECT
      has_table_privilege('taste_runtime_app','taste_runtime.sessions','SELECT') AS table_read,
      has_schema_privilege('taste_runtime_app','taste_runtime','CREATE') AS schema_create,
      has_schema_privilege('taste_runtime_app','public','CREATE') AS public_create,
      has_database_privilege('taste_runtime_app',current_database(),'TEMP') AS temporary,
      has_function_privilege('taste_runtime_app','taste_runtime.session_begin(bytea,bigint,text,text,integer)','EXECUTE') AS bounded_begin,
      coalesce(has_function_privilege('taste_runtime_app',to_regprocedure('taste_runtime.session_begin(bytea,bigint,text,text)'),'EXECUTE'),false) AS legacy_begin,
      has_function_privilege('taste_runtime_app','taste_runtime.health()','EXECUTE') AS health,
      has_function_privilege('taste_runtime_app','taste_runtime.session_envelope(jsonb,bigint,timestamp with time zone,text)','EXECUTE') AS internal`);
    expect(permissions[0]).toEqual({ table_read: false, schema_create: false, public_create: false, temporary: false,
      bounded_begin: true, legacy_begin: false, health: true, internal: false });
    for (const statement of ['SELECT * FROM taste_runtime.sessions', 'CREATE TABLE taste_runtime.forbidden(id integer)']) {
      let denied = false;
      try { await runtimeSql.query(statement); }
      catch { denied = true; }
      expect(denied).toBe(true);
    }
    let temporaryDdlCode: unknown;
    try { await runtimeSql.query('CREATE TEMP TABLE taste_runtime_forbidden_temp(id integer)'); }
    catch (error) { temporaryDdlCode = error instanceof Error && 'code' in error ? error.code : undefined; }
    expect(temporaryDdlCode).toBe('42501');
    const asRuntime = await runtimeSql.query('SELECT taste_runtime.health() AS ready, current_user AS role');
    expect(asRuntime[0]).toEqual({ ready: true, role: 'taste_runtime_app' });
    await expect(migrateRuntime(runtimeUrl)).rejects.toThrow('Runtime migration failed');
    expect(migrationStatements(await import('node:fs/promises').then(fs => fs.readFile(new URL('../../migrations/001-runtime.sql', import.meta.url), 'utf8'))).length).toBeGreaterThan(20);
  }, 30000);

  it('V03: five canonical Map states survive two actual process replacements; five expired tokens stay missing', async () => {
    const refs: string[] = [];
    const expectedStates: SessionState[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await first().create(); expect(created).not.toBeNull(); if (!created) throw new Error('Missing fixture');
      refs.push(created.ref);
      const begun = await second().begin(created.ref, 0, 'initialize'); expect(begun.status).toBe('admitted');
      if (begun.status !== 'admitted') throw new Error('Missing fixture admission');
      const evidence = { privateRef: `private-${i}`, digest: 'a'.repeat(64), retrievedAt: '2026-10-17T00:00:00.000Z' };
      const seed = { seedIndex: 0, kind: 'movie' as const, qlooEntityId: `synthetic-${i}`, name: 'Synthetic', evidence };
      begun.state.brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic' }], diningPreference: 'quiet', attractionPreference: 'art',
        constraints: { radiusMeters: 1000, excludedVenueRefs: [] } };
      begun.state.resolved = { entities: [seed] };
      begun.state.pending.set('synthetic-pending', { seedIndex: 0, seed });
      begun.state.venues.set('synthetic-venue', { qlooEntityId: 'synthetic', name: 'Synthetic', category: 'dining', evidence, fixtureId: null });
      begun.state.result = { state: 'no-valid-result', revision: 0, reasons: ['no-practical-match'] };
      expect(await first().commit(created.ref, begun.fence, 0, begun.state)).toBe(true);
      const restored = await second().get(created.ref);
      if (!restored) throw new Error('Missing restored fixture');
      expectedStates.push(restored);
      expect(restored).toEqual({ ...begun.state, revision: 1, operationFence: null, expiresAt: expect.any(Number),
        result: { ...begun.state.result, revision: 1 } });
    }
    const childCode = `import {neon} from '@neondatabase/serverless'; let input=''; for await(const chunk of process.stdin) input+=chunk; try { const {url,hashes}=JSON.parse(input); const sql=neon(url); const values=[]; for(const hash of hashes){const rows=await sql.query('SELECT taste_runtime.session_get($1::bytea) AS value',[hash]);values.push(rows[0].value);} process.stdout.write(JSON.stringify(values)); } catch { process.exitCode=1; }`;
    for (let replacement = 0; replacement < 2; replacement++) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'] });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', () => reject(new Error('Database process replacement failed')));
        child.on('close', code => { if (code !== 0) reject(new Error('Database process replacement failed')); else resolve(JSON.parse(output)); });
        child.stdin.end(JSON.stringify({ url: runtimeUrl, hashes: refs.map(hashed) }));
      });
      expect(values).toHaveLength(5);
      for (const [index, value] of values.entries()) {
        const v = value as { status: string; envelope: unknown };
        expect(v.status).toBe('found'); const state = decodeSessionEnvelope(v.envelope);
        expect(state).toEqual({ ...expectedStates[index], expiresAt: expect.any(Number) });
      }
    }
    await databaseQuery("UPDATE taste_runtime.sessions SET expires_at=clock_timestamp()+interval '60 seconds'");
    for (const ref of refs) expect(await second().get(ref)).not.toBeNull();
    const lifetime = await databaseQuery('SELECT min(extract(epoch FROM (expires_at-clock_timestamp())))::float AS ttl FROM taste_runtime.sessions');
    expect(lifetime[0].ttl).toBeGreaterThan(1790); expect(lifetime[0].ttl).toBeLessThanOrEqual(1800);
    await databaseQuery("UPDATE taste_runtime.sessions SET expires_at=clock_timestamp()-interval '1 second'");
    for (const ref of refs) { expect(await second().get(ref)).toBeNull(); expect((await first().begin(ref, 1)).status).toBe('missing'); }
  }, 30000);

  it('V04: exactly20/30 concurrent creations, 200 capacity across10 intervals, expiry frees capacity', async () => {
    let total = 0;
    for (let interval = 0; interval < 10; interval++) {
      if (interval) await databaseQuery("UPDATE taste_runtime.session_creations SET created_at=clock_timestamp()-interval '61 seconds'");
      const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? first() : second()).create()));
      expect(attempts.filter(Boolean)).toHaveLength(20); total += attempts.filter(Boolean).length;
      const retained = attempts.find(Boolean)!;
      for (let i = 0; i < 3; i++) expect(await second().get(retained.ref)).not.toBeNull();
    }
    expect(total).toBe(200);
    await databaseQuery("UPDATE taste_runtime.session_creations SET created_at=clock_timestamp()-interval '61 seconds'");
    expect(await first().create()).toBeNull();
    await databaseQuery("UPDATE taste_runtime.sessions SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await second().create()).not.toBeNull();
  }, 60000);

  it('V05: 1/50 begins, 1/10 commits, wrong/old/expired/canceled fences reject10/10', async () => {
    const created = await first().create(); if (!created) throw new Error('Missing fixture');
    const begins = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? first() : second()).begin(created.ref, 0)));
    expect(begins.filter(b => b.status === 'admitted')).toHaveLength(1);
    const admitted = begins.find(b => b.status === 'admitted'); if (!admitted || admitted.status !== 'admitted') throw new Error('Missing fixture');
    for (let i = 0; i < 10; i++) {
      expect(await second().commit(token(), admitted.fence, 0, admitted.state)).toBe(false);
      expect(await second().commit(created.ref, token(), 0, admitted.state)).toBe(false);
      expect(await second().commit(created.ref, admitted.fence, 1, admitted.state)).toBe(false);
    }
    const commits = await Promise.all(Array.from({ length: 10 }, () => second().commit(created.ref, admitted.fence, 0, admitted.state)));
    expect(commits.filter(Boolean)).toHaveLength(1); expect((await first().get(created.ref))?.revision).toBe(1);
    const next = await first().begin(created.ref, 1); if (next.status !== 'admitted') throw new Error('Missing fixture');
    await databaseQuery("UPDATE taste_runtime.sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1::bytea", [hashed(created.ref)]);
    for (let i = 0; i < 10; i++) expect(await second().commit(created.ref, next.fence, 1, next.state)).toBe(false);
    const replacement = await second().begin(created.ref, 1); if (replacement.status !== 'admitted') throw new Error('Missing replacement');
    await first().finish(created.ref, next.fence); // Old finally cannot clear the replacement.
    expect((await first().begin(created.ref, 1)).status).toBe('busy');
    for (let i = 0; i < 10; i++) expect(await first().commit(created.ref, next.fence, 1, next.state)).toBe(false);
    await first().finish(created.ref, replacement.fence);
    for (let i = 0; i < 10; i++) expect(await second().commit(created.ref, replacement.fence, 1, replacement.state)).toBe(false);
    const other = await first().create(); if (!other) throw new Error('Missing fixture');
    const independent = await Promise.all([first().begin(created.ref, 1), second().begin(other.ref, 0)]);
    expect(independent.every(b => b.status === 'admitted')).toBe(true);
  }, 60000);

  it('V05/S1: exact100ms lease expires; expired and durably canceled fences reject10/10 commits without revision changes', async () => {
    const created = await first().create(); if (!created) throw new Error('Missing fixture');
    for (const duration of [null, 0, 90_001]) {
      await expect(runtimeSql.query('SELECT taste_runtime.session_begin($1::bytea,$2::bigint,$3::text,$4::text,$5::integer)',
        [hashed(created.ref), 0, 'update', token(), duration], { fetchOptions: { signal: AbortSignal.timeout(5_000) } })).rejects.toThrow();
    }
    const begun = await first().begin(created.ref, 0, 'update', 100);
    if (begun.status !== 'admitted') throw new Error('Missing bounded admission');
    const duration = await databaseQuery('SELECT extract(epoch FROM (lease_until-updated_at))*1000 AS ms FROM taste_runtime.sessions WHERE id=$1::bytea', [hashed(created.ref)]);
    expect(Number(duration[0].ms)).toBe(100);
    await new Promise(resolve => setTimeout(resolve, 150));
    for (let i = 0; i < 10; i++) expect(await second().commit(created.ref, begun.fence, 0, begun.state)).toBe(false);
    const canceled = await second().begin(created.ref, 0);
    if (canceled.status !== 'admitted') throw new Error('Missing cancellation admission');
    await first().finish(created.ref, canceled.fence);
    for (let i = 0; i < 10; i++) expect(await second().commit(created.ref, canceled.fence, 0, canceled.state)).toBe(false);
    expect((await first().get(created.ref))?.revision).toBe(0);
  }, 30000);

  it('V09: 20/21 shared body leases; release and6s expiry reclaim capacity', async () => {
    const a = createPostgresBodyLimiter(runtimeUrl); const b = createPostgresBodyLimiter(runtimeUrl);
    const ids = await Promise.all(Array.from({ length: 21 }, (_, i) => (i % 2 ? a : b).acquire()));
    expect(ids.filter(Boolean)).toHaveLength(20);
    const lifetime = await databaseQuery('SELECT max(extract(epoch FROM (expires_at-created_at)))::float AS ttl FROM taste_runtime.body_leases');
    expect(lifetime[0].ttl).toBeLessThanOrEqual(6);
    await a.release(ids.find(Boolean)!); expect(await b.acquire()).not.toBeNull();
    await databaseQuery("UPDATE taste_runtime.body_leases SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await a.acquire()).not.toBeNull();
  }, 30000);

  it('fails closed with sanitized errors on invalid database configuration', async () => {
    await expect(createPostgresSessionRepository('invalid-connection').create()).rejects.toThrow(PostgresPersistenceError);
    expect(await postgresRuntimeReady('invalid-connection')).toBe(false);
  });
});
