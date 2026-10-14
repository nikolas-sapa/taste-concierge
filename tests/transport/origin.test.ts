import { expect, test } from 'vitest';
import { approvedOrigin, sessionRef } from '../../src/server/http/guards';

test('exact configured Origin required, forwarded host ignored', () => {
  const origin = 'https://concierge.example';
  expect(approvedOrigin(new Request(origin, { headers: { origin } }), origin)).toBe(true);
  for (const supplied of ['https://evil.example', 'null', `${origin}/`, '']) {
    expect(approvedOrigin(new Request(origin, { headers: { origin: supplied, 'x-forwarded-host': 'concierge.example' } }), origin)).toBe(false);
  }
  expect(approvedOrigin(new Request(origin, { headers: { origin } }), '')).toBe(false);
});

test('session cookie accepts only exact 32-byte hex token', () => {
  const token = 'ab'.repeat(32);
  expect(sessionRef(new Request('http://localhost', { headers: { cookie: `taste_session=${token}` } }), false)).toBe(token);
  expect(sessionRef(new Request('http://localhost', { headers: { cookie: 'taste_session=../private' } }), false)).toBeNull();
  expect(sessionRef(new Request('http://localhost', { headers: { cookie: `taste_session=${token}; taste_session=${token}` } }), false)).toBeNull();
});
