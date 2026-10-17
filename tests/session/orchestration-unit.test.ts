import { expect, test } from 'vitest';
import type { Brief, Category, Seed } from '../../src/contracts/concierge';
import type { PracticalFixture } from '../../src/contracts/server';
import type { QlooClient } from '../../src/server/qloo/client';
import { createConcierge } from '../../src/server/concierge/assemble';
import { createUpdatePreferences } from '../../src/server/concierge/update';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { SessionStore } from '../../src/server/session/store';

// Synthetic unit shapes, identities and facts. These are NOT Qloo/source fixtures or acceptance proof.
const origin = ATHENS_ORIGIN!;
let mode: 'bound' | 'unbound' | 'ambiguous' = 'bound';
let searches = 0;
let recommendations: Category[] = [];
let retrieval = 0;
const evidence = () => ({ privateRef: 'unit', digest: 'unit', retrievedAt: new Date(1_000 + retrieval++).toISOString() });
const client: QlooClient = {
  isReady: async () => true,
  runOperation: async work => work(),
  search: async (seed: Seed) => {
    searches++;
    return { evidence: evidence(), body: { results: (mode === 'ambiguous' ? ['a', 'b'] : ['a']).map(id => ({
      entity_id: `unit-seed-${id}`, name: seed.text, types: [`urn:entity:${seed.kind}`], disambiguation: `Unit context ${id}`,
    })) } };
  },
  recommend: async (_, category) => {
    recommendations.push(category);
    return { evidence: evidence(), body: { results: { entities: [1, 2].map(index => ({
      entity_id: `${mode === 'unbound' ? 'unbound' : 'unit'}-${category}-${index}`, name: `Unit ${category} ${index}`,
      subtype: 'urn:entity:place', tags: [{ id: `unit-${category}` }],
      location: { lat: origin.latitude, lon: origin.longitude },
      properties: { geocode: { country_code: 'GR', city: 'Unit city' } },
    })) } } };
  },
  payloadPolicy: () => ({ origin, categoryTagIds: { dining: 'unit-dining', attractions: 'unit-attractions' }, athensCityNames: ['Unit city'] }),
};
const fixtures: PracticalFixture[] = (['dining', 'attractions'] as Category[]).flatMap(category => [1, 2].map(index => ({
  fixtureId: `unit-${category}-${index}`, sourceEntityId: 'synthetic-unit-source', name: `Unit ${category} ${index}`,
  coordinates: origin, category, cityId: 'athens' as const, sourceUrl: 'https://example.invalid/unit-source',
  sourceRevision: 'synthetic-unit-revision', retrievedAt: new Date().toISOString(), license: 'CC0' as const, verification: 'source-reported' as const,
})));
const concierge = createConcierge({ client, fixtures, bindings: fixtures.map(f => ({ qlooEntityId: f.fixtureId,
  fixtureId: f.fixtureId, verified: true, evidenceRef: 'synthetic-unit-binding' })) });
const { assembleConcierge, selectSeeds } = concierge;
const updatePreferences = createUpdatePreferences(concierge);
const brief = (): Brief => ({ cityId: 'athens', seeds: [{ kind: 'movie', text: 'Unit Film' }],
  diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } });

test('unbound genuine-shape candidates yield no-practical-match, zero fabricated cards', async () => {
  mode = 'unbound';
  const state = new SessionStore().create()!.state;
  expect(await assembleConcierge(brief(), state)).toMatchObject({ state: 'no-valid-result', reasons: ['no-practical-match'] });
  expect(state.venues.size).toBe(0);
});

test('dining edit refreshes only dining and preserves attraction timestamp/ref and constraints', async () => {
  mode = 'bound';
  const store = new SessionStore();
  const session = store.create()!;
  const lock = store.begin(session.ref, 0, 'initialize');
  if (lock.status !== 'admitted') throw new Error('admission');
  const original = await assembleConcierge(brief(), lock.state);
  expect(original.state).toBe('ready');
  expect(store.commit(session.ref, lock.fence, 0, lock.state)).toBe(true);
  const change = store.begin(session.ref, 1);
  if (change.status !== 'admitted' || original.state !== 'ready') throw new Error('admission');
  searches = 0; recommendations = [];
  const nextBrief = brief(); nextBrief.diningPreference = 'casual';
  const next = await updatePreferences(nextBrief, 1, change.state);
  expect(next.state).toBe('ready');
  expect(searches).toBe(0);
  expect(recommendations).toEqual(['dining']);
  if (next.state !== 'ready') throw new Error('ready');
  expect(next.items.attractions).toEqual(original.items.attractions);
  expect(change.state.brief!.constraints).toEqual(nextBrief.constraints);
  expect(store.commit(session.ref, change.fence, 1, change.state)).toBe(true);
  expect(store.get(session.ref)!.revision).toBe(2);
});

test('foreign exclusion/selection refs reject before any upstream request', async () => {
  const store = new SessionStore();
  const a = store.create()!.state;
  const invalid = brief(); invalid.constraints.excludedVenueRefs = ['foreign-reference-000000000000'];
  searches = 0; recommendations = [];
  expect(await assembleConcierge(invalid, a)).toMatchObject({ state: 'invalid-input' });
  expect(searches).toBe(0); expect(recommendations).toHaveLength(0);
  mode = 'ambiguous';
  const b = store.create()!.state;
  const choice = await assembleConcierge(brief(), b);
  expect(choice.state).toBe('needs-disambiguation');
  searches = 0; recommendations = [];
  expect(await selectSeeds([{ seedIndex: 0, candidateRef: 'foreign-reference-000000000000' }], 0, b))
    .toMatchObject({ state: 'invalid-input' });
  expect(searches).toBe(0); expect(recommendations).toHaveLength(0);
});
