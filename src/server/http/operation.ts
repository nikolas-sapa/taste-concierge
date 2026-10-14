import 'server-only';
import type { ConciergeResult } from '../../contracts/concierge';
import { assembleConcierge, selectSeeds } from '../concierge/assemble';
import { updatePreferences } from '../concierge/update';
import { getRuntime } from '../runtime';
import { readJsonBody } from '../input/body';
import { hasOnlyKeys, isRecord, isRevision, validateBrief, validateSelections } from '../input/validate';
import { approvedOrigin, json, resultStatus, sessionRef } from './guards';

export async function handleOperation(request: Request, mode: 'initialize' | 'update' | 'select'): Promise<Response> {
  const app = await getRuntime();
  if (!approvedOrigin(request, app.origin)) return json({ error: 'origin' }, 403);
  const ref = sessionRef(request, app.production);
  if (!ref || !app.sessions.get(ref)) return json({ error: 'session-expired' }, 401);
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.error === 'body-capacity' ? 429 : body.error === 'body-too-large' ? 413 : ['body-timeout', 'request-aborted'].includes(body.error) ? 408 : 400);
  const input = body.value;
  if (!isRecord(input) || !isRevision(input.revision) || !hasOnlyKeys(input, mode === 'select' ? ['revision', 'selections'] : ['revision', 'brief'])) {
    return json({ error: 'invalid-json' }, 400);
  }
  const brief = mode === 'select' ? null : validateBrief(input.brief);
  if (brief && !brief.ok) return json({ state: 'invalid-input', revision: input.revision, fields: brief.fields }, 400);
  if (mode === 'select' && !validateSelections(input.selections)) return json({ state: 'invalid-input', revision: input.revision, fields: ['selections'] }, 400);
  const admitted = app.sessions.begin(ref, input.revision, mode);
  if (admitted.status !== 'admitted') {
    return json({ error: admitted.status === 'missing' ? 'session-expired' : admitted.status === 'busy' ? 'busy' : 'stale-revision' }, admitted.status === 'missing' ? 401 : 409);
  }
  try {
    if (!app.bindingConfigurationValid) return json({ state: 'service-unavailable', revision: input.revision, reason: 'configuration', retryable: false }, 503);
    const next = admitted.state;
    let result: ConciergeResult;
    if (mode === 'select' && validateSelections(input.selections)) result = await selectSeeds(input.selections, input.revision, next, request.signal);
    else if (brief?.ok) result = mode === 'initialize'
      ? await assembleConcierge(brief.brief, next, request.signal) : await updatePreferences(brief.brief, input.revision, next, request.signal);
    else return json({ error: 'invalid-json' }, 400);
    if (request.signal.aborted) return json({ error: 'request-aborted' }, 408);
    if (['ready', 'needs-disambiguation', 'no-valid-result'].includes(result.state)) {
      next.result = result;
      if (!app.sessions.commit(ref, admitted.fence, input.revision, next)) return json({ error: 'stale-revision' }, 409);
      result = { ...result, revision: input.revision + 1 };
    } else result = { ...result, revision: input.revision };
    return json(result, resultStatus(result));
  } catch {
    return json({ state: 'service-unavailable', revision: input.revision, reason: 'upstream', retryable: false }, 503);
  } finally {
    app.sessions.finish(ref, admitted.fence);
  }
}
