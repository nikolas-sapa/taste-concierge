'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Brief, ConciergeResult, Selection } from '../contracts/concierge';
import { validateBrief } from '../server/input/validate';
import Comparison from './Comparison';
import { Button } from './Controls';
import EntityChoice from './EntityChoice';
import Itinerary from './Itinerary';
import Preferences from './Preferences';
import Status from './Status';
import './concierge.css';

const initialBrief: Brief = {
  cityId: 'athens',
  seeds: [{ kind: 'movie', text: 'Spirited Away' }],
  diningPreference: 'Thoughtful, relaxed dining',
  attractionPreference: 'Quiet places with a sense of wonder',
  constraints: { radiusMeters: 2500, excludedVenueRefs: [] },
};
type Bootstrap = { revision: number; brief: Brief | null; result: ConciergeResult | null };
type ApiError = { error?: string };

function savedBrief(): Brief {
  try {
    const value = sessionStorage.getItem('taste-concierge-brief');
    if (!value) return initialBrief;
    const checked = validateBrief(JSON.parse(value) as unknown);
    if (checked.ok) return checked.brief;
  } catch { /* retain the default brief if browser storage is unavailable */ }
  return initialBrief;
}

function errorMessage(status: number, payload: unknown): string {
  const code = payload && typeof payload === 'object' && 'error' in payload ? (payload as ApiError).error : '';
  if (code === 'busy') return 'A request is already running for this session. Please wait, then reload the session.';
  if (code === 'session-expired' || status === 401 || status === 410) return 'Your session expired. Reload it to continue.';
  if (code === 'stale-revision' || status === 409) return 'Your session changed in another request. Reload the latest session before continuing.';
  if (status === 429) return 'Too many requests right now. Please try again later.';
  if (status >= 500) return 'The recommendation service could not complete this request.';
  return 'We could not process that request. Review your preferences and try again.';
}

async function receiveResult(response: Response): Promise<ConciergeResult> {
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error(errorMessage(response.status, null)); }
  if (payload && typeof payload === 'object' && 'state' in payload) return payload as ConciergeResult;
  throw new Error(errorMessage(response.status, payload));
}

async function readError(response: Response): Promise<string> {
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  return errorMessage(response.status, payload);
}

function committed(result: ConciergeResult): boolean {
  return result.revision > 0 && ['ready', 'needs-disambiguation', 'no-valid-result'].includes(result.state);
}

