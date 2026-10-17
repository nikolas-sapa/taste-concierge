import { expect, test } from 'vitest';
import { normalizeRecommendations, normalizeSearch } from '../../../src/server/qloo/normalize';

// Entrant-authored synthetic unit payloads. Never live Qloo evidence or acceptance proof.
const evidence = { privateRef: 'unit', digest: 'unit', retrievedAt: '2026-10-17T00:00:00Z' };
test('observed envelopes normalize separately; wrong type/tag/coordinates excluded', () => {
  expect(normalizeSearch({ results: [{ entity_id: 'unit', name: 'Unit seed', types: ['urn:entity:movie'] }] },
    'movie', 0, evidence)).toHaveLength(1);
  expect(() => normalizeSearch({ results: { entities: [] } }, 'movie', 0, evidence)).toThrow();
  const row = { entity_id: 'unit', name: 'Unit venue', subtype: 'urn:entity:place',
    tags: [{ id: 'unit-tag' }], location: { lat: 0, lon: 0 },
    properties: { geocode: { country_code: 'GR', city: 'Unit city' } } };
  const config = { categoryTagIds: { dining: 'unit-tag', attractions: 'unit-museum' },
    origin: { latitude: 0, longitude: 0 }, athensCityNames: ['Unit city'] };
  const normalized = normalizeRecommendations({ results: { entities: [row] } }, 'dining', 3000, config, evidence, []);
  expect(normalized).toHaveLength(1);
  expect(normalized[0].fixtureId).toBeNull();
  expect(normalizeRecommendations({ results: { entities: [{ ...row, location: { lat: 91, lon: 0 } }] } },
    'dining', 3000, config, evidence, [])).toHaveLength(0);
  expect(normalizeRecommendations({ results: { entities: [{ ...row, tags: [] }] } },
    'dining', 3000, config, evidence, [])).toHaveLength(0);
});
