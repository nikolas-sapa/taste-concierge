import 'server-only';
import type { Brief, Category } from '../../contracts/concierge';
import type {
  ConstraintDecision,
  InternalCandidate,
  PracticalFixture,
  RecommendationBatch,
} from '../../contracts/server';
import { ATHENS_ORIGIN } from './origin';
import { distanceMeters } from './geometry';
import { resolvePracticalOption } from './resolve';

const CATEGORIES: Category[] = ['dining', 'attractions'];

function none(...reasons: string[]): ConstraintDecision {
  return { status: 'none', reasons };
}

/**
 * Filter private Qloo candidates through source-labeled practical facts.
 * Known independent identities require exact fixtureId linkage; unbound records require complete Qloo facts.
 * Names and proximity never create identity bindings.
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
      if (candidate.category !== category) continue;
      const option = resolvePracticalOption(candidate, fixtures, 'predicate-only');
      if (!option) continue;
      const distance = distanceMeters(ATHENS_ORIGIN, option.coordinates);
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
