import type { ConciergeResult } from '../../contracts/concierge';

export function approvedOrigin(request: Request, configured: string): boolean {
  if (!configured || request.headers.get('origin') !== configured) return false;
  try {
    const url = new URL(configured);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === configured;
  } catch { return false; }
}

export function cookieName(production: boolean): string {
  return production ? '__Host-taste_session' : 'taste_session';
}

export function sessionRef(request: Request, production: boolean): string | null {
  const name = cookieName(production);
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const ref = matches[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(ref) ? ref : null;
}

export function resultStatus(result: ConciergeResult): number {
  switch (result.state) {
    case 'ready': case 'needs-disambiguation': return 200;
    case 'no-valid-result': return 422;
    case 'unsupported-constraint': case 'invalid-input': return 400;
    case 'service-unavailable':
      return result.reason === 'timeout' ? 504 : result.reason === 'rate-limit' ? 429 : 503;
  }
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
