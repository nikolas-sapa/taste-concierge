import { expect, test } from 'vitest';
import type { ConciergeResult } from '../../src/contracts/concierge';
import { resultStatus } from '../../src/server/http/guards';

test('all truthful non-ready states have specified HTTP outcomes', () => {
  const cases: [ConciergeResult, number][] = [
    [{ state: 'needs-disambiguation', revision: 1, unresolved: [] }, 200],
    [{ state: 'no-valid-result', revision: 1, reasons: ['no-practical-match'] }, 422],
    [{ state: 'unsupported-constraint', revision: 0, fields: ['maxBudgetEur'] }, 400],
    [{ state: 'invalid-input', revision: 0, fields: ['brief'] }, 400],
    [{ state: 'service-unavailable', revision: 0, reason: 'configuration', retryable: false }, 503],
    [{ state: 'service-unavailable', revision: 0, reason: 'rate-limit', retryable: true }, 429],
    [{ state: 'service-unavailable', revision: 0, reason: 'timeout', retryable: true }, 504],
  ];
  for (const [result, status] of cases) expect(resultStatus(result)).toBe(status);
});
