import { afterEach, expect, test, vi } from 'vitest';
import type { Brief, Category } from '../../src/contracts/concierge';
import type { InternalCandidate, PracticalFixture } from '../../src/contracts/server';
import type { QlooClient } from '../../src/server/qloo/client';
import type { ModelService } from '../../src/server/model/responses';
import { createConcierge } from '../../src/server/concierge/assemble';
import { SessionStore } from '../../src/server/session/store';
import { filterPractical } from '../../src/server/practical/filter';
import { distanceMeters } from '../../src/server/practical/geometry';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { eligibleFixtures } from '../../src/server/model/validation';

const point = { latitude: ATHENS_ORIGIN!.latitude, longitude: ATHENS_ORIGIN!.longitude };
const evidence = { privateRef: 'synthetic-evidence', digest: 'synthetic-digest', retrievedAt: '2026-10-17T00:00:00Z' };
const brief = (): Brief => ({ cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic seed' }], diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } });
const candidate = (category: Category, coordinates = point): InternalCandidate => ({ qlooEntityId: `synthetic-${category}`, name: 'Synthetic', category, fixtureId: null, evidence, qlooReported: { cityId: 'athens', category, coordinates } });

afterEach(() => { vi.doUnmock('../../src/server/practical/origin'); vi.resetModules(); });
test('RF04: inside/on/outside/zero/negative/missing-origin six boundaries', async () => {
  const east = { ...point, longitude: point.longitude + 0.005 }; const boundary = distanceMeters(point, east)!;
  const batch = { byCategory: { dining: [candidate('dining', east)], attractions: [candidate('attractions', east)] } };
  for (const [radiusMeters, valid] of [[boundary + 1, true], [boundary, true], [boundary - 1, false], [0, false], [-1, false]] as const) {
    const b = brief(); b.constraints.radiusMeters = radiusMeters; expect(filterPractical(batch, b, []).status === 'valid').toBe(valid);
  }
  const atOrigin = { byCategory: { dining: [candidate('dining')], attractions: [candidate('attractions')] } };
  const zero = brief(); zero.constraints.radiusMeters = 0; expect(filterPractical(atOrigin, zero, []).status).toBe('valid');
  vi.resetModules();
  vi.doMock('../../src/server/practical/origin', () => ({ ATHENS_ORIGIN: null }));
  const missingOrigin = await import('../../src/server/practical/filter');
  expect(missingOrigin.filterPractical(batch, brief(), [])).toMatchObject({ status: 'none', reasons: ['missing-origin'] });
});

test.each([true, false])('RF04: independent=%s one/two actual session exclusions removed, baseline remains eligible', async independent => {
  const fixtures: PracticalFixture[] = (['dining', 'attractions'] as Category[]).flatMap(category => [1, 2, 3].map(index => ({ fixtureId: `synthetic-${category}-${index}`, sourceEntityId: 'synthetic-source', name: `Synthetic ${category} ${index}`, category, cityId: 'athens', coordinates: point, sourceUrl: 'https://example.invalid/source', sourceRevision: 'synthetic', retrievedAt: evidence.retrievedAt, license: 'CC0', verification: 'source-reported' })));
  const sends = vi.fn();
  const client: QlooClient = { isReady: async () => true, runOperation: work => work(), payloadPolicy: () => ({ origin: point, athensCityNames: ['Athens'], categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-attractions' } }), search: async seed => { sends(); return { evidence, body: { results: [{ entity_id: 'synthetic-seed', name: seed.text, types: ['urn:entity:movie'] }] } }; }, recommend: async (_, category) => { sends(); return { evidence, body: { results: { entities: [1, 2, 3].map(index => ({ entity_id: `synthetic-${category}-${index}`, name: `Synthetic ${category} ${index}`, subtype: 'urn:entity:place', tags: [{ id: `synthetic-${category}` }], location: { lat: point.latitude, lon: point.longitude }, properties: { geocode: { country_code: 'GR', city: 'Athens' } } })) } } }; } };
  const baselineExclusions: string[][] = [];
  const model: ModelService = { isReady: async () => false, close: async () => {}, interpretTreatment: async () => ({ status: 'unavailable', reason: 'model-unavailable' }), generateBaseline: async (b, f, _, excluded) => { baselineExclusions.push([...(excluded ?? [])]); expect(eligibleFixtures(b, f, excluded)).not.toBeNull(); return { status: 'unavailable', reason: 'model-unavailable' }; } };
  const concierge = createConcierge({ client, model, fixtures, bindings: independent ? fixtures.map(f => ({ qlooEntityId: f.fixtureId, fixtureId: f.fixtureId, verified: true, evidenceRef: 'synthetic-binding' })) : [] });
  for (const count of [1, 2]) {
    const state = new SessionStore().create()!.state; const b = brief(); const initial = await concierge.assembleConcierge(b, state);
    if (initial.state !== 'ready') throw new Error('Synthetic initial ready');
    const cards = [initial.items.dining.primary, initial.items.dining.alternative!].slice(0, count);
    const excludedIds = cards.map(c => state.venues.get(c.ref)!.qlooEntityId);
    b.constraints.excludedVenueRefs = cards.map(c => c.ref); const result = await concierge.assembleConcierge(b, state);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Synthetic exclusion ready');
    const shown = Object.values(result.items).flatMap(i => [i.primary, ...(i.alternative ? [i.alternative] : [])]);
    expect(shown.every(c => !excludedIds.includes(state.venues.get(c.ref)!.qlooEntityId))).toBe(true);
    expect(baselineExclusions.at(-1)).toHaveLength(independent ? count : 0);
  }
  sends.mockClear(); const invalid = brief(); invalid.constraints.radiusMeters = -1;
  expect(await concierge.assembleConcierge(invalid, new SessionStore().create()!.state)).toMatchObject({ state: 'invalid-input' });
  expect(sends).toHaveBeenCalledTimes(0);
  for (const constraints of [{ maxBudgetEur: 10 }, { localOpeningTime: '18:00' }]) { const unsupported = brief(); Object.assign(unsupported.constraints, constraints); expect(await concierge.assembleConcierge(unsupported, new SessionStore().create()!.state)).toMatchObject({ state: 'unsupported-constraint' }); }
  expect(sends).toHaveBeenCalledTimes(0);
});
