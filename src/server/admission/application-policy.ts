import 'server-only';
import { validatePolicy, type PayloadPolicy, type ProviderPolicy } from './ledger';
import { QlooError } from '../qloo/errors';

export const APPLICATION_CUTOFF = 1794890700000;
export type ApplicationPolicy = { version: 2; authority: 'application-allowance'; providerUsageUnknown: true;
  providerQuotaUnknown: true; eventHost: 'https://hackathon.api.qloo.com'; credentialSha256: string;
  source: string; financialBasis: 'event-no-disclosed-fee'; checkedAt: number; expiresAt: number;
  minIntervalMs: number; allowance: { id: string; ceiling: number; knownBeforeLedger: number }; payload: PayloadPolicy };
export type ExecutionPolicy = ProviderPolicy | ApplicationPolicy;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const fields = ['version', 'authority', 'providerUsageUnknown', 'providerQuotaUnknown', 'eventHost', 'credentialSha256',
  'source', 'financialBasis', 'checkedAt', 'expiresAt', 'minIntervalMs', 'allowance', 'payload'];

// Cloud-only authority. Filesystem admission deliberately continues to accept V1 alone.
export function validateCloudPolicy(v: unknown, now = Date.now()): ExecutionPolicy {
  if (object(v) && v.version === 1) return validatePolicy(v);
  if (!object(v) || v.version !== 2 || Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k)) ||
    v.authority !== 'application-allowance' || v.providerUsageUnknown !== true || v.providerQuotaUnknown !== true ||
    v.eventHost !== 'https://hackathon.api.qloo.com' || typeof v.credentialSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.credentialSha256) ||
    !bounded(v.source) || v.financialBasis !== 'event-no-disclosed-fee' || !integer(v.checkedAt) || v.checkedAt > now ||
    !integer(v.expiresAt) || now >= v.expiresAt || v.expiresAt > APPLICATION_CUTOFF ||
    !integer(v.minIntervalMs) || v.minIntervalMs < 5000 || v.minIntervalMs > 45000 || !object(v.allowance) ||
    Object.keys(v.allowance).length !== 3 || !bounded(v.allowance.id) || !integer(v.allowance.ceiling) || v.allowance.ceiling < 1 ||
    !integer(v.allowance.knownBeforeLedger) || v.allowance.knownBeforeLedger > v.allowance.ceiling) throw new QlooError('configuration');
  const payload = v.payload;
  if (!object(payload) || !object(payload.categoryTagIds) || !bounded(payload.categoryTagIds.dining) ||
    !bounded(payload.categoryTagIds.attractions) || !object(payload.origin) ||
    typeof payload.origin.latitude !== 'number' || !Number.isFinite(payload.origin.latitude) || Math.abs(payload.origin.latitude) > 90 ||
    typeof payload.origin.longitude !== 'number' || !Number.isFinite(payload.origin.longitude) || Math.abs(payload.origin.longitude) > 180 ||
    !Array.isArray(payload.athensCityNames) || payload.athensCityNames.length < 1 || payload.athensCityNames.length > 30 ||
    !payload.athensCityNames.every(bounded)) throw new QlooError('configuration');
  return v as unknown as ApplicationPolicy;
}
