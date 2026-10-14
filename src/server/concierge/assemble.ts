import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Brief, Category, ConciergeResult, Selection, VenueCard } from '../../contracts/concierge';
import type { InternalCandidate, PracticalFixture, RecommendationBatch, ResolvedInputs, SessionState } from '../../contracts/server';
import { filterPractical } from '../practical/filter';
import type { QlooClient } from '../qloo/client';
import { QlooError } from '../qloo/errors';
import type { FixtureBinding } from '../qloo/normalize';
import { recommendWithClient } from '../qloo/recommend';
import { resolveWithClient } from '../qloo/resolve';
import type { ModelService, RankedFixture } from '../model/responses';
import { renderModelInterpretation } from '../model/interpretation';

export type ConciergeDependencies = { client: QlooClient; fixtures: readonly PracticalFixture[];
  bindings: readonly FixtureBinding[]; model?: ModelService };
const configurationKey = Symbol.for('taste-concierge.dependencies');
const shared = globalThis as unknown as Record<symbol, ConciergeDependencies | undefined>;

export function configureConcierge(deps: ConciergeDependencies): void {
  if (shared[configurationKey]) throw new Error('Concierge already configured');
  shared[configurationKey] = { client: deps.client, fixtures: structuredClone([...deps.fixtures]), bindings: structuredClone([...deps.bindings]), model: deps.model };
}

function dependencies(): ConciergeDependencies {
  const configured = shared[configurationKey];
  if (!configured) throw new QlooError('configuration');
  return configured;
}

export function resolveSeeds(brief: Brief, session: SessionState): Promise<ConciergeResult | ResolvedInputs> {
  return resolveWithClient(brief, session, dependencies().client);
}
export function retrieveRecommendations(inputs: ResolvedInputs, brief: Brief): Promise<RecommendationBatch> {
  const deps = dependencies();
  return recommendWithClient(inputs, brief, deps.client, deps.bindings);
}

export function validateExclusions(brief: Brief, session: SessionState): boolean {
  return brief.constraints.excludedVenueRefs.every(ref => session.venues.has(ref));
}

function card(candidate: InternalCandidate, fixture: PracticalFixture, session: SessionState): VenueCard {
  let ref = [...session.venues].find(([, c]) => c.qlooEntityId === candidate.qlooEntityId && c.category === candidate.category)?.[0];
  if (!ref) ref = randomBytes(32).toString('hex');
  session.venues.set(ref, candidate);
  return { ref, name: candidate.name, category: candidate.category, source: 'qloo',
    interpretation: 'Selected using aggregate Qloo taste affinity. This does not establish individual preferences.',
    practicalFacts: (['city', 'category', 'coordinates'] as const).map(field => ({ field,
      value: field === 'city' ? fixture.cityId : field === 'category' ? fixture.category : fixture.coordinates,
      sourceUrl: fixture.sourceUrl, sourceRevision: fixture.sourceRevision, retrievedAt: fixture.retrievedAt,
      status: fixture.verification })),
    limitations: ['City, category and coordinates are source-reported.',
      'Free-text preferences need an enabled model. Shown order follows Qloo taste ranking.',
      'Hours, prices, allergy safety, availability and current operation are unknown.'],
    retrievedAt: candidate.evidence.retrievedAt };
}

