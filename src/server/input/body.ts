type BodyError = 'body-too-large' | 'invalid-json' | 'body-timeout' | 'request-aborted' | 'body-capacity';
export type BodyResult = { ok: true; value: unknown } | { ok: false; error: BodyError };
class BodyFailure extends Error {
  constructor(readonly reason: BodyError) { super(reason); }
}

export async function readJsonBody(request: Request): Promise<BodyResult> {
  const key = Symbol.for('taste-concierge.pending-bodies');
  const shared = globalThis as unknown as Record<symbol, number | undefined>;
  if (request.signal.aborted) return { ok: false, error: 'request-aborted' };
  if ((shared[key] ?? 0) >= 20) return { ok: false, error: 'body-capacity' };
  shared[key] = (shared[key] ?? 0) + 1;
  try { return await readBoundedBody(request); }
  catch { return { ok: false, error: 'invalid-json' }; }
  finally { shared[key] = (shared[key] ?? 1) - 1; }
}

async function readBoundedBody(request: Request): Promise<BodyResult> {
  if (request.signal.aborted) return { ok: false, error: 'request-aborted' };
  if (!request.body) return { ok: false, error: 'invalid-json' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const stop = (reason: BodyError) => {
      reject(new BodyFailure(reason));
      void reader.cancel().catch(() => {});
    };
    onAbort = () => stop('request-aborted');
    request.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('body-timeout'), 5000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) {
        void reader.cancel().catch(() => {});
        return { ok: false, error: 'body-too-large' };
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const json = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof BodyFailure ? error.reason : 'invalid-json' };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
