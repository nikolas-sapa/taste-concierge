import { describe, expect, it } from 'vitest';
import type { Brief, Category, Coordinate } from '../../src/contracts/concierge';
import type { InternalCandidate, PracticalFixture, RecommendationBatch } from '../../src/contracts/server';
import { filterPractical } from '../../src/server/practical/filter';
import { distanceMeters } from '../../src/server/practical/geometry';

const origin: Coordinate = { latitude: 37.98416666666667, longitude: 23.728055555555557 };

function syntheticFixture(
  fixtureId: string,
  category: Category,
  overrides: Partial<PracticalFixture> = {},
): PracticalFixture {
  return {
    fixtureId,
    sourceEntityId: `synthetic-test-${fixtureId}`,
    name: `Synthetic fixture ${fixtureId}`,
    coordinates: origin,
    category,
    cityId: 'athens',
    sourceUrl: 'https://test.invalid/synthetic-fixture',
    sourceRevision: 'test-revision',
    retrievedAt: '2026-10-13T00:00:00Z',
    license: 'CC0',
    verification: 'source-reported',
    ...overrides,
  };
}

function syntheticCandidate(fixtureId: string | null, category: Category): InternalCandidate {
  // Deliberately omit all Qloo identity/evidence: these are predicate-only synthetic unit inputs.
  return { fixtureId, category } as InternalCandidate;
}

function brief(overrides: Partial<Brief['constraints']> = {}): Brief {
  return {
    cityId: 'athens',
    seeds: [{ kind: 'movie', text: 'synthetic test seed' }],
    diningPreference: 'synthetic preference',
    attractionPreference: 'synthetic preference',
    constraints: { radiusMeters: 1_000, excludedVenueRefs: [], ...overrides },
  };
}

function batch(): RecommendationBatch {
  return {
    byCategory: {
      dining: [syntheticCandidate('d1', 'dining')],
      attractions: [syntheticCandidate('a1', 'attractions')],
    },
  };
}

describe('practical constraint filtering with synthetic candidate records', () => {
  it('requires at least one supported candidate in both categories', () => {
    const result = filterPractical(batch(), brief(), [
      syntheticFixture('d1', 'dining'),
      syntheticFixture('a1', 'attractions'),
    ]);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.byCategory.dining).toHaveLength(1);
      expect(result.byCategory.attractions).toHaveLength(1);
    }
  });

  it('rejects a missing category result instead of filling it', () => {
    const result = filterPractical({ byCategory: { dining: [syntheticCandidate('d1', 'dining')], attractions: [] } }, brief(), [
      syntheticFixture('d1', 'dining'),
    ]);
    expect(result).toEqual({ status: 'none', reasons: ['no-category-coverage'] });
  });

  it('accepts a candidate exactly on the configured radius boundary', () => {
    const boundaryPoint = { latitude: origin.latitude, longitude: origin.longitude + 0.005 };
    const boundaryMeters = distanceMeters(origin, boundaryPoint)!;
    const result = filterPractical(batch(), brief({ radiusMeters: boundaryMeters }), [
      syntheticFixture('d1', 'dining', { coordinates: boundaryPoint }),
      syntheticFixture('a1', 'attractions'),
    ]);
    expect(result.status).toBe('valid');
  });

  it('filters unknown, conflicting, foreign-city, and wrong-category source facts', () => {
    const candidates = {
      byCategory: {
        dining: ['unknown', 'conflict', 'foreign', 'wrong'].map((id) => syntheticCandidate(id, 'dining')),
        attractions: [syntheticCandidate('a1', 'attractions')],
      },
    } as RecommendationBatch;
    const result = filterPractical(candidates, brief(), [
      syntheticFixture('unknown', 'dining', { verification: 'unknown' }),
      syntheticFixture('conflict', 'dining', { verification: 'conflicting' }),
      syntheticFixture('foreign', 'dining', { cityId: null }),
      syntheticFixture('wrong', 'attractions'),
      syntheticFixture('a1', 'attractions'),
    ]);
    expect(result.status).toBe('none');
    if (result.status === 'none') expect(result.reasons).toContain('no-practical-match');
  });

  it('rejects fixtures without valid source URL provenance', () => {
    const result = filterPractical(batch(), brief(), [
      syntheticFixture('d1', 'dining', { sourceUrl: 'javascript:alert(1)' }),
      syntheticFixture('a1', 'attractions'),
    ]);
    expect(result).toEqual({ status: 'none', reasons: ['no-practical-match'] });
  });

  it('does not use names or proximity to create a fixture binding', () => {
    const unbound = syntheticCandidate(null, 'dining');
    const result = filterPractical({
      byCategory: { dining: [unbound], attractions: [syntheticCandidate('a1', 'attractions')] },
    }, brief(), [syntheticFixture('d1', 'dining'), syntheticFixture('a1', 'attractions')]);
    expect(result).toEqual({ status: 'none', reasons: ['no-practical-match'] });
  });

  it('enforces straight-line radius and includes an exact-boundary candidate', () => {
    const east = { latitude: origin.latitude, longitude: origin.longitude + 0.008 };
    const result = filterPractical(batch(), brief({ radiusMeters: 500 }), [
      syntheticFixture('d1', 'dining', { coordinates: east }),
      syntheticFixture('a1', 'attractions'),
    ]);
    expect(result.status).toBe('none');
  });

  it('requires the orchestrator to resolve exclusions before filtering', () => {
    const result = filterPractical(batch(), brief({ excludedVenueRefs: ['session-local-ref'] }), [
      syntheticFixture('d1', 'dining'), syntheticFixture('a1', 'attractions'),
    ]);
    expect(result).toEqual({ status: 'none', reasons: ['constraints-unsatisfied'] });
  });

  it('rejects unsupported budget and opening-time constraints', () => {
    expect(filterPractical(batch(), brief({ maxBudgetEur: 20 }), [
      syntheticFixture('d1', 'dining'), syntheticFixture('a1', 'attractions'),
    ])).toEqual({ status: 'none', reasons: ['unsupported-constraint:maxBudgetEur'] });
    expect(filterPractical(batch(), brief({ localOpeningTime: '18:00' }), [
      syntheticFixture('d1', 'dining'), syntheticFixture('a1', 'attractions'),
    ])).toEqual({ status: 'none', reasons: ['unsupported-constraint:localOpeningTime'] });
  });

  it('rejects invalid radii and unknown candidate coordinates', () => {
    expect(filterPractical(batch(), brief({ radiusMeters: -1 }), [
      syntheticFixture('d1', 'dining'), syntheticFixture('a1', 'attractions'),
    ])).toEqual({ status: 'none', reasons: ['invalid-radius'] });
    expect(filterPractical(batch(), brief(), [
      syntheticFixture('d1', 'dining', { coordinates: null }), syntheticFixture('a1', 'attractions'),
    ])).toEqual({ status: 'none', reasons: ['no-practical-match'] });
  });
});
