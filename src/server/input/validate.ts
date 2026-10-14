import type { Brief, Selection } from '../../contracts/concierge';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function isReference(value: unknown): value is string {
  return typeof value === 'string' && /^[-_A-Za-z0-9]{16,128}$/.test(value);
}

function text(value: unknown, required: boolean): value is string {
  return typeof value === 'string' && (!required || value.trim().length > 0)
    && [...value.trim()].length <= 120;
}

export function validateBrief(input: unknown): { ok: true; brief: Brief } | { ok: false; fields: string[] } {
  if (!isRecord(input)) return { ok: false, fields: ['brief'] };
  const fields: string[] = [];
  if (!hasOnlyKeys(input, ['cityId', 'seeds', 'diningPreference', 'attractionPreference', 'constraints'])) fields.push('brief');
  if (input.cityId !== 'athens') fields.push('cityId');
  if (!Array.isArray(input.seeds) || input.seeds.length < 1 || input.seeds.length > 3
    || input.seeds.some(seed => !isRecord(seed) || !hasOnlyKeys(seed, ['kind', 'text'])
      || typeof seed.kind !== 'string' || !['movie', 'artist', 'place'].includes(seed.kind) || !text(seed.text, true))) fields.push('seeds');
  for (const key of ['diningPreference', 'attractionPreference']) {
    if (!text(input[key], false)) fields.push(key);
  }
  const constraints = input.constraints;
  if (!isRecord(constraints)) fields.push('constraints');
  else {
    if (!hasOnlyKeys(constraints, ['radiusMeters', 'excludedVenueRefs', 'maxBudgetEur', 'localOpeningTime'])) fields.push('constraints');
    if (typeof constraints.radiusMeters !== 'number' || !Number.isFinite(constraints.radiusMeters)
      || constraints.radiusMeters < 0 || constraints.radiusMeters > 5000) fields.push('constraints.radiusMeters');
    if (!Array.isArray(constraints.excludedVenueRefs) || constraints.excludedVenueRefs.length > 20
      || constraints.excludedVenueRefs.some(ref => !isReference(ref))
      || new Set(constraints.excludedVenueRefs).size !== constraints.excludedVenueRefs.length) fields.push('constraints.excludedVenueRefs');
    if ('maxBudgetEur' in constraints && (typeof constraints.maxBudgetEur !== 'number'
      || !Number.isFinite(constraints.maxBudgetEur) || constraints.maxBudgetEur < 0)) fields.push('constraints.maxBudgetEur');
    if ('localOpeningTime' in constraints && (typeof constraints.localOpeningTime !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(constraints.localOpeningTime))) fields.push('constraints.localOpeningTime');
  }
  if (fields.length) return { ok: false, fields };
  // The predicates above establish this input shape; reconstruct to exclude inherited fields.
  const checked = input as unknown as Brief;
  return { ok: true, brief: {
    cityId: 'athens', seeds: checked.seeds.map(seed => ({ kind: seed.kind, text: seed.text.trim() })),
    diningPreference: checked.diningPreference.trim(), attractionPreference: checked.attractionPreference.trim(),
    constraints: { radiusMeters: checked.constraints.radiusMeters, excludedVenueRefs: [...checked.constraints.excludedVenueRefs],
      ...('maxBudgetEur' in checked.constraints ? { maxBudgetEur: checked.constraints.maxBudgetEur } : {}),
      ...('localOpeningTime' in checked.constraints ? { localOpeningTime: checked.constraints.localOpeningTime } : {}) },
  } };
}

export function validateSelections(input: unknown): input is Selection[] {
  return Array.isArray(input) && input.length >= 1 && input.length <= 3
    && input.every(item => isRecord(item) && hasOnlyKeys(item, ['seedIndex', 'candidateRef'])
      && Number.isInteger(item.seedIndex) && Number(item.seedIndex) >= 0 && Number(item.seedIndex) <= 2
      && isReference(item.candidateRef))
    && new Set(input.map(item => (item as Selection).seedIndex)).size === input.length;
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
