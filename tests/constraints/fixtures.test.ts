import { describe, expect, it } from 'vitest';
import { loadPracticalFixtures } from '../../src/server/practical';

describe('independent practical fixture source', () => {
  it('loads only the 20 declared Wikidata records with provenance', () => {
    const fixtures = loadPracticalFixtures();
    expect(fixtures).toHaveLength(20);
    expect(fixtures.filter((fixture) => fixture.category === 'dining')).toHaveLength(4);
    expect(fixtures.filter((fixture) => fixture.category === 'attractions')).toHaveLength(16);
    expect(fixtures.every((fixture) => fixture.license === 'CC0')).toBe(true);
    expect(fixtures.every((fixture) => fixture.sourceUrl.includes('wikidata.org'))).toBe(true);
    expect(fixtures.every((fixture) => fixture.sourceRevision && fixture.retrievedAt)).toBe(true);
  });

  it('keeps the conflicting National Museum coordinate unknown', () => {
    const fixture = loadPracticalFixtures().find((entry) => entry.sourceEntityId === 'Q3038298');
    expect(fixture?.coordinates).toBeNull();
    expect(fixture?.verification).toBe('source-reported');
  });

  it('contains no Qloo linkage or response fields', () => {
    const keys = loadPracticalFixtures().flatMap((fixture) => Object.keys(fixture));
    expect(keys.some((key) => ['qlooentityid', 'payload', 'response', 'digest', 'privateRef'].includes(key))).toBe(false);
  });
});
