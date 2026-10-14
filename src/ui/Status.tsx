import type { ConciergeResult } from '../contracts/concierge';
import { Button } from './Controls';

const reasonText: Record<string, string> = {
  'no-entity-match': 'We could not match those references.',
  'no-category-coverage': 'There is not enough coverage for both categories yet.',
  'no-practical-match': 'No places met the available location and category checks.',
  'constraints-unsatisfied': 'No places met all selected constraints.',
};

export default function Status({ result, error, retryable, onRetry }: { result: ConciergeResult | null; error: string | null; retryable?: boolean; onRetry: () => void }) {
  if (error) return <div className="tc-status tc-status-error" role="alert"><div><strong>{error}</strong>{retryable && <p>You can try again when ready.</p>}</div>{retryable && <Button variant="secondary" onClick={onRetry}>Try again</Button>}</div>;
  if (!result) return null;
  if (result.state === 'no-valid-result') return <div className="tc-status" role="status"><strong>No verified itinerary found.</strong><ul>{result.reasons.map((reason) => <li key={reason}>{reasonText[reason] ?? 'A practical check could not be completed.'}</li>)}</ul></div>;
  if (result.state === 'unsupported-constraint') return <div className="tc-status" role="status"><strong>These requirements cannot be verified yet.</strong><p>{result.fields.map((field) => field === 'maxBudgetEur' ? 'Budget' : 'Opening time').join(' and ')} data is not available, so we stopped before recommending places.</p></div>;
  if (result.state === 'invalid-input') return <div className="tc-status" role="alert"><strong>Please review your preferences.</strong><p>One or more fields could not be accepted.</p></div>;
  if (result.state === 'service-unavailable') return <div className="tc-status" role="alert"><div><strong>{result.reason === 'configuration' ? 'Service is not configured.' : 'Recommendations are temporarily unavailable.'}</strong><p>No recommendations have been generated. {result.reason === 'configuration' ? 'Please check back later.' : 'Your preferences are still here.'}</p></div>{result.retryable && <Button variant="secondary" onClick={onRetry}>Try again</Button>}</div>;
  return null;
}
