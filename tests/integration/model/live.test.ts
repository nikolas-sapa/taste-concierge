import { expect, test } from 'vitest';
import { createModelService } from '../../../src/server/model/responses';

test('real model adapter defaults to zero spend and performs zero transport attempts', async () => {
  let calls = 0;
  const service = createModelService({ keyFile: '/absent-unit-key', maxSpendUsd: 0,
    evidenceDir: '/absent-unit-evidence', projectRoot: process.cwd() },
    (async () => { calls++; throw new Error('unexpected paid transport'); }) as typeof fetch);
  expect(await service.isReady()).toBe(false);
  const brief = { cityId: 'athens' as const, seeds: [{ kind: 'movie' as const, text: 'Unit film' }],
    diningPreference: 'quiet', attractionPreference: 'history', constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };
  expect(await service.generateBaseline(brief, [])).toEqual({ status: 'unavailable', reason: 'model-unavailable' });
  expect(await service.interpretTreatment(brief, [], [])).toEqual({ status: 'unavailable', reason: 'model-unavailable' });
  expect(calls).toBe(0);
});

test.skip('authorized live model success: unexecuted, no spend/access allowance', () => {});
