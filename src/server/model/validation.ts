import 'server-only';
import type { Brief, Category } from '../../contracts/concierge';
import type { ModelSelection, PracticalFixture } from '../../contracts/server';
import { ATHENS_ORIGIN } from '../practical/origin';
import { distanceMeters, isValidCoordinate } from '../practical/geometry';
import { COMMON_REASONS, TREATMENT_REASONS } from './constants';

export type RankedFixture = { fixtureRef: string; category: Category; rank: number };
export type ModelArm = 'baseline' | 'treatment';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));

export function eligibleFixtures(brief: Brief, fixtures: readonly PracticalFixture[],
  excludedFixtureIds?: readonly string[]): PracticalFixture[] | null {
  if (brief.cityId !== 'athens' || !ATHENS_ORIGIN || !Number.isFinite(brief.constraints.radiusMeters) ||
    brief.constraints.radiusMeters < 0 || brief.constraints.radiusMeters > 5000 ||
    brief.constraints.maxBudgetEur !== undefined || brief.constraints.localOpeningTime !== undefined ||
    fixtures.length > 500) return null;
  const exclusions = excludedFixtureIds ?? [];
  if (exclusions.length !== brief.constraints.excludedVenueRefs.length || exclusions.some(id => !fixtures.some(f => f.fixtureId === id))) return null;
  const ids = new Map<string, number>();
  for (const fixture of fixtures) ids.set(fixture.fixtureId, (ids.get(fixture.fixtureId) ?? 0) + 1);
  return fixtures.filter(fixture => {
    if (ids.get(fixture.fixtureId) !== 1 || exclusions.includes(fixture.fixtureId) || fixture.cityId !== 'athens' ||
      (fixture.category !== 'dining' && fixture.category !== 'attractions') || fixture.verification !== 'source-reported' ||
      !isValidCoordinate(fixture.coordinates) || !fixture.sourceEntityId || !fixture.sourceRevision || !fixture.name ||
      !fixture.retrievedAt || !Number.isFinite(Date.parse(fixture.retrievedAt)) ||
      (fixture.license !== 'CC0' && fixture.license !== 'ODbL-1.0')) return false;
    try { if (!['http:', 'https:'].includes(new URL(fixture.sourceUrl).protocol)) return false; } catch { return false; }
    const distance = distanceMeters(ATHENS_ORIGIN, fixture.coordinates);
    return distance !== null && distance <= brief.constraints.radiusMeters;
  });
}

export function validRanks(ranked: readonly RankedFixture[], pool: readonly PracticalFixture[]): boolean {
  if (ranked.length > 500 || new Set(ranked.map(r => r.fixtureRef)).size !== ranked.length) return false;
  return ranked.every(r => Number.isSafeInteger(r.rank) && r.rank > 0 && r.rank <= 500 &&
    pool.some(f => f.fixtureId === r.fixtureRef && f.category === r.category)) &&
    (['dining', 'attractions'] as Category[]).every(category => {
      const ranks = ranked.filter(r => r.category === category);
      return ranks.length > 0 && new Set(ranks.map(r => r.rank)).size === ranks.length;
    });
}

export function validateSelections(value: unknown, pool: readonly PracticalFixture[], arm: ModelArm,
  ranked: readonly RankedFixture[] = []): ModelSelection[] | null {
  if (!object(value) || !keys(value, ['items']) || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > 4) return null;
  if (arm === 'treatment' && !validRanks(ranked, pool)) return null;
  const allowedReasons: readonly string[] = arm === 'baseline' ? COMMON_REASONS : TREATMENT_REASONS;
  const result: ModelSelection[] = [];
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['fixtureRef', 'category', 'role', 'order', 'reasonCodes']) ||
      typeof item.fixtureRef !== 'string' || (item.category !== 'dining' && item.category !== 'attractions') ||
      (item.role !== 'primary' && item.role !== 'alternative') || !Number.isInteger(item.order) ||
      (item.order as number) < 1 || (item.order as number) > 4 || !Array.isArray(item.reasonCodes) ||
      item.reasonCodes.length > 2 || !item.reasonCodes.every(r => typeof r === 'string' && allowedReasons.includes(r)) ||
      new Set(item.reasonCodes).size !== item.reasonCodes.length ||
      !pool.some(f => f.fixtureId === item.fixtureRef && f.category === item.category) ||
      (arm === 'treatment' && !ranked.some(r => r.fixtureRef === item.fixtureRef && r.category === item.category))) return null;
    result.push(item as unknown as ModelSelection);
  }
  if (new Set(result.map(r => r.fixtureRef)).size !== result.length ||
    new Set(result.map(r => r.order)).size !== result.length || result.some(r => r.order > result.length)) return null;
  for (const category of ['dining', 'attractions'] as Category[]) {
    const primary = result.filter(r => r.category === category && r.role === 'primary');
    const alternatives = result.filter(r => r.category === category && r.role === 'alternative');
    if (primary.length !== 1 || alternatives.length > 1) return null;
  }
  return result.sort((a, b) => a.order - b.order);
}
