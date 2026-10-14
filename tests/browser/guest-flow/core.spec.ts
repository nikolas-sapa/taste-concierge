import { expect, test } from '@playwright/test';
import type { Brief, ConciergeResult } from '../../../src/contracts/concierge';

const defaultBrief: Brief = {
  cityId: 'athens', seeds: [{ kind: 'movie', text: 'Spirited Away' }],
  diningPreference: 'Thoughtful, relaxed dining', attractionPreference: 'Quiet places with a sense of wonder',
  constraints: { radiusMeters: 2500, excludedVenueRefs: [] },
};

function installHealth(page: import('@playwright/test').Page) {
  return page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ready' } }));
}
function installSession(page: import('@playwright/test').Page, value: { revision: number; brief: Brief | null; result: ConciergeResult | null }) {
  return page.route('**/api/session', (route) => route.fulfill({ json: value }));
}

test('guest flow has no developer-key field', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /api key|developer key|qloo key/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /find places that feel like you/i })).toBeVisible();
});

test('unconfigured service is explained without claiming recommendations', async ({ page }) => {
  await page.route('**/api/health', async (route) => route.fulfill({ json: { status: 'unconfigured' } }));
  await page.goto('/');
  await expect(page.getByText(/service is not configured/i)).toBeVisible();
  await expect(page.getByText(/no recommendations have been generated/i)).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/guest-unconfigured-desktop.png', fullPage: true, style: 'nextjs-portal { display: none !important; }' });
});

test('actual local unconfigured route renders and screenshots desktop and mobile states', async ({ page, request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({ status: 'unconfigured' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText(/service is not configured/i)).toBeVisible();
  await expect(page.getByText(/no recommendations have been generated/i)).toBeVisible();
  await page.screenshot({ path: 'test-results/guest-actual-unconfigured-1440x900.png', style: 'nextjs-portal { display: none !important; }' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText(/service is not configured/i)).toBeVisible();
  await expect(page.getByText(/no recommendations have been generated/i)).toBeVisible();
  await page.screenshot({ path: 'test-results/guest-actual-unconfigured-390x844.png', style: 'nextjs-portal { display: none !important; }' });
});

test('unconfigured guest view fits mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/health', async (route) => route.fulfill({ json: { status: 'unconfigured' } }));
  await page.goto('/');
  await expect(page.getByText(/service is not configured/i)).toBeVisible();
  await expect(page.getByText(/no recommendations have been generated/i)).toBeVisible();
  await page.screenshot({ path: 'test-results/guest-unconfigured-mobile.png', fullPage: true, style: 'nextjs-portal { display: none !important; }' });
});

test('synthetic disambiguation state offers explicit candidate choices', async ({ page }) => {
  await installHealth(page);
  await installSession(page, { revision: 0, brief: null, result: null });
  await page.route('**/api/concierge', (route) => route.fulfill({ json: {
    state: 'needs-disambiguation', revision: 1,
    unresolved: [{ seedIndex: 0, options: [
      { ref: 'synthetic-a', name: 'Spirited Away', kind: 'movie', disambiguation: '2001 animated film' },
      { ref: 'synthetic-b', name: 'Spirited Away: Live', kind: 'movie', disambiguation: 'Stage adaptation' },
    ] }],
  } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /which reference did you mean/i })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /continue with these references/i })).toBeDisabled();
});

