import { describe, expect, test } from 'vitest';
import { validateBrief } from '../../src/server/input/validate';
const valid = () => ({ cityId: 'athens', seeds: [{ kind: 'movie', text: 'Spirited Away' }], diningPreference: 'casual', attractionPreference: 'museums', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } });
describe('brief validation, before upstream use', () => {
  test('one valid seed normalizes surrounding whitespace', () => {
    const input = valid(); input.seeds[0].text = ' Spirited Away ';
    expect(validateBrief(input)).toEqual({ ok: true, brief: valid() });
  });
  test.each([null, [], 4, 'brief'])('rejects non-object %j', input => expect(validateBrief(input).ok).toBe(false));
  test('rejects four seeds', () => expect(validateBrief({ ...valid(), seeds: Array(4).fill(valid().seeds[0]) }).ok).toBe(false));
  test('rejects zero seeds', () => expect(validateBrief({ ...valid(), seeds: [] }).ok).toBe(false));
  test('rejects 121 Unicode characters, accepts 120', () => {
    expect(validateBrief({ ...valid(), seeds: [{ kind: 'movie', text: '🎬'.repeat(120) }] }).ok).toBe(true);
    expect(validateBrief({ ...valid(), seeds: [{ kind: 'movie', text: '🎬'.repeat(121) }] }).ok).toBe(false);
  });
  test.each([-1, 5001, NaN, Infinity, '3000'])('rejects illegal radius %j', radiusMeters => expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, radiusMeters } }).ok).toBe(false));
  test('rejects foreign enums and unknown keys', () => {
    expect(validateBrief({ ...valid(), cityId: 'paris' }).ok).toBe(false);
    expect(validateBrief({ ...valid(), seeds: [{ kind: 'person', text: 'name' }] }).ok).toBe(false);
    expect(validateBrief({ ...valid(), apiKey: 'not a supported field' }).ok).toBe(false);
  });
  test('rejects 121-character preferences', () => expect(validateBrief({ ...valid(), diningPreference: 'x'.repeat(121) }).ok).toBe(false));
  test('caps exclusions at 20 and rejects malformed references', () => {
    expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, excludedVenueRefs: Array(21).fill('a'.repeat(32)) } }).ok).toBe(false);
    expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, excludedVenueRefs: ['../secret'] } }).ok).toBe(false);
  });
  test('valid unsupported budget/time survives parsing for truthful result', () => expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, maxBudgetEur: 20, localOpeningTime: '19:00' } }).ok).toBe(true));
  test.each([-1, NaN, Infinity, '20'])('rejects illegal budget %j', maxBudgetEur => expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, maxBudgetEur } }).ok).toBe(false));
  test('rejects malformed time', () => expect(validateBrief({ ...valid(), constraints: { ...valid().constraints, localOpeningTime: '25:61' } }).ok).toBe(false));
  test('object seed kind from valid JSON rejects without coercion crash', () => {
    expect(validateBrief({ ...valid(), seeds: [{ kind: { toString: null }, text: 'a' }] }).ok).toBe(false);
  });
});
