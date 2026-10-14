import 'server-only';
import reference from '../../../data/practical/athens-reference.json';
import type { Coordinate } from '../../contracts/concierge';
import { isValidCoordinate } from './geometry';

const value: unknown = reference.coordinate;
export const ATHENS_ORIGIN: Coordinate | null = isValidCoordinate(value) ? value : null;