async function execute(brief: Brief, session: SessionState, categories: readonly Category[] = ['dining', 'attractions'], signal?: AbortSignal): Promise<ConciergeResult> {
  const fields: ('maxBudgetEur' | 'localOpeningTime')[] = [];
  if (brief.constraints.maxBudgetEur !== undefined) fields.push('maxBudgetEur');
  if (brief.constraints.localOpeningTime !== undefined) fields.push('localOpeningTime');
  if (fields.length) return { state: 'unsupported-constraint', revision: session.revision + 1, fields };
  if (!validateExclusions(brief, session)) return { state: 'invalid-input', revision: session.revision + 1, fields: ['excludedVenueRefs'] };
  const deps = dependencies();
  let accepted: RecommendationBatch | null = null;
  const result = await deps.client.runOperation<ConciergeResult>(async () => {
    const resolved = await resolveSeeds(brief, session);
    if ('state' in resolved) return resolved;
    const batch = await recommendWithClient(resolved, brief, deps.client, deps.bindings, categories);
    const previousReady = session.result?.state === 'ready' ? session.result : null;
    for (const category of ['dining', 'attractions'] as Category[]) {
      if (!categories.includes(category) && previousReady) {
        batch.byCategory[category] = [previousReady.items[category].primary, previousReady.items[category].alternative]
          .filter((item): item is VenueCard => !!item).map(item => session.venues.get(item.ref))
          .filter((candidate): candidate is InternalCandidate => !!candidate);
      }
    }
    if (!batch.byCategory.dining.length || !batch.byCategory.attractions.length) {
      return { state: 'no-valid-result', revision: session.revision + 1, reasons: ['no-category-coverage'] };
    }
    const excluded = new Set(brief.constraints.excludedVenueRefs.map(ref => session.venues.get(ref)!.qlooEntityId));
    const constrained: RecommendationBatch = { byCategory: {
      dining: batch.byCategory.dining.filter(c => !excluded.has(c.qlooEntityId)),
      attractions: batch.byCategory.attractions.filter(c => !excluded.has(c.qlooEntityId)),
    } };
    // Session-only exclusion refs were already resolved above. Pure predicates receive no opaque refs.
    const predicateBrief = structuredClone(brief);
    predicateBrief.constraints.excludedVenueRefs = [];
    const decision = filterPractical(constrained, predicateBrief, [...deps.fixtures]);
    if (decision.status !== 'valid') {
      return { state: 'no-valid-result', revision: session.revision + 1,
        reasons: excluded.size ? ['constraints-unsatisfied'] : ['no-practical-match'] };
    }
    accepted = { byCategory: decision.byCategory };
    const items = {} as Extract<ConciergeResult, { state: 'ready' }>['items'];
    for (const category of ['dining', 'attractions'] as Category[]) {
      if (!categories.includes(category) && previousReady) { items[category] = structuredClone(previousReady.items[category]); continue; }
      const candidates = decision.byCategory[category];
      const primary = candidates[0];
      const fixture = deps.fixtures.find(f => f.fixtureId === primary?.fixtureId);
      if (!primary || !fixture) throw new QlooError('upstream');
      const alternative = candidates[1];
      const alternativeFixture = alternative && deps.fixtures.find(f => f.fixtureId === alternative.fixtureId);
      items[category] = { primary: card(primary, fixture, session),
        alternative: alternative && alternativeFixture ? card(alternative, alternativeFixture, session) : null };
    }
    const retainedRefs = new Set([...brief.constraints.excludedVenueRefs,
      ...Object.values(items).flatMap(item => [item.primary.ref, ...(item.alternative ? [item.alternative.ref] : [])])]);
    for (const ref of session.venues.keys()) if (!retainedRefs.has(ref)) session.venues.delete(ref);
    return { state: 'ready', revision: session.revision + 1, items,
      baseline: { status: 'unavailable', reason: 'model-unavailable' } };
  }, signal);
  if (result.state !== 'ready' || !deps.model || !accepted) return result;
  // All signals below come from server-held, independently bound real candidates.
  const batch = accepted as RecommendationBatch;
  const ranked: RankedFixture[] = [];
  for (const category of ['dining', 'attractions'] as Category[]) {
    for (const candidate of batch.byCategory[category]) {
      if (candidate.fixtureId && candidate.qlooRank !== undefined) {
        ranked.push({ fixtureRef: candidate.fixtureId, category, rank: candidate.qlooRank });
      }
    }
  }
  const excludedFixtures = brief.constraints.excludedVenueRefs
    .map(ref => session.venues.get(ref)?.fixtureId).filter((id): id is string => !!id);
  const treatment = await deps.model.interpretTreatment(brief, deps.fixtures, ranked, signal, excludedFixtures);
  if (treatment.status === 'ready') {
    for (const category of categories) {
      const choices = treatment.items.filter(item => item.category === category);
      const primary = choices.find(item => item.role === 'primary');
      const alternative = choices.find(item => item.role === 'alternative');
      const render = (selection: typeof primary) => {
        if (!selection) return null;
        const candidate = batch.byCategory[category].find(item => item.fixtureId === selection.fixtureRef);
        const fixture = deps.fixtures.find(item => item.fixtureId === selection.fixtureRef);
        if (!candidate || !fixture) return null;
        const venue = card(candidate, fixture, session);
        venue.interpretation = renderModelInterpretation(selection.reasonCodes, 'qloo');
        venue.limitations = venue.limitations.filter(limit => !limit.startsWith('Free-text preferences'));
        return venue;
      };
      const renderedPrimary = render(primary);
      if (renderedPrimary) result.items[category] = { primary: renderedPrimary, alternative: render(alternative) };
    }
  }
  result.baseline = await deps.model.generateBaseline(brief, deps.fixtures, signal, excludedFixtures);
  const retained = new Set([...brief.constraints.excludedVenueRefs,
    ...Object.values(result.items).flatMap(item => [item.primary.ref, ...(item.alternative ? [item.alternative.ref] : [])])]);
  for (const ref of session.venues.keys()) if (!retained.has(ref)) session.venues.delete(ref);
  return result;
}

