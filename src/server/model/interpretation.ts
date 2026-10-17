import 'server-only';
import type { PracticalFact } from '../../contracts/concierge';
import type { ModelReasonCode } from '../../contracts/server';

const templates: Record<ModelReasonCode, string> = {
  'stated-preference': 'The model considered your stated preferences. This interpretation is not a venue guarantee.',
  'source-category': 'An independent source reports this venue category.',
  'within-radius': 'Independent coordinates satisfy the requested straight-line radius.',
  'qloo-rank': 'Actual Qloo recommendation order contributed to selection. Aggregate affinity is not individual probability.',
};

export function renderModelInterpretation(reasons: readonly ModelReasonCode[], source: 'qloo' | 'generic-llm', facts?: readonly PracticalFact[]): string {
  const text = { ...templates };
  if (facts?.some(f => f.field === 'category' && f.source === 'qloo')) text['source-category'] = 'Qloo reports this venue category, not independently verified.';
  if (facts?.some(f => f.field === 'coordinates' && f.source === 'qloo')) text['within-radius'] = 'Qloo-reported coordinates satisfy the requested straight-line radius, not independently verified.';
  return reasons.filter(reason => source === 'qloo' || reason !== 'qloo-rank').map(reason => text[reason]).join(' ') ||
    (source === 'qloo' ? 'Model selection uses actual Qloo candidates and source-labeled practical facts.' : 'Generic model suggestion using independent facts.');
}
