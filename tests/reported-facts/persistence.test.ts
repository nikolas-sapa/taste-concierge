import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { migrationStatements } from '../../scripts/migrate-runtime';
import { createPostgresSessionRepository } from '../../src/server/persistence/postgres';
import { createConcierge } from '../../src/server/concierge/assemble';
import { createUpdatePreferences } from '../../src/server/concierge/update';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { encodeSessionEnvelope } from '../../src/server/persistence/codec';
import type { Brief, Category } from '../../src/contracts/concierge';
import type { PracticalFixture } from '../../src/contracts/server';
import type { QlooClient } from '../../src/server/qloo/client';

// Opt-in actual adapters. Every mutable object is in this generated schema. No active fixture suite.
const schema = `taste_runtime_test_${randomBytes(8).toString('hex')}`;
describe.skipIf(process.env.RUN_RF_POSTGRES !== '1')('RF07 isolated actual session/codec persistence', () => {
  let admin: ReturnType<typeof neon>;
  let runtimeUrl: string;
  let created = false;
  beforeAll(async () => {
    // Separate parses prevent operator credentials from replacing restricted runtime credentials.
    const operatorEnv = parseEnv(await readFile(new URL('../../.env.vercel-access', import.meta.url), 'utf8'));
    const runtimeEnv = parseEnv(await readFile(new URL('../../.env.runtime-access', import.meta.url), 'utf8'));
    if (!operatorEnv.DATABASE_URL || !runtimeEnv.DATABASE_URL || operatorEnv.DATABASE_URL === runtimeEnv.DATABASE_URL) throw new Error('Distinct isolated-test database credentials required');
    admin = neon(operatorEnv.DATABASE_URL); runtimeUrl = runtimeEnv.DATABASE_URL;
    await admin.query(`create schema ${schema}`, [], { fetchOptions: { signal: AbortSignal.timeout(5000) } }); created = true;
    for (const migration of ['001-runtime.sql', '004-session-envelope-v2.sql']) {
      const source = (await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8')).replace(/\btaste_runtime\b/g, schema);
      const statements = migrationStatements(source).filter(statement => !statement.startsWith('DO $role$') && !statement.startsWith('DO $temporary_ddl$'));
      await admin.transaction(statements.map(statement => admin.query(statement)), { fetchOptions: { signal: AbortSignal.timeout(15000) } });
    }
  }, 30000);
  afterAll(async () => { if (created) await admin.query(`drop schema ${schema} cascade`, [], { fetchOptions: { signal: AbortSignal.timeout(10000) } }); }, 15000);

  test('RF07 actual SQL guards: numeric v1 create/commit accepted; 15 invalid version/revision/fence requests rejected', async () => {
    const runtime = neon(runtimeUrl);
    const query = (statement: string, params: unknown[]) => runtime.query(statement, params,
      { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    const token = randomBytes(32).toString('hex');
    const hash = `\\x${createHash('sha256').update(token).digest('hex')}`;
    const freshHash = () => `\\x${randomBytes(32).toString('hex')}`;
    const empty = () => ({ version: 1, state: { revision: 0, brief: null, resolved: null, pending: [], venues: [],
      result: null, expiresAt: 1, operationFence: null } });
    const invalidVersions = [undefined, null, '2', 3, '3'];
    let rejectedCreates = 0;
    for (const version of invalidVersions) {
      const envelope = { ...empty(), version };
      await expect(query(`select ${schema}.session_create($1::bytea,$2::jsonb) as value`,
        [freshHash(), JSON.stringify(envelope)])).rejects.toMatchObject({ message: 'Invalid session input' });
      rejectedCreates++;
    }
    for (const patch of [{ revision: 1 }, { operationFence: randomBytes(32).toString('hex') }]) {
      const envelope = empty(); Object.assign(envelope.state, patch);
      await expect(query(`select ${schema}.session_create($1::bytea,$2::jsonb) as value`,
        [freshHash(), JSON.stringify(envelope)])).rejects.toMatchObject({ message: 'Invalid session input' });
      rejectedCreates++;
    }
    const created = await query(`select ${schema}.session_create($1::bytea,$2::jsonb) as value`, [hash, JSON.stringify(empty())]);
    expect(created[0].value).toMatchObject({ status: 'created', envelope: { version: 1 } });
    const repository = createPostgresSessionRepository(runtimeUrl, schema);
    const begin = await repository.begin(token, 0, 'initialize');
    if (begin.status !== 'admitted') throw new Error('Isolated v1 admission failed');
    const acceptedEnvelope = JSON.parse(encodeSessionEnvelope(begin.state)); acceptedEnvelope.version = 1;
    const commit = (envelope: unknown, revision = 0, fence = begin.fence) =>
      query(`select ${schema}.session_commit($1::bytea,$2::text,$3::bigint,$4::jsonb) as value`,
        [hash, fence, revision, JSON.stringify(envelope)]);
    let rejectedCommits = 0;
    for (const version of invalidVersions) {
      const rows = await commit({ ...acceptedEnvelope, version }); expect(rows[0].value).toBe(false); rejectedCommits++;
    }
    const wrongRevision = await commit(acceptedEnvelope, 1); expect(wrongRevision[0].value).toBe(false); rejectedCommits++;
    const wrongFence = await commit(acceptedEnvelope, 0, randomBytes(32).toString('hex')); expect(wrongFence[0].value).toBe(false); rejectedCommits++;
    const wrongEnvelope = structuredClone(acceptedEnvelope); wrongEnvelope.state.operationFence = randomBytes(32).toString('hex');
    const wrongEnvelopeFence = await commit(wrongEnvelope); expect(wrongEnvelopeFence[0].value).toBe(false); rejectedCommits++;
    expect(rejectedCreates).toBe(7); expect(rejectedCommits).toBe(8);
    // Rejections must not consume the valid lease/revision.
    const committed = await commit(acceptedEnvelope); expect(committed[0].value).toBe(true);
    const stored = await query(`select ${schema}.session_get($1::bytea) as value`, [hash]);
    expect(stored[0].value).toMatchObject({ status: 'found', envelope: { version: 1, state: { revision: 1, operationFence: null } } });
    const restored = await repository.get(token); expect(restored).toMatchObject({ revision: 1, result: null });
    expect(restored?.venues.size).toBe(0);
  }, 30000);

  test.each(['dining', 'attractions'] as Category[])('mixed-source session with %s unbound restores, edits one category, preserves other exactly', async unbound => {
    const point = { latitude: ATHENS_ORIGIN!.latitude, longitude: ATHENS_ORIGIN!.longitude };
    const evidence = { privateRef: 'synthetic-private-evidence', digest: 'synthetic-digest', retrievedAt: '2026-10-17T00:00:00Z' };
    const fixtures: PracticalFixture[] = (['dining', 'attractions'] as Category[]).map(category => ({ fixtureId: `synthetic-${category}`, sourceEntityId: 'synthetic-independent-source', name: `Synthetic ${category}`, category, cityId: 'athens', coordinates: point, sourceUrl: 'https://example.invalid/source', sourceRevision: 'synthetic-revision', retrievedAt: evidence.retrievedAt, license: 'CC0', verification: 'source-reported' }));
    let retrieval = 0;
    const client: QlooClient = { isReady: async () => true, runOperation: work => work(), payloadPolicy: () => ({ origin: point, athensCityNames: ['Athens'], categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-attractions' } }), search: async seed => ({ evidence, body: { results: [{ entity_id: 'synthetic-seed', name: seed.text, types: ['urn:entity:movie'] }] } }), recommend: async (_, category) => ({ evidence: { ...evidence, retrievedAt: new Date(Date.parse(evidence.retrievedAt) + retrieval++).toISOString() }, body: { results: { entities: [{ entity_id: `synthetic-${category}`, name: `Synthetic ${category}`, subtype: 'urn:entity:place', tags: [{ id: `synthetic-${category}` }], location: { lat: point.latitude, lon: point.longitude }, properties: { geocode: { country_code: 'GR', city: 'Athens' } } }] } } }) };
    const concierge = createConcierge({ client, fixtures, bindings: fixtures.filter(f => f.category !== unbound).map(f => ({ qlooEntityId: f.fixtureId, fixtureId: f.fixtureId, verified: true, evidenceRef: 'synthetic-binding' })) });
    const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic film' }], diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };
    const repository = createPostgresSessionRepository(runtimeUrl, schema);
    const session = await repository.create(); if (!session) throw new Error('Isolated session create failed');
    const begin = await repository.begin(session.ref, 0, 'initialize'); if (begin.status !== 'admitted') throw new Error('Isolated admission failed');
    const initial = await concierge.assembleConcierge(brief, begin.state); expect(initial.state).toBe('ready');
    if (initial.state !== 'ready') throw new Error('Synthetic ready failed');
    expect(initial.items[unbound].primary.practicalFacts.every(f => f.source === 'qloo')).toBe(true);
    expect(initial.items[unbound === 'dining' ? 'attractions' : 'dining'].primary.practicalFacts.every(f => f.source === 'independent')).toBe(true);
    expect(Buffer.byteLength(encodeSessionEnvelope(begin.state))).toBeLessThanOrEqual(262144);
    expect(await repository.commit(session.ref, begin.fence, 0, begin.state)).toBe(true);
    const restored = await createPostgresSessionRepository(runtimeUrl, schema).get(session.ref);
    expect(restored?.result).toEqual({ ...initial, revision: 1 });
    expect(restored?.venues).toEqual(begin.state.venues);
    const edit = await repository.begin(session.ref, 1); if (edit.status !== 'admitted') throw new Error('Isolated edit admission failed');
    const changed = { ...brief, diningPreference: 'small plates' };
    const next = await createUpdatePreferences(concierge)(changed, 1, edit.state);
    if (next.state !== 'ready') throw new Error('Synthetic edit failed');
    expect(next.items.attractions).toEqual(initial.items.attractions);
    expect(await repository.commit(session.ref, edit.fence, 1, edit.state)).toBe(true);
    const final = await createPostgresSessionRepository(runtimeUrl, schema).get(session.ref);
    expect(final?.result).toEqual({ ...next, revision: 2 });
    expect(final?.venues).toEqual(edit.state.venues);
    if (final?.result?.state !== 'ready') throw new Error('Isolated final restore failed');
    expect(final.result.items.attractions).toEqual(initial.items.attractions);
  }, 30000);
});

test('RF07 schema qualifier rejects 8 unsafe variants before network', () => {
  for (const name of ['', 'public', 'taste_runtime_test_', 'taste_runtime_test_z', 'taste_runtime;select 1', 'taste_runtime.test', 'taste_runtime_test_ab cd', 'TASTE_RUNTIME']) expect(() => createPostgresSessionRepository('postgresql://unused:unused@example.invalid/unused', name)).toThrow();
});