export default function Concierge() {
  const [brief, setBrief] = useState<Brief>(initialBrief);
  const [result, setResult] = useState<ConciergeResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [busy, setBusy] = useState(false);
  const initialBootstrapStarted = useRef(false);
  const updateBrief = (next: Brief) => {
    setBrief(next);
    try { sessionStorage.setItem('taste-concierge-brief', JSON.stringify(next)); } catch { /* optional convenience only */ }
  };

  const bootstrap = useCallback(async (resume = false) => {
    setBusy(true); setError(null); setPhase('loading');
    try {
      const healthResponse = await fetch('/api/health', { cache: 'no-store' });
      if (!healthResponse.ok) throw new Error(await readError(healthResponse));
      const health = await healthResponse.json() as { status: 'ready' | 'unconfigured' };
      if (health.status === 'unconfigured') { setPhase('unconfigured'); setResult(null); setInitialized(false); return; }
      const response = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(await readError(response));
      const session = await response.json() as Bootstrap;
      const checked = session.brief === null ? null : validateBrief(session.brief);
      if (checked && !checked.ok) throw new Error('Your session could not be restored. Reload it to continue.');
      const nextBrief = checked?.ok ? checked.brief : savedBrief();
      setInitialized(session.brief !== null);
      setBrief(nextBrief);
      setRevision(session.revision); setResult(session.result); setPhase('ready');
      if (!resume && session.result === null) await runInitial(session.revision, nextBrief);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The service could not be reached.'); setRetryable(true); setPhase('error');
    } finally { setBusy(false); }
  }, []);

  const runInitial = useCallback(async (expectedRevision: number, nextBrief: Brief) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/concierge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: expectedRevision, brief: nextBrief }) });
      const next = await receiveResult(response);
      setResult(next); setRevision(next.revision);
      if (committed(next)) setInitialized(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); setRetryable(true); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    if (initialBootstrapStarted.current) return;
    initialBootstrapStarted.current = true;
    void bootstrap();
  }, [bootstrap]);

  const submitPreferences = async () => {
    if (busy) return;
    if (!initialized) { await runInitial(revision, brief); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, brief }) });
      const next = await receiveResult(response);
      setResult(next); setRevision(next.revision);
      if (committed(next)) setInitialized(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Request failed.'; setError(message); setRetryable(/session expired|session changed|already running/i.test(message)); }
    finally { setBusy(false); }
  };

  const chooseEntities = async (selections: Selection[]) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, selections }) });
      const next = await receiveResult(response);
      setResult(next); setRevision(next.revision);
      if (committed(next)) setInitialized(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Request failed.'; setError(message); setRetryable(/session expired|session changed|already running/i.test(message)); }
    finally { setBusy(false); }
  };

  return <main className="tc-shell">
    <header className="tc-topbar"><a className="tc-wordmark" href="/" aria-label="Taste Concierge home"><span className="tc-mark" aria-hidden="true">T</span>taste concierge</a><span className="tc-location"><span className="tc-location-dot" />Athens, Greece</span></header>
    <section className="tc-intro"><div className="tc-intro-copy"><p className="tc-eyebrow">A personal guide to the city</p><h1>Find places that<br />feel like <em>you.</em></h1><p>Start with the stories, artists, and places you love. We’ll use them to shape a thoughtful day in Athens.</p></div><div className="tc-intro-index" aria-hidden="true"><span>ATH</span><span>37°58′N<br />23°43′E</span></div></section>
    <div className="tc-main-grid"><aside className="tc-sidebar"><p className="tc-sidebar-number">01—04</p><p>Tell us what you’re drawn to. We’ll look for dining and places to explore within your chosen distance.</p><div className="tc-data-note"><span className="tc-data-mark" aria-hidden="true">i</span><p>No account needed. Your session stays in this browser and expires after inactivity.</p></div></aside>
      <div className="tc-workspace">
        {phase === 'loading' && <div className="tc-empty-state" role="status"><span className="tc-loader" />Checking recommendation service…</div>}
        {phase === 'unconfigured' && <Status result={{ state: 'service-unavailable', revision, reason: 'configuration', retryable: false }} error={null} onRetry={() => void bootstrap(true)} />}
        {phase === 'error' && <Status result={null} error={error} retryable={retryable} onRetry={() => void bootstrap(true)} />}
        {phase === 'ready' && <>
          <Preferences brief={brief} busy={busy} onChange={updateBrief} onSubmit={submitPreferences} onAddSeed={() => updateBrief({ ...brief, seeds: [...brief.seeds, { kind: 'artist', text: '' }] })} onRemoveSeed={(index) => updateBrief({ ...brief, seeds: brief.seeds.filter((_, i) => i !== index) })} />
          <Status result={result} error={error} retryable={retryable || (result?.state === 'service-unavailable' && result.retryable)} onRetry={() => {
            const recoverSession = /session expired|session changed|already running/i.test(error ?? '');
            if (recoverSession) void bootstrap(true);
            else if (!initialized) void runInitial(revision, brief);
            else void submitPreferences();
          }} />
          {result?.state === 'needs-disambiguation' && <EntityChoice key={`${result.revision}:${result.unresolved.flatMap(item => item.options.map(option => option.ref)).join(',')}`} unresolved={result.unresolved} busy={busy} onChoose={chooseEntities} />}
          {result?.state === 'ready' && <><Itinerary items={result.items} /><Comparison baseline={result.baseline} /></>}
        </>}
      </div>
    </div>
    <footer className="tc-footer"><span>Taste Concierge</span><span>Independent source details shown with each place. Always confirm before visiting.</span><span>ATHENS · 2026</span></footer>
  </main>;
}
