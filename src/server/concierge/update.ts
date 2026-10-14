import 'server-only';
import type { Brief, Category, ConciergeResult } from '../../contracts/concierge';
import type { SessionState } from '../../contracts/server';
import { assembleConcierge, continueConcierge, validateExclusions } from './assemble';

export async function updatePreferences(brief: Brief, revision: number, session: SessionState, signal?: AbortSignal): Promise<ConciergeResult> {
  if (revision !== session.revision || !session.brief || !validateExclusions(brief, session)) {
    return { state: 'invalid-input', revision: session.revision + 1, fields: ['revision', 'excludedVenueRefs'] };
  }
  const previous = session.brief;
  if (JSON.stringify(previous.seeds) !== JSON.stringify(brief.seeds) ||
    JSON.stringify(previous.constraints) !== JSON.stringify(brief.constraints) ||
    session.result?.state !== 'ready' || !session.resolved) return assembleConcierge(structuredClone(brief), session, signal);
  const categories: Category[] = [];
  if (previous.diningPreference !== brief.diningPreference) categories.push('dining');
  if (previous.attractionPreference !== brief.attractionPreference) categories.push('attractions');
  if (!categories.length) {
    const result = structuredClone(session.result);
    result.revision = session.revision + 1;
    session.result = result;
    return result;
  }
  return continueConcierge(structuredClone(brief), session, categories, signal);
}
