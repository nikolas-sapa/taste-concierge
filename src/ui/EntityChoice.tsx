import type { CandidateOption, Selection } from '../contracts/concierge';
import { Button } from './Controls';

type Props = { unresolved: { seedIndex: number; options: CandidateOption[] }[]; busy: boolean; onChoose: (selections: Selection[]) => void };

export default function EntityChoice({ unresolved, busy, onChoose }: Props) {
  const [selected, setSelected] = React.useState<Record<number, string>>({});
  const allChosen = unresolved.every(({ seedIndex, options }) => options.some(option => option.ref === selected[seedIndex]));
  return <section className="tc-choice" aria-labelledby="tc-choice-title">
    <p className="tc-eyebrow">A quick clarification</p>
    <h2 id="tc-choice-title">Which reference did you mean?</h2>
    <p>We found more than one possible match. Choose one for each reference to continue.</p>
    {unresolved.map(({ seedIndex, options }) => <fieldset className="tc-choice-set" key={seedIndex}>
      <legend>Reference {seedIndex + 1}</legend>
      {options.map((option) => <label className="tc-choice-option" key={option.ref}>
        <input type="radio" name={`seed-${seedIndex}`} value={option.ref} checked={selected[seedIndex] === option.ref} onChange={() => setSelected((current) => ({ ...current, [seedIndex]: option.ref }))} />
        <span><strong>{option.name}</strong>{option.disambiguation && <small>{option.disambiguation}</small>}</span>
      </label>)}
    </fieldset>)}
    <Button disabled={busy || !allChosen} onClick={() => onChoose(unresolved.map(({ seedIndex }) => ({ seedIndex, candidateRef: selected[seedIndex] })))}>Continue with these references <span aria-hidden="true">↗</span></Button>
  </section>;
}

import * as React from 'react';
