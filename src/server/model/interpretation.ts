import 'server-only';
import type { ModelReasonCode } from '../../contracts/server';

const templates: Record<ModelReasonCode, string> = {
  'stated-preference': 'The model considered your stated preferences. This interpretation is not a venue guarantee.',
  'source-category': 'An independent source reports this venue category.',
  'within-radius': 'Independent coordinates satisfy the requested straight-line radius.',
  'qloo-rank': 'Actual Qloo recommendation order contributed to selection. Aggregate affinity is not individual probability.',
};

export function renderModelInterpretation(reasons: readonly ModelReasonCode[], source: 'qloo' | 'generic-llm'): string {
  return reasons.filter(reason => source === 'qloo' || reason !== 'qloo-rank').map(reason => templates[reason]).join(' ') ||
    (source === 'qloo' ? 'Model selection uses actual Qloo candidates and independent facts.' : 'Generic model suggestion using independent facts.');
}
