import 'server-only';
import type { Brief, Category } from '../../contracts/concierge';
import type {
  ConstraintDecision,
  InternalCandidate,
  PracticalFixture,
  RecommendationBatch,
} from '../../contracts/server';
import { ATHENS_ORIGIN } from './origin';
import { distanceMeters, isValidCoordinate } from './geometry';

const CATEGORIES: Category[] = ['dining', 'attractions'];

function none(...reasons: string[]): ConstraintDecision {
  return { status: 'none', reasons };
}

function isHttpSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasSourceProvenance(fixture: PracticalFixture): boolean {
  if (typeof fixture.sourceEntityId !== 'string' || !fixture.sourceEntityId.trim()) return false;
  if (typeof fixture.name !== 'string' || !fixture.name.trim()) return false;
  if (typeof fixture.sourceUrl !== 'string' || !isHttpSourceUrl(fixture.sourceUrl)) return false;
  if (typeof fixture.sourceRevision !== 'string' || !fixture.sourceRevision.trim()) return false;
  if (typeof fixture.retrievedAt !== 'string' || !fixture.retrievedAt.trim()) return false;
  if (!Number.isFinite(Date.parse(fixture.retrievedAt))) return false;
  if (fixture.license !== 'CC0' && fixture.license !== 'ODbL-1.0') return false;
  return true;
}

function isUsableFixture(fixture: PracticalFixture, category: Category): boolean {
  return fixture.verification === 'source-reported'
    && fixture.cityId === 'athens'
    && fixture.category === category
    && isValidCoordinate(fixture.coordinates)
    && hasSourceProvenance(fixture);
}

/**
 * Filter private Qloo candidates through independent practical-source facts.
 * Candidate identity is admitted only by exact fixtureId linkage; names and proximity never bind.
 * Exclusions must be resolved against session state by the orchestrator before this pure function.
 */
export function filterPractical(
  batch: RecommendationBatch,
  brief: Brief,
  fixtures: PracticalFixture[],
): ConstraintDecision {
  const { radiusMeters, excludedVenueRefs } = brief.constraints;
  if (brief.cityId !== 'athens') return none('unsupported-city');
  if (brief.constraints.maxBudgetEur !== undefined) {
    return none('unsupported-constraint:maxBudgetEur');
  }
  if (brief.constraints.localOpeningTime !== undefined) {
    return none('unsupported-constraint:localOpeningTime');
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0 || radiusMeters > 5_000) {
    return none('invalid-radius');
  }
  if (excludedVenueRefs.length > 0) {
    return none('constraints-unsatisfied');
  }
  if (!ATHENS_ORIGIN) return none('missing-origin');

  const byFixtureId = new Map<string, PracticalFixture>();
  const duplicateIds = new Set<string>();
  for (const fixture of fixtures) {
    if (byFixtureId.has(fixture.fixtureId)) duplicateIds.add(fixture.fixtureId);
    else byFixtureId.set(fixture.fixtureId, fixture);
  }
  for (const duplicate of duplicateIds) byFixtureId.delete(duplicate);

  const filtered = {} as Record<Category, InternalCandidate[]>;
  const missingCategory: Category[] = [];
  const noPracticalMatch: Category[] = [];

  for (const category of CATEGORIES) {
    const candidates = batch.byCategory?.[category] ?? [];
    if (candidates.length === 0) {
      missingCategory.push(category);
      filtered[category] = [];
      continue;
    }

    const kept: InternalCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.category !== category || typeof candidate.fixtureId !== 'string') continue;
      const fixture = byFixtureId.get(candidate.fixtureId);
      if (!fixture || !isUsableFixture(fixture, category)) continue;
      const distance = distanceMeters(ATHENS_ORIGIN, fixture.coordinates);
      if (distance === null || distance > radiusMeters) continue;
      kept.push(candidate);
    }
    filtered[category] = kept;
    if (kept.length === 0) noPracticalMatch.push(category);
  }

  if (missingCategory.length > 0) return none('no-category-coverage');
  if (noPracticalMatch.length > 0) return none('no-practical-match');
  return { status: 'valid', byCategory: filtered };
}
