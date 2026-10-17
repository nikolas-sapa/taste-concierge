import type { BaselineResult, VenueCard } from '../contracts/concierge';

const disclosure = 'Generic AI selects from 39 independently sourced venues. Taste match additionally uses Qloo candidates and Qloo-reported location and category. Candidate pools differ; this comparison does not isolate affinity ranking.';

export default function Comparison({ baseline }: { baseline: BaselineResult }) {
  if (baseline.status === 'unavailable') return <section className="tc-comparison" aria-labelledby="tc-comparison-title"><p className="tc-eyebrow">A separate perspective</p><h2 id="tc-comparison-title">Generic AI comparison</h2><p className="tc-muted">This comparison is currently unavailable. {disclosure}</p></section>;
  return <section className="tc-comparison" aria-labelledby="tc-comparison-title"><div className="tc-comparison-heading"><div><p className="tc-eyebrow">A separate perspective</p><h2 id="tc-comparison-title">Generic AI comparison</h2></div><span className="tc-model-label">{baseline.model}</span></div><p className="tc-muted">{disclosure}</p><div className="tc-baseline-list">{baseline.items.map((item: VenueCard) => <article className="tc-baseline-item" key={item.ref}><span>{item.category === 'dining' ? 'Dining' : 'Attractions'}</span><strong>{item.name}</strong><small>{item.interpretation}</small>{item.limitations.length > 0 && <small>{item.limitations.join(' ')}</small>}</article>)}</div></section>;
}
