import { expect, test } from 'vitest';
import type { Brief, Category } from '../../../src/contracts/concierge';
import type { PracticalFixture } from '../../../src/contracts/server';
import type { QlooClient } from '../../../src/server/qloo/client';
import type { ModelService, RankedFixture } from '../../../src/server/model/responses';
import { createConcierge } from '../../../src/server/concierge/assemble';
import { createUpdatePreferences } from '../../../src/server/concierge/update';
import { SessionStore } from '../../../src/server/session/store';
import { ATHENS_ORIGIN } from '../../../src/server/practical/origin';

// Synthetic orchestration boundaries only. No actual provider/source/acceptance evidence.
test('model receives preferences and actual ordinals after Qloo phase; edit preserves other category', async () => {
  const categories: Category[] = ['dining', 'attractions'];
  const fixtures: PracticalFixture[] = categories.flatMap(category => [1, 2].map(index => ({
    fixtureId: `unit-${category}-${index}`, sourceEntityId: 'unit-independent-source', name: `Synthetic ${category} ${index}`,
    category, cityId: 'athens', coordinates: ATHENS_ORIGIN!, sourceUrl: 'https://example.invalid/source',
    sourceRevision: 'unit', retrievedAt: '2026-10-14T00:00:00Z', license: 'CC0', verification: 'source-reported',
  })));
  let inQloo = false;
  let tick = 0;
  const calls: { arm: string; brief: Brief; pool: readonly PracticalFixture[]; ranks?: readonly RankedFixture[] }[] = [];
  const client: QlooClient = {
    isReady: async () => true,
    runOperation: async work => { inQloo = true; try { return await work(); } finally { inQloo = false; } },
    payloadPolicy: () => ({ origin: ATHENS_ORIGIN!, categoryTagIds: { dining: 'unit-dining', attractions: 'unit-attractions' }, athensCityNames: ['Unit city'] }),
    search: async seed => ({ evidence: { privateRef: 'unit', digest: 'unit', retrievedAt: new Date(tick++).toISOString() },
      body: { results: [{ entity_id: 'private-unit-seed', name: seed.text, types: ['urn:entity:movie'] }] } }),
    recommend: async (_, category) => ({ evidence: { privateRef: 'unit', digest: 'unit', retrievedAt: new Date(tick++).toISOString() },
      body: { results: { entities: [{ subtype: 'invalid-unit-row' }, ...[1, 2].map(index => ({
        entity_id: `private-unit-${category}-${index}`, name: `Synthetic ${category} ${index}`, subtype: 'urn:entity:place',
        tags: [{ id: `unit-${category}` }], location: { lat: ATHENS_ORIGIN!.latitude, lon: ATHENS_ORIGIN!.longitude },
        properties: { geocode: { country_code: 'GR', city: 'Unit city' } },
      }))] } } }),
  };
  const model: ModelService = {
    isReady: async () => true, close: async () => {},
    interpretTreatment: async (brief, pool, ranks) => {
      expect(inQloo).toBe(false);
      expect(JSON.stringify(ranks)).not.toContain('private-unit');
      calls.push({ arm: 'treatment', brief: structuredClone(brief), pool, ranks });
      return { status: 'ready', model: 'synthetic-model', items: categories.map((category, index) => ({
        fixtureRef: `unit-${category}-2`, category, role: 'primary', order: index === 0 ? 1 : 2, reasonCodes: ['stated-preference'],
      })) };
    },
    generateBaseline: async (brief, pool) => {
      expect(inQloo).toBe(false);
      expect(JSON.stringify(pool)).not.toContain('private-unit');
      calls.push({ arm: 'baseline', brief: structuredClone(brief), pool });
      return { status: 'unavailable', reason: 'model-unavailable' };
    },
  };
  const concierge = createConcierge({ client, model, fixtures, bindings: fixtures.map(fixture => ({
    qlooEntityId: `private-${fixture.fixtureId}`, fixtureId: fixture.fixtureId, verified: true, evidenceRef: 'unit-binding',
  })) });
  const { assembleConcierge } = concierge;
  const updatePreferences = createUpdatePreferences(concierge);
  const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic Film' }],
    diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 900, excludedVenueRefs: [] } };
  const store = new SessionStore(); const session = store.create()!;
  const begin = store.begin(session.ref, 0, 'initialize');
  if (begin.status !== 'admitted') throw new Error('unit admission');
  const original = await assembleConcierge(brief, begin.state);
  if (original.state !== 'ready') throw new Error('unit ready');
  expect(original.items.dining.primary.name).toBe('Synthetic dining 2');
  expect(calls[0].ranks!.map(item => item.rank)).toEqual([2, 3, 2, 3]);
  expect(calls[0].pool).toEqual(calls[1].pool);
  expect(calls[0].brief).toEqual(calls[1].brief);
  expect(store.commit(session.ref, begin.fence, 0, begin.state)).toBe(true);
  const editing = store.begin(session.ref, 1);
  if (editing.status !== 'admitted') throw new Error('unit edit');
  const changed = { ...brief, diningPreference: 'small plates' };
  const next = await updatePreferences(changed, 1, editing.state);
  if (next.state !== 'ready') throw new Error('unit ready edit');
  expect(calls[2].brief.diningPreference).toBe('small plates');
  expect(calls[2].ranks!.filter(item => item.category === 'attractions').map(item => item.rank)).toEqual([3]);
  expect(next.items.attractions).toEqual(original.items.attractions);
  expect(editing.state.brief!.constraints).toEqual(brief.constraints);
});
