import { expect, test } from 'vitest';
import { validateCloudPolicy } from '../../../src/server/admission/application-policy';
import { validatePolicy } from '../../../src/server/admission/ledger';

const now = Date.parse('2026-10-17T12:00:00Z');
const policy = () => ({ version: 2, authority: 'application-allowance', providerUsageUnknown: true,
  providerQuotaUnknown: true, eventHost: 'https://hackathon.api.qloo.com', credentialSha256: 'a'.repeat(64),
  source: 'synthetic issuance reference', financialBasis: 'event-no-disclosed-fee', checkedAt: now - 1000,
  expiresAt: now + 60_000, minIntervalMs: 5000, allowance: { id: 'synthetic-lifetime', ceiling: 27, knownBeforeLedger: 12 },
  payload: { categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-attractions' },
    origin: { latitude: 37.98, longitude: 23.72 }, athensCityNames: ['Athens'] } });

test('A01/A07 truthful cloud allowance accepts unknown provider usage, filesystem rejects V2', () => {
  expect(validateCloudPolicy(policy(), now)).toEqual(policy());
  expect(() => validatePolicy(policy())).toThrow();
});

test.each([
  { authority: 'provider-quota' }, { providerUsageUnknown: false }, { providerQuotaUnknown: false },
  { verified: true }, { priorUsageKnown: true }, { windows: [] }, { providerQuotaKnown: false },
  { financialBasis: 'free-verified' }, { financialBasis: undefined }, { source: ' ' }, { source: 'x'.repeat(501) },
  { eventHost: 'https://api.qloo.com' }, { credentialSha256: 'A'.repeat(64) }, { credentialSha256: 'a'.repeat(63) },
  { expiresAt: now }, { expiresAt: Date.parse('2026-11-17T04:45:00Z') + 1 }, { checkedAt: now + 1 },
  { checkedAt: -1 }, { minIntervalMs: 4999 }, { minIntervalMs: Infinity },
  { allowance: { id: 'lifetime', ceiling: 27.5, knownBeforeLedger: 12 } },
  { allowance: { id: 'lifetime', ceiling: 27, knownBeforeLedger: -1 } },
  { allowance: { id: 'lifetime', ceiling: 27, knownBeforeLedger: 28 } },
  { allowance: { id: 'lifetime', ceiling: Number.MAX_SAFE_INTEGER + 1, knownBeforeLedger: 12 } },
])('A01/A07 rejects malformed allowance %j', change => {
  expect(() => validateCloudPolicy({ ...policy(), ...change }, now)).toThrow();
});
