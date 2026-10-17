import { beforeEach, expect, test, vi } from 'vitest';
import type { Brief, ConciergeResult } from '../../src/contracts/concierge';
import { SessionStore } from '../../src/server/session/store';
import { asyncLocalSessionRepository } from '../../src/server/persistence/ports';

const mocked = vi.hoisted(() => ({ getRuntime: vi.fn() }));
vi.mock('../../src/server/runtime', () => ({ getRuntime: mocked.getRuntime,
  requestConfiguration: () => ({ origin: 'https://concierge.example', production: true }) }));
import { handleOperation } from '../../src/server/http/operation';
import { bootstrapSession } from '../../src/server/http/session';

const origin = 'https://concierge.example';
const brief: Brief = { cityId: 'athens', seeds: [{ kind: 'movie', text: 'Synthetic Film' }],
  diningPreference: 'quiet', attractionPreference: 'history',
  constraints: { radiusMeters: 3000, excludedVenueRefs: [] } };

function fixture() {
  const store = new SessionStore();
  const created = store.create()!;
  const result: ConciergeResult = { state: 'no-valid-result', revision: 1, reasons: ['no-practical-match'] };
  return { created, app: { origin, production: true, bindingConfigurationValid: true,
    sessions: asyncLocalSessionRepository(store), bodyLimiter: undefined,
    concierge: { assembleConcierge: vi.fn(async () => result) },
  } };
}
function request(ref?: string, suppliedOrigin = origin, includeBody = true) {
  return new Request(`${origin}/api/${ref ? 'concierge' : 'session'}`, { method: 'POST',
    headers: { origin: suppliedOrigin, 'content-type': 'application/json',
      ...(ref ? { cookie: `__Host-taste_session=${ref}` } : {}) },
    body: includeBody ? JSON.stringify(ref ? { revision: 0, brief } : {}) : null });
}
function bootstrapRequest(ref?: string) {
  return new Request(`${origin}/api/session`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...(ref ? { cookie: `__Host-taste_session=${ref}` } : {}) },
    body: '{}' });
}

beforeEach(() => mocked.getRuntime.mockReset());

test('20 wrong origins trigger zero runtime/database calls', async () => {
  for (let index = 0; index < 20; index++) {
    expect((await handleOperation(request('ab'.repeat(32), 'https://evil.example'), 'initialize')).status).toBe(403);
  }
  expect(mocked.getRuntime).not.toHaveBeenCalled();
});

test('runtime failure exposes no database detail, cookie or false revision', async () => {
  mocked.getRuntime.mockRejectedValueOnce(new Error('synthetic-private-database-detail'));
  const response = await handleOperation(request('ab'.repeat(32)), 'initialize');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service-unavailable' });
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('session storage failure is unavailable, never expired or capacity', async () => {
  const { created, app } = fixture();
  app.sessions.get = async () => { throw new Error('synthetic-private-database-detail'); };
  mocked.getRuntime.mockResolvedValue(app);
  expect((await handleOperation(request(created.ref), 'initialize')).status).toBe(503);
  expect((await bootstrapSession(bootstrapRequest(created.ref))).status).toBe(503);
  expect(app.concierge.assembleConcierge).not.toHaveBeenCalled();
});

test('distributed body limiter failure returns 503, not malformed input', async () => {
  const { app } = fixture();
  mocked.getRuntime.mockResolvedValue({ ...app, bodyLimiter: {
    acquire: async () => { throw new Error('synthetic-db-outage'); }, release: vi.fn(),
  } });
  const response = await bootstrapSession(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service-unavailable' });
});

test('lost commit acknowledgement does not issue a success or false revision', async () => {
  const { created, app } = fixture();
  app.sessions.commit = async () => { throw new Error('synthetic-unknown-commit'); };
  mocked.getRuntime.mockResolvedValue(app);
  const response = await handleOperation(request(created.ref), 'initialize');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ state: 'service-unavailable', revision: 0 });
});

test('cleanup failure preserves acknowledged committed result', async () => {
  const { created, app } = fixture();
  app.sessions.finish = async () => { throw new Error('synthetic-cleanup-outage'); };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocked.getRuntime.mockResolvedValue(app);
  try {
    const response = await handleOperation(request(created.ref), 'initialize');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ state: 'no-valid-result', revision: 1 });
    expect(warning).toHaveBeenCalledExactlyOnceWith('[runtime] session-cleanup-unavailable');
  } finally { warning.mockRestore(); }
});

test('cancellation during commit records finish and suppresses a late success', async () => {
  const { created, app } = fixture();
  const controller = new AbortController();
  const finish = vi.spyOn(app.sessions, 'finish');
  app.sessions.commit = async () => { controller.abort(); return true; };
  mocked.getRuntime.mockResolvedValue(app);
  const incoming = new Request(request(created.ref), { signal: controller.signal });
  const response = await handleOperation(incoming, 'initialize');
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({ error: 'request-aborted' });
  expect(finish).toHaveBeenCalledTimes(1);
});

test('database lease reserves 5s transport margin inside the 90s request budget', async () => {
  const { created, app } = fixture();
  const begin = vi.spyOn(app.sessions, 'begin');
  mocked.getRuntime.mockResolvedValue(app);
  expect((await handleOperation(request(created.ref), 'initialize')).status).toBe(422);
  const leaseMs = begin.mock.calls[0][3]!;
  expect(leaseMs).toBeGreaterThan(80_000);
  expect(leaseMs).toBeLessThanOrEqual(85_000);
});