test('synthetic ready state separates sourced itinerary from unavailable comparison', async ({ page }) => {
  await installHealth(page);
  await installSession(page, { revision: 0, brief: null, result: null });
  const venue = (ref: string, category: 'dining' | 'attractions', name: string) => ({
    ref, category, name, source: 'qloo', interpretation: 'Synthetic test display only.',
    practicalFacts: [{ field: 'city', value: 'Athens', sourceUrl: 'https://www.wikidata.org/', sourceRevision: 'test', retrievedAt: '2026-10-13T00:00:00Z', status: 'source-reported' }],
    limitations: ['Synthetic browser fixture; not a real recommendation.'], retrievedAt: '2026-10-13T00:00:00Z',
  });
  await page.route('**/api/concierge', (route) => route.fulfill({ json: {
    state: 'ready', revision: 1,
    items: {
      dining: { primary: venue('test-dining', 'dining', 'Synthetic Taverna'), alternative: null },
      attractions: { primary: venue('test-attraction', 'attractions', 'Synthetic Garden'), alternative: null },
    }, baseline: { status: 'unavailable', reason: 'model-unavailable' },
  } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /places shaped by your taste/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Taverna' })).toBeVisible();
  await expect(page.getByText(/generic ai comparison/i)).toBeVisible();
  await expect(page.getByText(/comparison is currently unavailable/i)).toBeVisible();
});

test('synthetic initial transport failures retry through concierge at revision zero', async ({ page }) => {
  await installHealth(page);
  await installSession(page, { revision: 0, brief: null, result: null });
  let calls = 0;
  await page.route('**/api/concierge', async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 503, json: { error: 'upstream' } });
    return route.fulfill({ json: { state: 'no-valid-result', revision: 0, reasons: ['no-entity-match'] } });
  });
  await page.goto('/');
  await expect(page.getByText(/could not complete this request/i)).toBeVisible();
  await page.getByRole('button', { name: 'Find my places' }).click();
  await expect(page.getByText(/no verified itinerary found/i)).toBeVisible();
  expect(calls).toBe(2);
  await expect(page.getByText(/service is not configured/i)).toHaveCount(0);
});

