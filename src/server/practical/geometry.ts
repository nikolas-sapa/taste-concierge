import type { Coordinate } from '../../contracts/concierge';

const EARTH_RADIUS_METERS = 6_371_000;

export function isValidCoordinate(value: unknown): value is Coordinate {
  if (typeof value !== 'object' || value === null) return false;
  const coordinate = value as Partial<Coordinate>;
  return Number.isFinite(coordinate.latitude)
    && Number.isFinite(coordinate.longitude)
    && (coordinate.latitude as number) >= -90
    && (coordinate.latitude as number) <= 90
    && (coordinate.longitude as number) >= -180
    && (coordinate.longitude as number) <= 180;
}

export function distanceMeters(a: Coordinate | null, b: Coordinate | null): number | null {
  if (!isValidCoordinate(a) || !isValidCoordinate(b)) return null;

  const toRadians = (degrees: number) => degrees * (Math.PI / 180);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, haversine));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
}
