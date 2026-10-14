import type { Brief, Seed } from '../contracts/concierge';
import { Button, Input } from './Controls';

type Props = {
  brief: Brief;
  busy: boolean;
  onChange: (brief: Brief) => void;
  onSubmit: () => void;
  onAddSeed: () => void;
  onRemoveSeed: (index: number) => void;
};

export default function Preferences({ brief, busy, onChange, onSubmit, onAddSeed, onRemoveSeed }: Props) {
  const updateSeed = (index: number, patch: Partial<Seed>) => {
    const seeds = brief.seeds.map((seed, i) => i === index ? { ...seed, ...patch } : seed);
    onChange({ ...brief, seeds });
  };

  return (
    <form className="tc-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <fieldset disabled={busy}>
        <legend className="tc-eyebrow">01 / Your references</legend>
        <p className="tc-field-note">Films, artists, or places that shape your taste.</p>
        <div className="tc-seeds">
          {brief.seeds.map((seed, index) => (
            <div className="tc-seed-row" key={index}>
              <label className="tc-field tc-kind">
                <span>Type</span>
                <select aria-label={`Reference ${index + 1} type`} value={seed.kind} onChange={(event) => updateSeed(index, { kind: event.target.value as Seed['kind'] })}>
                  <option value="movie">Film</option><option value="artist">Artist</option><option value="place">Place</option>
                </select>
              </label>
              <label className="tc-field tc-seed-text">
                <span>Reference {index + 1}</span>
                <Input aria-label={`Reference ${index + 1}`} maxLength={120} required value={seed.text} onChange={(event) => updateSeed(index, { text: event.target.value })} />
              </label>
              {brief.seeds.length > 1 && <Button variant="quiet" type="button" className="tc-icon-button" aria-label={`Remove reference ${index + 1}`} onClick={() => onRemoveSeed(index)}>Remove</Button>}
            </div>
          ))}
        </div>
        {brief.seeds.length < 3 && <Button variant="text" type="button" className="tc-text-button" onClick={onAddSeed}>＋ Add another reference</Button>}
      </fieldset>

      <div className="tc-preference-grid">
        <label className="tc-field">
          <span className="tc-eyebrow">02 / Dining</span>
          <textarea aria-label="Dining preference" maxLength={120} rows={3} value={brief.diningPreference} onChange={(event) => onChange({ ...brief, diningPreference: event.target.value })} disabled={busy} />
          <small>What kind of meal fits your mood?</small>
        </label>
        <label className="tc-field">
          <span className="tc-eyebrow">03 / Attractions</span>
          <textarea aria-label="Attraction preference" maxLength={120} rows={3} value={brief.attractionPreference} onChange={(event) => onChange({ ...brief, attractionPreference: event.target.value })} disabled={busy} />
          <small>What would you like to experience?</small>
        </label>
      </div>

      <label className="tc-field tc-radius">
        <span className="tc-eyebrow">04 / Distance from Athens centre</span>
        <div className="tc-radius-control"><Input aria-label="Maximum distance in metres" type="number" min={0} max={5000} step={100} value={brief.constraints.radiusMeters} onChange={(event) => onChange({ ...brief, constraints: { ...brief.constraints, radiusMeters: Number(event.target.value) } })} disabled={busy} /><span>metres</span></div>
      </label>
      <div className="tc-form-footer">
        <p>Recommendations use sourced location and category details. Opening hours, prices, and availability are not verified.</p>
        <Button type="submit" disabled={busy}>{busy ? 'Finding places…' : 'Find my places'}<span aria-hidden="true">↗</span></Button>
      </div>
    </form>
  );
}
