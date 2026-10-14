import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Brief, ConciergeResult } from '../../contracts/concierge';
import type { ResolvedInputs, SessionState } from '../../contracts/server';
import type { QlooClient } from './client';
import { normalizeSearch, preferExactCandidates } from './normalize';

export async function resolveWithClient(brief: Brief, session: SessionState, client: QlooClient): Promise<ConciergeResult | ResolvedInputs> {
  const entities = [...(session.resolved?.entities ?? [])];
  const unresolved: Extract<ConciergeResult, { state: 'needs-disambiguation' }>['unresolved'] = [];
  for (let index = 0; index < brief.seeds.length; index++) {
    if (entities.some(e => e.seedIndex === index)) continue;
    const seed = brief.seeds[index];
    const captured = await client.search(seed);
    const options = preferExactCandidates(normalizeSearch(captured.body, seed.kind, index, captured.evidence), seed.text);
    if (!options.length) return { state: 'no-valid-result', revision: session.revision + 1, reasons: ['no-entity-match'] };
    if (options.length === 1) {
      const { disambiguation: _, ...resolved } = options[0];
      entities.push(resolved);
    } else {
      const choices = options.map(option => {
        const ref = randomBytes(32).toString('hex');
        const { disambiguation, ...resolved } = option;
        session.pending.set(ref, { seedIndex: index, seed: resolved });
        return { ref, name: option.name, kind: option.kind, disambiguation };
      });
      unresolved.push({ seedIndex: index, options: choices });
    }
  }
  session.resolved = { entities };
  if (unresolved.length) return { state: 'needs-disambiguation', revision: session.revision + 1, unresolved };
  return { entities: entities.sort((a, b) => a.seedIndex - b.seedIndex) };
}
