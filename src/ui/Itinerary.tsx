import type { Category, VenueCard } from '../contracts/concierge';

function categoryLabel(category: Category) { return category === 'dining' ? 'Dining' : 'Attractions'; }

function Venue({ venue, label }: { venue: VenueCard; label: string }) {
  return <article className="tc-venue">
    <div className="tc-venue-top"><span className="tc-eyebrow">{label}</span><span className="tc-source">{venue.source === 'qloo' ? 'Taste match' : 'Generic comparison'}</span></div>
    <h3>{venue.name}</h3>
    {venue.interpretation && <p className="tc-interpretation">{venue.interpretation}</p>}
    <dl className="tc-facts">
      {venue.practicalFacts.map((fact, index) => <div key={`${fact.field}-${index}`}><dt>{fact.field === 'city' ? 'City' : fact.field === 'category' ? 'Category' : 'Location'}</dt><dd>{fact.status === 'source-reported' ? (typeof fact.value === 'string' ? fact.value : fact.value ? `${fact.value.latitude.toFixed(4)}, ${fact.value.longitude.toFixed(4)}` : 'Unknown') : fact.status === 'conflicting' ? 'Conflicting sources' : 'Unknown'}</dd>{fact.sourceUrl && <dd><a href={fact.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>{fact.sourceRevision && <span> · revision {fact.sourceRevision}</span>}</dd>}</div>)}
    </dl>
    {venue.limitations.length > 0 && <ul className="tc-limitations">{venue.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>}
    <p className="tc-retrieved">Retrieved <time dateTime={venue.retrievedAt}>{new Date(venue.retrievedAt).toLocaleString()}</time></p>
  </article>;
}

export default function Itinerary({ items }: { items: Record<Category, { primary: VenueCard; alternative: VenueCard | null }> }) {
  return <section className="tc-itinerary" aria-labelledby="tc-itinerary-heading">
    <div className="tc-results-heading"><p className="tc-eyebrow">Your Athens shortlist</p><h2 id="tc-itinerary-heading">Places shaped by your taste</h2><p>Location and category come from independent sources. Always confirm details directly before you go.</p></div>
    <div className="tc-category-list">{(['dining', 'attractions'] as Category[]).map((category) => {
      const selection = items[category];
      return <section className="tc-category" key={category}><div className="tc-category-title"><span>{categoryLabel(category)}</span><span className="tc-category-line" /></div><div className="tc-recommendations"><Venue venue={selection.primary} label="Top match" />{selection.alternative ? <Venue venue={selection.alternative} label="Another option" /> : <div className="tc-alt-empty"><strong>No second option available</strong><p>There was not another place with enough verified practical information.</p></div>}</div></section>;
    })}</div>
  </section>;
}