export async function assembleConcierge(brief: Brief, session: SessionState, signal?: AbortSignal): Promise<ConciergeResult> {
  try {
    // Callers supply an isolated store snapshot and hold its operation fence through commit.
    session.brief = structuredClone(brief);
    session.resolved = null;
    session.pending.clear();
    const result = await execute(brief, session, undefined, signal);
    session.result = result;
    return result;
  } catch (error) {
    const reason = error instanceof QlooError ? error.reason : 'upstream';
    const result: ConciergeResult = { state: 'service-unavailable', revision: session.revision + 1,
      reason, retryable: reason === 'network' || reason === 'timeout' || reason === 'upstream' };
    session.result = result;
    return result;
  }
}

export async function continueConcierge(brief: Brief, session: SessionState,
  categories: readonly Category[] = ['dining', 'attractions'], signal?: AbortSignal): Promise<ConciergeResult> {
  try { const result = await execute(brief, session, categories, signal); session.brief = structuredClone(brief); session.result = result; return result; }
  catch (error) {
    const reason = error instanceof QlooError ? error.reason : 'upstream';
    const result: ConciergeResult = { state: 'service-unavailable', revision: session.revision + 1,
      reason, retryable: reason === 'network' || reason === 'timeout' || reason === 'upstream' };
    session.result = result; return result;
  }
}

export async function selectSeeds(selections: Selection[], revision: number, session: SessionState, signal?: AbortSignal): Promise<ConciergeResult> {
  if (revision !== session.revision || session.result?.state !== 'needs-disambiguation' || !session.brief ||
    !selections.length || new Set(selections.map(s => s.seedIndex)).size !== selections.length) {
    return { state: 'invalid-input', revision: session.revision + 1, fields: ['selections'] };
  }
  const required = session.result.unresolved;
  if (selections.length !== required.length || selections.some(selection => {
    const pending = session.pending.get(selection.candidateRef);
    return !pending || pending.seedIndex !== selection.seedIndex ||
      !required.some(r => r.seedIndex === selection.seedIndex && r.options.some(o => o.ref === selection.candidateRef));
  })) return { state: 'invalid-input', revision: session.revision + 1, fields: ['selections'] };
  const entities = [...(session.resolved?.entities ?? [])];
  for (const selection of selections) entities.push(session.pending.get(selection.candidateRef)!.seed);
  session.resolved = { entities };
  session.pending.clear();
  return continueConcierge(session.brief, session, undefined, signal);
}
