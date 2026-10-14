import 'server-only';
import { getRuntime } from '../runtime';
import { readJsonBody } from '../input/body';
import { isRecord } from '../input/validate';
import { approvedOrigin, cookieName, json, sessionRef } from './guards';

export async function bootstrapSession(request: Request): Promise<Response> {
  const app = await getRuntime();
  if (!approvedOrigin(request, app.origin)) return json({ error: 'origin' }, 403);
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.error === 'body-capacity' ? 429 : body.error === 'body-too-large' ? 413 : ['body-timeout', 'request-aborted'].includes(body.error) ? 408 : 400);
  if (!isRecord(body.value) || Object.keys(body.value).length !== 0) return json({ error: 'invalid-json' }, 400);
  const priorRef = sessionRef(request, app.production);
  const prior = priorRef ? app.sessions.get(priorRef) : null;
  const created = prior ? { ref: priorRef!, state: prior } : app.sessions.create();
  if (!created) return json({ error: 'capacity' }, 429, { 'Retry-After': '60' });
  return json({ revision: created.state.revision, brief: created.state.brief, result: created.state.result }, 200, {
    'Set-Cookie': `${cookieName(app.production)}=${created.ref}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${app.production ? '; Secure' : ''}`,
  });
}
