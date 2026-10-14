import { expect, test, vi } from 'vitest';
import { readJsonBody } from '../../src/server/input/body';
test('8192 bytes accepted; 8193 rejected without Content-Length trust', async () => {
  for (const bytes of [8192, 8193]) {
    const payload = JSON.stringify('a'.repeat(bytes - 2));
    const request = new Request('http://localhost/api/session', { method: 'POST', body: payload, headers: { 'content-length': '2' } });
    const result = await readJsonBody(request);
    expect(result.ok).toBe(bytes === 8192);
    if (!result.ok) expect(result.error).toBe('body-too-large');
  }
});
test('actual UTF-8 bytes, not character count, enforce cap', async () => {
  expect((await readJsonBody(new Request('http://localhost', { method: 'POST', body: JSON.stringify('é'.repeat(4096)) }))).ok).toBe(false);
});
test('malformed JSON returns invalid-json', async () => {
  expect(await readJsonBody(new Request('http://localhost', { method: 'POST', body: '{' }))).toEqual({ ok: false, error: 'invalid-json' });
});

test('a pending body stops after absolute 5-second deadline', async () => {
  vi.useFakeTimers();
  try {
    const request = new Request('http://localhost', { method: 'POST', body: new ReadableStream(), duplex: 'half' } as RequestInit);
    const read = readJsonBody(request);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await read).toEqual({ ok: false, error: 'body-timeout' });
  } finally { vi.useRealTimers(); }
});

test('request abort cancels a pending body before deadline', async () => {
  const controller = new AbortController();
  const request = new Request('http://localhost', { method: 'POST', signal: controller.signal, body: new ReadableStream(), duplex: 'half' } as RequestInit);
  const read = readJsonBody(request);
  controller.abort();
  expect(await read).toEqual({ ok: false, error: 'request-aborted' });
});

test('20 pending readers admitted, reader 21 rejected; all slots release on abort', async () => {
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const pending = controllers.map(controller => readJsonBody(new Request('http://localhost', {
    method: 'POST', signal: controller.signal, body: new ReadableStream(), duplex: 'half',
  } as RequestInit)));
  try {
    expect(await readJsonBody(new Request('http://localhost', { method: 'POST', body: '{}' })))
      .toEqual({ ok: false, error: 'body-capacity' });
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(pending);
  }
  expect(await readJsonBody(new Request('http://localhost', { method: 'POST', body: '{}' })))
    .toEqual({ ok: true, value: {} });
});
