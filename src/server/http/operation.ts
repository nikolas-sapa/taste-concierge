import 'server-only';
import type { ConciergeResult } from '../../contracts/concierge';
import { getRuntime, requestConfiguration } from '../runtime';
import { readJsonBody } from '../input/body';
import { hasOnlyKeys, isRecord, isRevision, validateBrief, validateSelections } from '../input/validate';
import { approvedOrigin, json, resultStatus, sessionRef } from './guards';
import { withCloudOperation } from '../persistence/cloud';

export async function handleOperation(request: Request, mode: 'initialize' | 'update' | 'select'): Promise<Response> {
  const config = requestConfiguration();
  if (!approvedOrigin(request, config.origin)) return json({ error: 'origin' }, 403);
  const deadlineAt = performance.now() + 90_000;
  const deadline = AbortSignal.timeout(90_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  try {
    const response = await executeOperation(request, mode, signal, deadlineAt);
    return signal.aborted ? json({ error: 'request-aborted' }, 408) : response;
  }
  catch {
    return signal.aborted ? json({ error: 'request-aborted' }, 408) : json({ error: 'service-unavailable' }, 503);
  }
}

async function executeOperation(request: Request, mode: 'initialize' | 'update' | 'select', signal: AbortSignal, deadlineAt: number): Promise<Response> {
  const app = await getRuntime();
  if (!approvedOrigin(request, app.origin)) return json({ error: 'origin' }, 403);
  const ref = sessionRef(request, app.production);
  if (!ref || !await app.sessions.get(ref)) return json({ error: 'session-expired' }, 401);
  const body = await readJsonBody(request, app.bodyLimiter);
  if (!body.ok) return json({ error: body.error }, body.error === 'body-capacity' ? 429 : body.error === 'body-too-large' ? 413 : ['body-timeout', 'request-aborted'].includes(body.error) ? 408 : 400);
  const input = body.value;
  if (!isRecord(input) || !isRevision(input.revision) || !hasOnlyKeys(input, mode === 'select' ? ['revision', 'selections'] : ['revision', 'brief'])) {
    return json({ error: 'invalid-json' }, 400);
  }
  const revision = input.revision;
  const brief = mode === 'select' ? null : validateBrief(input.brief);
  if (brief && !brief.ok) return json({ state: 'invalid-input', revision: input.revision, fields: brief.fields }, 400);
  if (mode === 'select' && !validateSelections(input.selections)) return json({ state: 'invalid-input', revision: input.revision, fields: ['selections'] }, 400);
  // Reserve the full 5s database transport bound so the DB lease ends before this request's deadline.
  const leaseMs = Math.floor(deadlineAt - performance.now() - 5000);
  if (signal.aborted || leaseMs <= 0) return json({ error: 'request-aborted' }, 408);
  const admitted = await app.sessions.begin(ref, input.revision, mode, Math.min(90_000, leaseMs));
  if (admitted.status !== 'admitted') {
    return json({ error: admitted.status === 'missing' ? 'session-expired' : admitted.status === 'busy' ? 'busy' : 'stale-revision' }, admitted.status === 'missing' ? 401 : 409);
  }
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= app.sessions.finish(ref, admitted.fence)
      .catch(() => { console.warn('[runtime] session-cancel-unavailable'); });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); return json({ error: 'request-aborted' }, 408); }
    if (!app.bindingConfigurationValid) return json({ state: 'service-unavailable', revision: input.revision, reason: 'configuration', retryable: false }, 503);
    const next = admitted.state;
    let result: ConciergeResult = await withCloudOperation({ ref, fence: admitted.fence, revision }, async () => {
      if (mode === 'select' && validateSelections(input.selections)) return app.concierge.selectSeeds(input.selections, revision, next, signal);
      if (brief?.ok) return mode === 'initialize'
        ? app.concierge.assembleConcierge(brief.brief, next, signal) : app.updatePreferences(brief.brief, revision, next, signal);
      throw new Error('Invalid operation');
    });
    if (signal.aborted) return json({ error: 'request-aborted' }, 408);
    if (['ready', 'needs-disambiguation', 'no-valid-result'].includes(result.state)) {
      next.result = result;
      const committed = await app.sessions.commit(ref, admitted.fence, input.revision, next);
      if (signal.aborted) return json({ error: 'request-aborted' }, 408);
      if (!committed) return json({ error: 'stale-revision' }, 409);
      result = { ...result, revision: input.revision + 1 };
    } else result = { ...result, revision: input.revision };
    return json(result, resultStatus(result));
  } catch {
    return json({ state: 'service-unavailable', revision: input.revision, reason: 'upstream', retryable: false }, 503);
  } finally {
    signal.removeEventListener('abort', cancel);
    try { if (cancellation) await cancellation; else await app.sessions.finish(ref, admitted.fence); }
    catch { console.warn('[runtime] session-cleanup-unavailable'); }
  }
}
