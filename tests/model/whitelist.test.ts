import { expect, test } from 'vitest';
import type { Brief } from '../../src/contracts/concierge';
import type { PracticalFixture } from '../../src/contracts/server';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';
import { eligibleFixtures, validateSelections } from '../../src/server/model/validation';
import { buildModelRequest, MODEL_SNAPSHOT } from '../../src/server/model/responses';

// Synthetic independent-source rows and model outputs, never live provider evidence.
const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Unit film' }],
  diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };
const fixtures: PracticalFixture[] = ['dining', 'attractions'].map((category, i) => ({
  fixtureId: `unit-${i}`, sourceEntityId: `unit-source-${i}`, name: `Synthetic venue ${i}`,
  category: category as 'dining' | 'attractions', cityId: 'athens', coordinates: ATHENS_ORIGIN,
  sourceUrl: 'https://example.invalid/source', sourceRevision: 'unit', retrievedAt: new Date().toISOString(),
  license: 'CC0', verification: 'source-reported',
}));
const output = () => ({ items: fixtures.map((f, i) => ({ fixtureRef: f.fixtureId, category: f.category,
  role: 'primary', order: i + 1, reasonCodes: ['within-radius'] })) });

test('foreign ref, wrong category, arbitrary facts and more than 2 reason codes all reject', () => {
  expect(validateSelections(output(), fixtures, 'baseline')).toHaveLength(2);
  for (const patch of [{ fixtureRef: 'foreign' }, { category: 'attractions' }, { openingHours: '18:00' },
    { reasonCodes: ['within-radius', 'source-category', 'stated-preference'] }, { reasonCodes: ['allergy-safe'] }]) {
    const value = output(); Object.assign(value.items[0], patch);
    expect(validateSelections(value, fixtures, 'baseline')).toBeNull();
  }
  const value = output(); value.items[0].reasonCodes = ['qloo-rank'];
  expect(validateSelections(value, fixtures, 'baseline')).toBeNull();
  expect(validateSelections(value, fixtures, 'treatment', fixtures.map((f, i) => ({ fixtureRef: f.fixtureId,
    category: f.category!, rank: i + 1 })))).toHaveLength(2);
});

test('out-of-radius, unknown coordinates and unresolved opaque exclusions cannot enter whitelist', () => {
  const changed = structuredClone(fixtures);
  changed[0].coordinates = { latitude: 0, longitude: 0 };
  expect(eligibleFixtures(brief, changed)).toHaveLength(1);
  changed[0].coordinates = null;
  expect(eligibleFixtures(brief, changed)).toHaveLength(1);
  const excluding = structuredClone(brief); excluding.constraints.excludedVenueRefs = ['session-opaque-ref'];
  expect(eligibleFixtures(excluding, fixtures)).toBeNull();
  expect(eligibleFixtures(excluding, fixtures, [fixtures[0].fixtureId])).toHaveLength(1);
});

test('paired requests share independent metadata/settings/preferences; baseline has no Qloo ranks or IDs', () => {
  const ranked = fixtures.map((f, i) => ({ fixtureRef: f.fixtureId, category: f.category!, rank: i + 1 }));
  const baseline = buildModelRequest(brief, fixtures, 'baseline');
  const treatment = buildModelRequest(brief, fixtures, 'treatment', ranked);
  expect(baseline.model).toBe(MODEL_SNAPSHOT);
  expect(treatment.model).toBe(baseline.model);
  expect(treatment.max_output_tokens).toBe(baseline.max_output_tokens);
  const a = JSON.parse(baseline.input[1].content);
  const b = JSON.parse(treatment.input[1].content);
  expect(a.pool).toEqual(b.pool); expect(a.preferences).toEqual(b.preferences);
  expect(a.rankedWhitelist).toBeUndefined(); expect(b.rankedWhitelist).toEqual(ranked);
  expect(JSON.stringify(baseline)).not.toContain('qloo-rank');
  expect(JSON.stringify(baseline)).not.toContain('qlooEntityId');
});
