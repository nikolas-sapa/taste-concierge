import 'server-only';
import type { SessionState } from '../../contracts/server';
import { validCaptureEvidence, QLOO_FACT_SOURCE_URL } from '../practical/resolve';
import { isRecord, isRevision, validateBrief } from '../input/validate';

export const SESSION_ENVELOPE_MAX_BYTES = 262_144;
export class SessionCodecError extends Error {
  constructor() { super('Invalid persisted session'); this.name = 'SessionCodecError'; }
}
const fail = (): never => { throw new SessionCodecError(); };
const text = (v: unknown): v is string => typeof v === 'string';
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));
const category = (v: unknown) => v === 'dining' || v === 'attractions';
const kind = (v: unknown) => v === 'movie' || v === 'artist' || v === 'place';
const stringArray = (v: unknown) => Array.isArray(v) && v.every(text);
function evidence(v: unknown): boolean {
  return isRecord(v) && keys(v, ['privateRef', 'digest', 'retrievedAt']) &&
    text(v.privateRef) && text(v.digest) && text(v.retrievedAt);
}
function seed(v: unknown): boolean {
  return isRecord(v) && keys(v, ['seedIndex', 'kind', 'qlooEntityId', 'name', 'evidence']) &&
    Number.isInteger(v.seedIndex) && Number(v.seedIndex) >= 0 && Number(v.seedIndex) <= 2 &&
    kind(v.kind) && text(v.qlooEntityId) && text(v.name) && evidence(v.evidence);
}
function candidate(v: unknown, version: number): boolean {
  return isRecord(v) && Object.keys(v).every(k => ['qlooEntityId', 'name', 'category', 'evidence', 'fixtureId', 'qlooRank', ...(version === 2 ? ['qlooReported'] : [])].includes(k)) &&
    text(v.qlooEntityId) && text(v.name) && category(v.category) && evidence(v.evidence) &&
    (v.fixtureId === null || text(v.fixtureId)) &&
    (!Object.hasOwn(v, 'qlooRank') || (Number.isSafeInteger(v.qlooRank) && Number(v.qlooRank) >= 1 && Number(v.qlooRank) <= 500)) &&
    (!Object.hasOwn(v, 'qlooReported') || (isRecord(v.qlooReported) && keys(v.qlooReported, ['cityId', 'category', 'coordinates']) &&
      v.qlooReported.cityId === 'athens' && v.qlooReported.category === v.category && coordinate(v.qlooReported.coordinates) &&
      validCaptureEvidence(v.evidence as Parameters<typeof validCaptureEvidence>[0])));
}
function coordinate(v: unknown): boolean {
  return isRecord(v) && keys(v, ['latitude', 'longitude']) &&
    typeof v.latitude === 'number' && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90 &&
    typeof v.longitude === 'number' && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180;
}
function independentProvenance(f: Record<string, unknown>): boolean {
  if (f.status !== 'source-reported') return true;
  if (typeof f.sourceRevision !== 'string' || !f.sourceRevision.trim() || typeof f.retrievedAt !== 'string' ||
    !Number.isFinite(Date.parse(f.retrievedAt)) || typeof f.sourceUrl !== 'string' || f.sourceUrl === QLOO_FACT_SOURCE_URL) return false;
  try { return ['https:', 'http:'].includes(new URL(f.sourceUrl).protocol); } catch { return false; }
}
function card(v: unknown, version: number): boolean {
  return isRecord(v) && keys(v, ['ref', 'name', 'category', 'source', 'interpretation', 'practicalFacts', 'limitations', 'retrievedAt']) &&
    text(v.ref) && text(v.name) && category(v.category) && ['qloo', 'generic-llm'].includes(String(v.source)) &&
    text(v.interpretation) && stringArray(v.limitations) && text(v.retrievedAt) && Array.isArray(v.practicalFacts) &&
    v.practicalFacts.length === 3 && new Set(v.practicalFacts.map(f => isRecord(f) ? f.field : null)).size === 3 &&
    v.practicalFacts.every(f => isRecord(f) && keys(f, ['field', 'value', 'sourceUrl', 'sourceRevision', 'retrievedAt', 'status', ...(version === 2 ? ['source'] : [])]) &&
      ['city', 'category', 'coordinates'].includes(String(f.field)) &&
      (f.value === null || (f.field === 'coordinates' ? coordinate(f.value) : text(f.value))) &&
      [f.sourceUrl, f.sourceRevision, f.retrievedAt].every(x => x === null || text(x)) &&
      ['source-reported', 'unknown', 'conflicting'].includes(String(f.status)) &&
      (version === 1 ? independentProvenance(f) : (['independent', 'qloo'].includes(String(f.source)) &&
        (f.source !== 'independent' || independentProvenance(f)) &&
        (f.source !== 'qloo' || (v.source === 'qloo' && f.status === 'source-reported' && f.sourceRevision === null &&
          f.sourceUrl === QLOO_FACT_SOURCE_URL && typeof f.retrievedAt === 'string' && Number.isFinite(Date.parse(f.retrievedAt)) &&
          (f.field === 'city' ? f.value === 'athens' : f.field === 'category' ? f.value === v.category : coordinate(f.value)))))));
}
function result(v: unknown, version: number): boolean {
  if (!isRecord(v) || !isRevision(v.revision)) return false;
  switch (v.state) {
    case 'needs-disambiguation':
      return keys(v, ['state', 'revision', 'unresolved']) && Array.isArray(v.unresolved) && v.unresolved.every(u =>
        isRecord(u) && keys(u, ['seedIndex', 'options']) && Number.isInteger(u.seedIndex) &&
        Number(u.seedIndex) >= 0 && Number(u.seedIndex) <= 2 && Array.isArray(u.options) && u.options.every(o =>
          isRecord(o) && keys(o, ['ref', 'name', 'kind', 'disambiguation']) && text(o.ref) && text(o.name) &&
          kind(o.kind) && (o.disambiguation === null || text(o.disambiguation))));
    case 'ready': {
      if (!keys(v, ['state', 'revision', 'items', 'baseline']) || !isRecord(v.items) ||
        !keys(v.items, ['dining', 'attractions']) || !isRecord(v.baseline)) return false;
      const b = v.baseline;
      return Object.entries(v.items).every(([key, i]) => isRecord(i) && keys(i, ['primary', 'alternative']) &&
        card(i.primary, version) && isRecord(i.primary) && i.primary.category === key &&
        (i.alternative === null || (card(i.alternative, version) && isRecord(i.alternative) && i.alternative.category === key))) &&
        ((b.status === 'ready' && keys(b, ['status', 'model', 'items']) && text(b.model) && Array.isArray(b.items) && b.items.every(item => card(item, version) && isRecord(item) && item.source === 'generic-llm' &&
          (version === 1 || (Array.isArray(item.practicalFacts) && item.practicalFacts.every(f => isRecord(f) && f.source === 'independent'))))) ||
          (b.status === 'unavailable' && keys(b, ['status', 'reason']) && ['model-unavailable', 'invalid-output'].includes(String(b.reason))));
    }
    case 'no-valid-result':
      return keys(v, ['state', 'revision', 'reasons']) && Array.isArray(v.reasons) && v.reasons.every(r =>
        ['no-entity-match', 'no-category-coverage', 'no-practical-match', 'constraints-unsatisfied'].includes(String(r)));
    case 'unsupported-constraint':
      return keys(v, ['state', 'revision', 'fields']) && Array.isArray(v.fields) && v.fields.every(f => ['maxBudgetEur', 'localOpeningTime'].includes(String(f)));
    case 'service-unavailable':
      return keys(v, ['state', 'revision', 'reason', 'retryable']) && typeof v.retryable === 'boolean' &&
        ['configuration', 'authentication', 'timeout', 'rate-limit', 'upstream', 'network'].includes(String(v.reason));
    case 'invalid-input': return keys(v, ['state', 'revision', 'fields']) && stringArray(v.fields);
    default: return false;
  }
}
function entries(v: unknown, validate: (value: unknown) => boolean): v is [string, unknown][] {
  return Array.isArray(v) && v.every(e => Array.isArray(e) && e.length === 2 && text(e[0]) && validate(e[1])) &&
    new Set(v.map(e => e[0])).size === v.length;
}
export function decodeSessionEnvelope(input: unknown): SessionState {
  let envelope: unknown;
  try {
    const serialized = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > SESSION_ENVELOPE_MAX_BYTES) return fail();
    envelope = JSON.parse(serialized) as unknown;
  } catch { return fail(); }
  if (!isRecord(envelope) || !keys(envelope, ['version', 'state']) || (envelope.version !== 1 && envelope.version !== 2) || !isRecord(envelope.state)) return fail();
  const s = envelope.state;
  if (!keys(s, ['revision', 'brief', 'resolved', 'pending', 'venues', 'result', 'expiresAt', 'operationFence']) ||
    !isRevision(s.revision) || !(s.brief === null || validateBrief(s.brief).ok) ||
    !(s.resolved === null || (isRecord(s.resolved) && keys(s.resolved, ['entities']) && Array.isArray(s.resolved.entities) && s.resolved.entities.every(seed))) ||
    !entries(s.pending, p => isRecord(p) && keys(p, ['seedIndex', 'seed']) && Number.isInteger(p.seedIndex) &&
      Number(p.seedIndex) >= 0 && Number(p.seedIndex) <= 2 && seed(p.seed)) || !entries(s.venues, value => candidate(value, Number(envelope.version))) ||
    !(s.result === null || result(s.result, Number(envelope.version))) || typeof s.expiresAt !== 'number' || !Number.isFinite(s.expiresAt) || s.expiresAt <= 0 ||
    !(s.operationFence === null || (text(s.operationFence) && /^[a-f0-9]{64}$/.test(s.operationFence)))) return fail();
  if (envelope.version === 1 && isRecord(s.result) && s.result.state === 'ready' && isRecord(s.result.items)) {
    // Explicit legacy migration: old cards only represented independent fixtures.
    const cards: unknown[] = Object.values(s.result.items).flatMap(item => isRecord(item) ? [item.primary, item.alternative] : []);
    if (isRecord(s.result.baseline) && Array.isArray(s.result.baseline.items)) cards.push(...s.result.baseline.items);
    for (const item of cards) if (isRecord(item) && Array.isArray(item.practicalFacts)) {
      for (const fact of item.practicalFacts) if (isRecord(fact)) fact.source = 'independent';
    }
  }
  return { ...s, pending: new Map(s.pending), venues: new Map(s.venues) } as SessionState;
}
export function encodeSessionEnvelope(state: SessionState): string {
  if (!(state.pending instanceof Map) || !(state.venues instanceof Map)) return fail();
  let encoded: string;
  try { encoded = JSON.stringify({ version: 2, state: { ...state, pending: [...state.pending], venues: [...state.venues] } }); }
  catch { return fail(); }
  decodeSessionEnvelope(encoded);
  return encoded;
}
