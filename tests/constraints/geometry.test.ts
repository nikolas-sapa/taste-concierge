import { describe, expect, it } from 'vitest';
import { distanceMeters, isValidCoordinate } from '../../src/server/practical/geometry';

describe('pure geometry with synthetic test points', () => {
  it('returns zero for identical points', () => {
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
  });

  it('computes finite straight-line distance for known coordinates', () => {
    const meters = distanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    );
    expect(meters).toBeCloseTo(111_194.9, 0);
  });

  it('rejects non-finite and out-of-range coordinates', () => {
    expect(isValidCoordinate({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 0, longitude: 181 })).toBe(false);
    expect(distanceMeters(null, { latitude: 0, longitude: 0 })).toBeNull();
  });
});
