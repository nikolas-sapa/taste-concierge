import { expect, test } from 'vitest';
import type { Brief, Category } from '../../src/contracts/concierge';
import type { InternalCandidate, PracticalFixture, SessionState } from '../../src/contracts/server';
import { normalizeRecommendations } from '../../src/server/qloo/normalize';
import { resolvePracticalOption, fixtureOption } from '../../src/server/practical/resolve';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { validateSelections, eligibleFixtures } from '../../src/server/model/validation';
import { buildModelRequest } from '../../src/server/model/responses';
import { decodeSessionEnvelope, encodeSessionEnvelope } from '../../src/server/persistence/codec';
import { loadPracticalFixtures } from '../../src/server/practical';

// Entrant-authored synthetic boundary records, not provider evidence.
const evidence = { privateRef: 'synthetic-private', digest: 'synthetic-digest', retrievedAt: '2026-10-17T00:00:00Z' };
const point = { latitude: ATHENS_ORIGIN!.latitude, longitude: ATHENS_ORIGIN!.longitude };
const config = { categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-museum' }, origin: ATHENS_ORIGIN!, athensCityNames: ['Athens'] };
const row = () => ({ entity_id: 'synthetic-provider-id', name: 'Synthetic venue', subtype: 'urn:entity:place', tags: [{ id: 'synthetic-dining' }], location: { lat: ATHENS_ORIGIN!.latitude, lon: ATHENS_ORIGIN!.longitude }, properties: { geocode: { country_code: 'GR', city: 'Athens' } } });
const candidate = (category: Category = 'dining'): InternalCandidate => ({ qlooEntityId: `synthetic-${category}`, name: 'Synthetic venue', category, fixtureId: null, qlooRank: 1, evidence, qlooReported: { cityId: 'athens', category, coordinates: point } });
const fixture = (category: Category = 'dining'): PracticalFixture => ({ fixtureId: `synthetic-independent-${category}`, sourceEntityId: 'synthetic-source', name: 'Independent venue', category, cityId: 'athens', coordinates: point, sourceUrl: 'https://example.invalid/source', sourceRevision: 'synthetic-revision', retrievedAt: evidence.retrievedAt, license: 'CC0', verification: 'source-reported' });
const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic seed' }], diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };

test('RF02: 15 invalid reported-source variants yield zero candidates', () => {
  const mutations = [ { location: undefined }, { location: { lat: NaN, lon: 0 } }, { location: { lat: 91, lon: 0 } }, { location: { lat: 0, lon: 181 } }, { location: { lat: 0 } }, { properties: { geocode: { country_code: 'US', city: 'Athens' } } }, { properties: { geocode: { country_code: 'GR', city: 'Paris' } } }, { tags: [{ id: 'wrong' }] }, { subtype: 'urn:entity:movie' }, { entity_id: '' }, { name: '' }, { tags: [] } ];
  for (const patch of mutations) expect(normalizeRecommendations({ results: { entities: [{ ...row(), ...patch }] } }, 'dining', 3000, config, evidence, [])).toHaveLength(0);
  for (const retrievedAt of ['', 'invalid']) expect(normalizeRecommendations({ results: { entities: [row()] } }, 'dining', 3000, config, { ...evidence, retrievedAt }, [])).toHaveLength(0);
  const missingTime = { ...evidence }; delete (missingTime as Partial<typeof evidence>).retrievedAt;
  expect(normalizeRecommendations({ results: { entities: [row()] } }, 'dining', 3000, config, missingTime, [])).toHaveLength(0);
});

test('RF02: six city-authority cases reject contradictions and preserve district/fallback handling', () => {
  const cases = [
    { geocode: { country_code: 'GR', city: 'Thessaloniki', name: 'Athens' }, expected: 0 },
    { geocode: { country_code: 'GR', name: 'Athens' }, locality: { city: { name: 'Thessaloniki' } }, expected: 0 },
    { geocode: { country_code: 'GR', city: 'Athens', name: 'Athens' }, locality: { city: { name: 'Thessaloniki' } }, expected: 0 },
    { geocode: { country_code: 'GR', city: 'Athens', name: '1st District of Athens' }, locality: { city: { name: 'Athens' } }, expected: 1 },
    { geocode: { country_code: 'GR', city: '', name: 'Athens' }, locality: { city: { name: '  ' } }, expected: 1 },
    { geocode: { country_code: 'GR' }, expected: 0 },
  ];
  for (const { expected, ...properties } of cases) {
    const result = normalizeRecommendations({ results: { entities: [{ ...row(), properties }] } }, 'dining', 3000, config, evidence, []);
    expect(result).toHaveLength(expected);
  }
});

test('RF03: six precedence cases admit only valid bound and genuinely unbound', () => {
  const bound = { ...candidate(), fixtureId: fixture().fixtureId };
  const cases: [InternalCandidate, PracticalFixture[], boolean][] = [[bound, [fixture()], true], [candidate(), [], true], [{ ...bound, fixtureId: 'dangling' }, [fixture()], false], [bound, [fixture(), fixture()], false], [bound, [{ ...fixture(), category: 'attractions' }], false], [bound, [{ ...fixture(), coordinates: null }], false]];
  for (const [c, fixtures, valid] of cases) expect(!!resolvePracticalOption(c, fixtures, 'opaque')).toBe(valid);
  const binding = { qlooEntityId: row().entity_id, fixtureId: 'a', verified: true as const, evidenceRef: 'synthetic' };
  expect(normalizeRecommendations({ results: { entities: [row()] } }, 'dining', 3000, config, evidence, [binding, binding])).toHaveLength(0);
});

test('RF05/RF06: 12 fact origins, baseline isolation and eight invalid selections', () => {
  const cards = ['dining', 'attractions'].flatMap(category => [resolvePracticalOption(candidate(category as Category), [], `opaque-${category}`)!, fixtureOption(fixture(category as Category))]);
  expect(cards.flatMap(c => c.practicalFacts)).toHaveLength(12);
  for (const option of cards) for (const fact of option.practicalFacts) {
    expect(['independent', 'qloo']).toContain(fact.source);
    expect(fact.sourceRevision).toBe(fact.source === 'qloo' ? null : 'synthetic-revision');
  }
  const pool = cards.filter(c => c.fixtureRef.startsWith('opaque-'));
  const ranks = pool.map(p => ({ fixtureRef: p.fixtureRef, category: p.category, rank: 1 }));
  const output = () => ({ items: pool.map((p, i) => ({ fixtureRef: p.fixtureRef, category: p.category, role: 'primary', order: i + 1, reasonCodes: ['within-radius'] })) });
  expect(validateSelections(output(), pool, 'treatment', ranks)).toHaveLength(2);
  for (const patch of [{ fixtureRef: 'foreign' }, { category: 'attractions' }, { role: 'bad' }, { order: 0 }, { reasonCodes: ['invented'] }, { reasonCodes: ['within-radius', 'within-radius'] }, { price: 12 }, { reasonCodes: ['within-radius', 'source-category', 'stated-preference'] }]) { const v = output(); Object.assign(v.items[0], patch); expect(validateSelections(v, pool, 'treatment', ranks)).toBeNull(); }
  const duplicate = output(); duplicate.items[1].fixtureRef = duplicate.items[0].fixtureRef;
  expect(validateSelections(duplicate, pool, 'treatment', ranks)).toBeNull();
  const baseline = JSON.stringify(buildModelRequest(brief, [fixtureOption(fixture()), fixtureOption(fixture('attractions'))], 'baseline'));
  for (const forbidden of ['synthetic-provider-id', 'synthetic-private', 'synthetic-digest', 'opaque-', 'qlooReported', 'qloo-rank']) expect(baseline).not.toContain(forbidden);
  const excluding = structuredClone(brief); excluding.constraints.excludedVenueRefs = ['unbound-one', 'unbound-two'];
  expect(eligibleFixtures(excluding, [fixture(), fixture('attractions')], [])).toHaveLength(2);
});

test('RF07: codec v2 mixed facts, eight invalid shapes, explicit independent-only v1 migration', () => {
  const option = resolvePracticalOption(candidate(), [], 'opaque')!;
  const card = { ref: 'opaque', name: 'Synthetic', category: 'dining' as const, source: 'qloo' as const, interpretation: 'Source-reported', practicalFacts: option.practicalFacts, limitations: ['Not independently verified'], retrievedAt: evidence.retrievedAt };
  const state: SessionState = { revision: 0, brief, resolved: null, pending: new Map(), venues: new Map([['opaque', candidate()]]), result: { state: 'ready', revision: 1, items: { dining: { primary: card, alternative: null }, attractions: { primary: { ...card, category: 'attractions', practicalFacts: fixtureOption(fixture('attractions')).practicalFacts }, alternative: null } }, baseline: { status: 'unavailable', reason: 'model-unavailable' } }, expiresAt: Date.now() + 10000, operationFence: null };
  const envelope = JSON.parse(encodeSessionEnvelope(state)); expect(envelope.version).toBe(2);
  expect(decodeSessionEnvelope(envelope)).toEqual(state);
  const patches = [ { cityId: 'paris' }, { category: 'movie' }, { coordinates: null }, { coordinates: { latitude: 91, longitude: 0 } }, { coordinates: { latitude: 0 } }, { secret: 'x' } ];
  for (const patch of patches) { const v = structuredClone(envelope); Object.assign(v.state.venues[0][1].qlooReported, patch); expect(() => decodeSessionEnvelope(v)).toThrow(); }
  for (const source of [undefined, 'verified']) { const v = structuredClone(envelope); v.state.result.items.dining.primary.practicalFacts[0].source = source; expect(() => decodeSessionEnvelope(v)).toThrow(); }
  const legacy = structuredClone(envelope); legacy.version = 1; delete legacy.state.venues[0][1].qlooReported;
  legacy.state.venues[0][1].fixtureId = fixture().fixtureId;
  legacy.state.result.items.dining.primary.practicalFacts = fixtureOption(fixture()).practicalFacts;
  for (const item of Object.values(legacy.state.result.items) as { primary: typeof card }[]) for (const fact of item.primary.practicalFacts) delete (fact as Partial<typeof fact>).source;
  expect(decodeSessionEnvelope(legacy).result).toMatchObject({ items: { dining: { primary: { practicalFacts: [{ source: 'independent' }, { source: 'independent' }, { source: 'independent' }] } } } });
  expect(decodeSessionEnvelope(legacy).venues.get('opaque')?.qlooReported).toBeUndefined();
});

test('RF08: independent public fixture inventory stays 39 (4 dining/35 attractions)', () => { const fixtures = loadPracticalFixtures(); expect(fixtures).toHaveLength(39); expect(fixtures.filter(f => f.category === 'dining')).toHaveLength(4); expect(fixtures.filter(f => f.category === 'attractions')).toHaveLength(35); });
