import 'server-only';
import { randomBytes } from 'node:crypto';
import type { VenueCard } from '../../contracts/concierge';
import type { ModelSelection, PracticalFixture } from '../../contracts/server';
import { fixtureOption } from '../practical/resolve';
import { renderModelInterpretation } from './interpretation';

export function baselineCards(selections: readonly ModelSelection[], fixtures: readonly PracticalFixture[], retrievedAt: string): VenueCard[] {
  return selections.map(selection => {
    const fixture = fixtures.find(f => f.fixtureId === selection.fixtureRef)!;
    return { ref: randomBytes(32).toString('hex'), name: fixture.name, category: selection.category, source: 'generic-llm',
      interpretation: renderModelInterpretation(selection.reasonCodes, 'generic-llm'), retrievedAt,
      practicalFacts: fixtureOption(fixture).practicalFacts,
      limitations: ['Generic LLM suggestion, without Qloo ranking.', 'City, category and coordinates are source-reported.',
        'Hours, prices, allergy safety, availability and current operation are unknown.'] };
  });
}