test('synthetic noncommitted unavailable result Try again repeats initial concierge', async ({ page }) => {
  await installHealth(page);
  let sessionCalls = 0;
  let conciergeCalls = 0;
  let preferenceCalls = 0;
  await page.route('**/api/session', async (route) => {
    sessionCalls++;
    return route.fulfill({ json: { revision: 0, brief: null, result: null } });
  });
  await page.route('**/api/concierge', async (route) => {
    conciergeCalls++;
    if (conciergeCalls === 1) return route.fulfill({ status: 503, json: { state: 'service-unavailable', revision: 0, reason: 'network', retryable: true } });
    return route.fulfill({ json: { state: 'no-valid-result', revision: 0, reasons: ['no-entity-match'] } });
  });
  await page.route('**/api/preferences', async (route) => {
    preferenceCalls++;
    return route.fulfill({ status: 500, json: { error: 'unexpected-preferences-call' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(/no verified itinerary found/i)).toBeVisible();
  expect(conciergeCalls).toBe(2);
  expect(preferenceCalls).toBe(0);
  expect(sessionCalls).toBe(1);
});

for (const [label, result] of [
  ['invalid input', { state: 'invalid-input', revision: 0, fields: ['seeds'] }],
  ['unsupported constraint', { state: 'unsupported-constraint', revision: 0, fields: ['maxBudgetEur'] }],
  ['unavailable service', { state: 'service-unavailable', revision: 0, reason: 'network', retryable: true }],
] as const) {
  test(`synthetic ${label} at revision zero retries through initial concierge`, async ({ page }) => {
    await installHealth(page);
    await installSession(page, { revision: 0, brief: null, result: null });
    const revisions: number[] = [];
    await page.route('**/api/concierge', async (route) => {
      const body = route.request().postDataJSON() as { revision: number };
      revisions.push(body.revision);
      return route.fulfill({ json: result });
    });
    await page.route('**/api/preferences', async (route) => route.fulfill({ status: 500, json: { error: 'unexpected-preferences-call' } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Find my places' })).toBeEnabled();
    await page.getByRole('button', { name: 'Find my places' }).click();
    await expect.poll(() => revisions.length).toBe(2);
    expect(revisions).toEqual([0, 0]);
  });
}

test('canonical session brief wins browser storage and survives preference edit', async ({ page }) => {
  const canonical: Brief = {
    ...defaultBrief,
    seeds: [{ kind: 'artist', text: 'Nujabes' }, { kind: 'place', text: 'Kyoto' }],
    constraints: { radiusMeters: 900, excludedVenueRefs: [] },
  };
  const committed: ConciergeResult = { state: 'no-valid-result', revision: 7, reasons: ['no-practical-match'] };
  await page.addInitScript(() => sessionStorage.setItem('taste-concierge-brief', JSON.stringify({
    cityId: 'athens', seeds: [null], diningPreference: 'bad', attractionPreference: 'bad', constraints: { radiusMeters: 1, excludedVenueRefs: [] },
  })));
  await installHealth(page);
  await installSession(page, { revision: 7, brief: canonical, result: committed });
  let preferencePayload: { revision: number; brief: Brief } | null = null;
  await page.route('**/api/preferences', async (route) => {
    preferencePayload = route.request().postDataJSON() as { revision: number; brief: Brief };
    return route.fulfill({ json: { state: 'no-valid-result', revision: 8, reasons: ['no-practical-match'] } });
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Reference 1' })).toHaveValue('Nujabes');
  await expect(page.getByRole('textbox', { name: 'Reference 2' })).toHaveValue('Kyoto');
  await expect(page.getByRole('spinbutton', { name: /maximum distance/i })).toHaveValue('900');
  await page.getByRole('textbox', { name: 'Dining preference' }).fill('Small plates');
  await page.getByRole('button', { name: 'Find my places' }).click();
  await expect.poll(() => preferencePayload !== null).toBe(true);
  expect(preferencePayload).toEqual({ revision: 7, brief: { ...canonical, diningPreference: 'Small plates' } });
});

test('malformed stored brief falls back to default without crashing', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('taste-concierge-brief', JSON.stringify({
    cityId: 'athens', seeds: [null], diningPreference: 'bad', attractionPreference: 'bad', constraints: { radiusMeters: 1, excludedVenueRefs: [] },
  })));
  await installHealth(page);
  await installSession(page, { revision: 0, brief: null, result: null });
  await page.route('**/api/concierge', (route) => route.fulfill({ json: { state: 'no-valid-result', revision: 0, reasons: ['no-entity-match'] } }));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Reference 1' })).toHaveValue('Spirited Away');
  await expect(page.getByText(/no verified itinerary found/i)).toBeVisible();
});

test('synthetic changed candidate set clears the previous opaque selection', async ({ page }) => {
  await installHealth(page);
  await installSession(page, { revision: 0, brief: null, result: null });
  let conciergeCalls = 0;
  await page.route('**/api/concierge', async (route) => {
    conciergeCalls++;
    return route.fulfill({ json: {
      state: 'needs-disambiguation', revision: 1,
      unresolved: [{ seedIndex: 0, options: [
        { ref: 'synthetic-a', name: 'First A', kind: 'movie', disambiguation: 'Candidate A' },
        { ref: 'synthetic-old-b', name: 'First B', kind: 'movie', disambiguation: 'Candidate B' },
      ] }],
    } });
  });
  await page.route('**/api/preferences', async (route) => route.fulfill({ json: {
    state: 'needs-disambiguation', revision: 2,
    unresolved: [{ seedIndex: 0, options: [
      { ref: 'synthetic-new-b', name: 'Second B', kind: 'movie', disambiguation: 'New candidate B' },
      { ref: 'synthetic-new-c', name: 'Second C', kind: 'movie', disambiguation: 'New candidate C' },
    ] }],
  } }));
  await page.goto('/');
  await page.getByRole('radio', { name: /First A/ }).check();
  await expect(page.getByRole('button', { name: /continue with these references/i })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Reference 1' }).fill('New seed');
  await page.getByRole('button', { name: 'Find my places' }).click();
  await expect(page.getByRole('radio', { name: /Second B/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /continue with these references/i })).toBeDisabled();
  await page.getByRole('radio', { name: /Second C/ }).check();
  await expect(page.getByRole('button', { name: /continue with these references/i })).toBeEnabled();
  expect(conciergeCalls).toBe(1);
});

test('session-expired transport error survives single JSON parse and can recover', async ({ page }) => {
  await installHealth(page);
  let sessionCalls = 0;
  await page.route('**/api/session', async (route) => {
    sessionCalls++;
    return route.fulfill({ json: { revision: 0, brief: null, result: null } });
  });
  await page.route('**/api/concierge', async (route) => route.fulfill({ status: 401, json: { error: 'session-expired' } }));
  await page.goto('/');
  await expect(page.getByText(/your session expired/i)).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sessionCalls).toBe(2);
  await expect(page.getByRole('textbox', { name: 'Reference 1' })).toHaveValue('Spirited Away');
  await expect(page.getByText(/session changed in another request/i)).toHaveCount(0);
});
