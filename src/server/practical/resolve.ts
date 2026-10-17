import 'server-only';
import type { PracticalFact } from '../../contracts/concierge';
import type { EvidenceRef, InternalCandidate, PracticalFixture, PracticalOption } from '../../contracts/server';
import { isValidCoordinate, distanceMeters } from './geometry';

export const QLOO_FACT_SOURCE_URL = 'https://raw.githubusercontent.com/qloo/docs-public/main/reference/insights-api-deep-dive.md';
export function validCaptureEvidence(evidence: EvidenceRef): boolean {
  return !!evidence && typeof evidence.privateRef === 'string' && !!evidence.privateRef.trim() &&
    typeof evidence.digest === 'string' && !!evidence.digest.trim() &&
    typeof evidence.retrievedAt === 'string' && Number.isFinite(Date.parse(evidence.retrievedAt));
}
export function usableFixture(fixture: PracticalFixture): boolean {
  if (fixture.verification !== 'source-reported' || fixture.cityId !== 'athens' ||
    (fixture.category !== 'dining' && fixture.category !== 'attractions') || !isValidCoordinate(fixture.coordinates) ||
    !fixture.sourceEntityId?.trim() || !fixture.name?.trim() || !fixture.sourceRevision?.trim() ||
    !fixture.retrievedAt || !Number.isFinite(Date.parse(fixture.retrievedAt)) ||
    (fixture.license !== 'CC0' && fixture.license !== 'ODbL-1.0')) return false;
  try { return ['http:', 'https:'].includes(new URL(fixture.sourceUrl).protocol); } catch { return false; }
}
export function fixtureOption(fixture: PracticalFixture): PracticalOption {
  return { fixtureRef: fixture.fixtureId, name: fixture.name, category: fixture.category!, cityId: 'athens',
    coordinates: fixture.coordinates!, practicalFacts: (['city', 'category', 'coordinates'] as const).map(field => ({
      field, source: 'independent', value: field === 'city' ? fixture.cityId : field === 'category' ? fixture.category : fixture.coordinates,
      sourceUrl: fixture.sourceUrl, sourceRevision: fixture.sourceRevision, retrievedAt: fixture.retrievedAt, status: fixture.verification })) };
}
/** Known independent bindings never escape their validation failures through Qloo fallback. */
export function resolvePracticalOption(candidate: InternalCandidate, fixtures: readonly PracticalFixture[], fixtureRef: string): PracticalOption | null {
  if (candidate.fixtureId !== null) {
    const matches = fixtures.filter(f => f.fixtureId === candidate.fixtureId);
    const fixture = matches[0];
    if (matches.length !== 1 || !usableFixture(fixture) || fixture.category !== candidate.category) return null;
    const reported = candidate.qlooReported;
    if (reported && (reported.cityId !== fixture.cityId || reported.category !== fixture.category ||
      !isValidCoordinate(reported.coordinates) || (distanceMeters(reported.coordinates, fixture.coordinates) ?? Infinity) > 100)) return null;
    return { ...fixtureOption(fixture), fixtureRef, name: candidate.name };
  }
  const reported = candidate.qlooReported;
  if (!reported || reported.cityId !== 'athens' || reported.category !== candidate.category ||
    !isValidCoordinate(reported.coordinates) || !validCaptureEvidence(candidate.evidence)) return null;
  const practicalFacts: PracticalFact[] = (['city', 'category', 'coordinates'] as const).map(field => ({
    field, source: 'qloo', value: field === 'city' ? reported.cityId : field === 'category' ? reported.category : reported.coordinates,
    sourceUrl: QLOO_FACT_SOURCE_URL, sourceRevision: null, retrievedAt: candidate.evidence.retrievedAt, status: 'source-reported' }));
  return { fixtureRef, name: candidate.name, category: candidate.category, cityId: 'athens', coordinates: reported.coordinates, practicalFacts };
}
