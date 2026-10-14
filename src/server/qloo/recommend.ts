import 'server-only';
import type { Brief, Category } from '../../contracts/concierge';
import type { RecommendationBatch, ResolvedInputs } from '../../contracts/server';
import type { QlooClient } from './client';
import { normalizeRecommendations, type FixtureBinding } from './normalize';

export async function recommendWithClient(inputs: ResolvedInputs, brief: Brief, client: QlooClient,
  bindings: readonly FixtureBinding[], categories: readonly Category[] = ['dining', 'attractions']): Promise<RecommendationBatch> {
  const byCategory: RecommendationBatch['byCategory'] = { dining: [], attractions: [] };
  for (const category of categories) {
    const captured = await client.recommend(inputs, category, brief.constraints.radiusMeters);
    byCategory[category] = normalizeRecommendations(captured.body, category, brief.constraints.radiusMeters,
      client.payloadPolicy(), captured.evidence, bindings);
  }
  return { byCategory };
}
