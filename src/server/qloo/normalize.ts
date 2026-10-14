import 'server-only';
import type { Category, SeedKind } from '../../contracts/concierge';
import type { EvidenceRef, InternalCandidate, ResolvedSeed } from '../../contracts/server';
import type { PayloadPolicy } from '../admission/ledger';
import { QlooError } from './errors';

export type FixtureBinding = { qlooEntityId: string; fixtureId: string; verified: true; evidenceRef: string };
export type SearchCandidate = ResolvedSeed & { disambiguation: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1000;
const normalizeName = (v: string) => v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const seedType = (kind: SeedKind) => `urn:entity:${kind}`;

export function normalizeSearch(payload: unknown, kind: SeedKind, seedIndex: number, evidence: EvidenceRef): SearchCandidate[] {
  if (!record(payload) || !Array.isArray(payload.results)) throw new QlooError('upstream');
  const result: SearchCandidate[] = [];
  for (const row of payload.results) {
    if (!record(row) || !text(row.entity_id) || !text(row.name) || !Array.isArray(row.types) ||
      !row.types.includes(seedType(kind))) continue;
    const properties = record(row.properties) ? row.properties : {};
    const context = [row.disambiguation, properties.short_description, properties.description]
      .find(v => typeof v === 'string' && v.trim().length > 0);
    result.push({ seedIndex, kind, qlooEntityId: row.entity_id, name: row.name, evidence,
      disambiguation: typeof context === 'string' ? context.slice(0, 240) : null });
  }
  return [...new Map(result.map(r => [r.qlooEntityId, r])).values()];
}

export function preferExactCandidates(options: SearchCandidate[], query: string): SearchCandidate[] {
  const exact = options.filter(o => normalizeName(o.name) === normalizeName(query));
  return exact.length ? exact : options;
}

function distance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * r / 2) ** 2 +
    Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin((b.longitude - a.longitude) * r / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function normalizeRecommendations(payload: unknown, category: Category, radiusMeters: number,
  config: PayloadPolicy, evidence: EvidenceRef, bindings: readonly FixtureBinding[]): InternalCandidate[] {
  if (!record(payload) || !record(payload.results) || !Array.isArray(payload.results.entities)) throw new QlooError('upstream');
  const result: InternalCandidate[] = [];
  for (const row of payload.results.entities) {
    if (!record(row) || !text(row.entity_id) || !text(row.name) || row.subtype !== 'urn:entity:place' ||
      !Array.isArray(row.tags) || !row.tags.some(t => record(t) && t.id === config.categoryTagIds[category]) ||
      !record(row.location) || typeof row.location.lat !== 'number' || !Number.isFinite(row.location.lat) ||
      Math.abs(row.location.lat) > 90 || typeof row.location.lon !== 'number' || !Number.isFinite(row.location.lon) ||
      Math.abs(row.location.lon) > 180 || !record(row.properties) || !record(row.properties.geocode) ||
      row.properties.geocode.country_code !== 'GR') continue;
    const locality = record(row.properties.locality) ? row.properties.locality : {};
    const localityCity = record(locality.city) ? locality.city.name : undefined;
    const cityMatches = [row.properties.geocode.city, row.properties.geocode.name, localityCity]
      .some(v => typeof v === 'string' && config.athensCityNames.some(name => normalizeName(name) === normalizeName(v)));
    if (!cityMatches || distance(config.origin, { latitude: row.location.lat, longitude: row.location.lon }) > radiusMeters) continue;
    const matches = bindings.filter(b => b.verified === true && b.evidenceRef.length > 0 && b.qlooEntityId === row.entity_id);
    result.push({ qlooEntityId: row.entity_id, name: row.name, category, evidence,
      fixtureId: matches.length === 1 ? matches[0].fixtureId : null });
  }
  return [...new Map(result.map(r => [r.qlooEntityId, r])).values()];
}
