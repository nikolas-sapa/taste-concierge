import { expect, test } from 'vitest';
import type { Brief, Category, Seed } from '../../src/contracts/concierge';
import type { PracticalFixture } from '../../src/contracts/server';
import type { QlooClient } from '../../src/server/qloo/client';
import type { ModelService } from '../../src/server/model/responses';
import { createConcierge } from '../../src/server/concierge/assemble';
import { SessionStore } from '../../src/server/session/store';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';

const brief = (): Brief => ({ cityId: 'athens', seeds: [{ kind: 'movie', text: 'Isolation Film' }],
  diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } });

function fixtureSet(owner: string): PracticalFixture[] {
  return (['dining', 'attractions'] as Category[]).flatMap(category => [1, 2].map(index => ({
    fixtureId: `${owner}-${category}-${index}`, sourceEntityId: `${owner}-source`, name: `${owner} ${category} ${index}`,
    category, cityId: 'athens' as const, coordinates: ATHENS_ORIGIN!, sourceUrl: `https://example.invalid/${owner}`,
    sourceRevision: owner, retrievedAt: '2026-10-16T00:00:00Z', license: 'CC0' as const,
    verification: 'source-reported' as const,
  })));
}

function dependencies(owner: string) {
  const counters = { qlooOperations: 0, treatment: 0, baseline: 0 };
  const fixtures = fixtureSet(owner);
  const evidence = { privateRef: `${owner}-evidence`, digest: `${owner}-digest`, retrievedAt: '2026-10-16T00:00:00Z' };
  const client: QlooClient = {
    isReady: async () => true,
    runOperation: async work => { counters.qlooOperations++; return work(); },
    payloadPolicy: () => ({ origin: ATHENS_ORIGIN!, categoryTagIds: { dining: `${owner}-dining`, attractions: `${owner}-attractions` }, athensCityNames: [`${owner} city`] }),
    search: async (seed: Seed) => ({ evidence, body: { results: [{ entity_id: `${owner}-seed`, name: seed.text,
      types: [`urn:entity:${seed.kind}`] }] } }),
    recommend: async (_, category) => ({ evidence, body: { results: { entities: [1, 2].map(index => ({
      entity_id: `${owner}-${category}-${index}`, name: `${owner} ${category} ${index}`, subtype: 'urn:entity:place',
      tags: [{ id: `${owner}-${category}` }], location: { lat: ATHENS_ORIGIN!.latitude, lon: ATHENS_ORIGIN!.longitude },
      properties: { geocode: { country_code: 'GR', city: `${owner} city` } },
    })) } } }),
  };
  const model: ModelService = {
    isReady: async () => true,
    interpretTreatment: async (_brief, pool) => {
      expect(pool.every(fixture => fixture.fixtureId.startsWith(`${owner}-`))).toBe(true);
      counters.treatment++;
      return { status: 'unavailable', reason: 'model-unavailable' };
    },
    generateBaseline: async (_brief, pool) => {
      expect(pool.every(fixture => fixture.fixtureId.startsWith(`${owner}-`))).toBe(true);
      counters.baseline++;
      return { status: 'unavailable', reason: 'model-unavailable' };
    },
    close: async () => {},
  };
  return { counters, client, model, fixtures,
    bindings: fixtures.map(fixture => ({ qlooEntityId: fixture.fixtureId, fixtureId: fixture.fixtureId,
      verified: true as const, evidenceRef: `${owner}-binding` })) };
}

test('20 interleaved operations stay within their immutable concierge dependencies', async () => {
  const firstDeps = dependencies('first');
  const secondDeps = dependencies('second');
  const first = createConcierge(firstDeps);
  const second = createConcierge(secondDeps);
  const instances = [first, second];
  const owners = ['first', 'second'];

  for (let index = 0; index < 20; index++) {
    const ownerIndex = index % 2;
    const state = new SessionStore().create()!.state;
    const result = await instances[ownerIndex].assembleConcierge(brief(), state);
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.items.dining.primary.name.startsWith(`${owners[ownerIndex]} `)).toBe(true);
      expect(result.items.attractions.primary.name.startsWith(`${owners[ownerIndex]} `)).toBe(true);
    }
  }

  expect(firstDeps.counters).toEqual({ qlooOperations: 10, treatment: 10, baseline: 10 });
  expect(secondDeps.counters).toEqual({ qlooOperations: 10, treatment: 10, baseline: 10 });
});
