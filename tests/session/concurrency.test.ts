import { expect, test } from 'vitest';
import { SessionStore } from '../../src/server/session/store';

test('20 simultaneous fence acquisitions admit exactly 1 and reject 19', () => {
  const store = new SessionStore();
  const session = store.create()!;
  const attempts = Array.from({ length: 20 }, () => store.begin(session.ref, 0));
  expect(attempts.filter(x => x.status === 'admitted')).toHaveLength(1);
  expect(attempts.filter(x => x.status === 'busy')).toHaveLength(19);
  const admitted = attempts.find(x => x.status === 'admitted')!;
  if (admitted.status !== 'admitted') throw new Error('admission');
  admitted.state.pending.set('snapshot-only', { seedIndex: 0, seed: {
    seedIndex: 0, kind: 'movie', qlooEntityId: 'synthetic-unit-id', name: 'Unit seed',
    evidence: { privateRef: 'unit', digest: 'unit', retrievedAt: 'unit' },
  } });
  expect(store.get(session.ref)!.pending.size).toBe(0);
  expect(store.commit(session.ref, 'foreign-fence', 0, admitted.state)).toBe(false);
  expect(store.commit(session.ref, admitted.fence, 0, admitted.state)).toBe(true);
  expect(store.get(session.ref)!.revision).toBe(1);
  expect(store.commit(session.ref, admitted.fence, 0, admitted.state)).toBe(false);
});

test('initial operation rejects a nonempty session, capacity never evicts', () => {
  const store = new SessionStore({ maxSessions: 1 });
  const session = store.create()!;
  const lock = store.begin(session.ref, 0, 'initialize');
  expect(lock.status).toBe('admitted');
  if (lock.status !== 'admitted') throw new Error('admission');
  expect(store.commit(session.ref, lock.fence, 0, lock.state)).toBe(true);
  expect(store.begin(session.ref, 1, 'initialize').status).toBe('invalid-initial');
  expect(store.create()).toBeNull();
  expect(store.get(session.ref)).not.toBeNull();
});

test('creation admits 20 per 60s, expired operation cannot commit', () => {
  let now = 0;
  const store = new SessionStore({ now: () => now, ttlMs: 100 });
  const sessions = Array.from({ length: 20 }, () => store.create());
  expect(sessions.filter(Boolean)).toHaveLength(20);
  expect(store.create()).toBeNull();
  const lock = store.begin(sessions[0]!.ref, 0);
  if (lock.status !== 'admitted') throw new Error('admission');
  now = 101;
  expect(store.commit(sessions[0]!.ref, lock.fence, 0, lock.state)).toBe(false);
  now = 60_001;
  expect(store.create()).not.toBeNull();
});
