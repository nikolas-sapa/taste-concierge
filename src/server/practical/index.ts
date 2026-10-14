import 'server-only';
import raw from '../../../data/practical/athens.json';
import type { PracticalFixture } from '../../contracts/server';
import { isValidCoordinate } from './geometry';

const allowedLicenses = new Set(['CC0', 'ODbL-1.0']);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateRecord(value: unknown): value is PracticalFixture {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<PracticalFixture>;
  return typeof r.fixtureId === 'string' && r.fixtureId.trim().length > 0
    && typeof r.sourceEntityId === 'string' && r.sourceEntityId.trim().length > 0
    && typeof r.name === 'string' && r.name.trim().length > 0
    && (r.coordinates === null || isValidCoordinate(r.coordinates))
    && (r.category === 'dining' || r.category === 'attractions' || r.category === null)
    && (r.cityId === 'athens' || r.cityId === null)
    && typeof r.sourceUrl === 'string' && isHttpUrl(r.sourceUrl)
    && (typeof r.sourceRevision === 'string' || r.sourceRevision === null)
    && (typeof r.retrievedAt === 'string' || r.retrievedAt === null)
    && typeof r.license === 'string' && allowedLicenses.has(r.license)
    && (r.verification === 'source-reported' || r.verification === 'unknown' || r.verification === 'conflicting');
}

export function loadPracticalFixtures(): PracticalFixture[] {
  const records: unknown = raw.records;
  if (!Array.isArray(records) || !records.every(validateRecord)) {
    throw new Error('Practical fixture source failed schema validation');
  }
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.fixtureId)) throw new Error('Practical fixture source has duplicate IDs');
    ids.add(record.fixtureId);
  }
  return records;
}

export { ATHENS_ORIGIN } from './origin';
