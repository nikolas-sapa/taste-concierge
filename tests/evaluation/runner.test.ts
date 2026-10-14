import { describe, expect, it } from 'vitest';
import { buildBlockedSummary, loadProtocol } from '../../evaluation/runner';

describe('offline acceptance preflight', () => {
  it('loads the frozen numerical case set and ten profiles', () => {
    const { profiles, cases } = loadProtocol();
    expect(profiles.profiles.map((profile) => profile.id)).toEqual([
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
    ]);
    expect(cases.constraints).toHaveLength(20);
    expect(cases.realJourneys).toHaveLength(3);
    expect(cases.preferenceEdits).toHaveLength(5);
    expect(cases.outages).toHaveLength(5);
    expect(cases.anonymousJourneys).toHaveLength(5);
  });

  it('marks missing proof blocked, not failed or passed', () => {
    const summary = buildBlockedSummary();
    expect(summary.mode).toBe('offline-preflight');
    expect(summary.acceptance).toMatchObject({ passedTargets: 0, totalTargets: 7, executedTargets: 0 });
    expect(summary.acceptance.targets.map((target) => target.id)).toEqual([
      'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7',
    ]);
    for (const target of summary.acceptance.targets) {
      expect(target.status).toBe('blocked');
      expect(target.observedCases).toBe(0);
      expect(target.passedCases).toBe(0);
      expect(target.failedCases).toBe(0);
      expect(target.blockedCases).toBe(target.requiredCases);
    }
  });

  it('keeps T4 blocked when paired runs and independent ratings are absent', () => {
    const summary = buildBlockedSummary();
    const t4 = summary.acceptance.targets.find((target) => target.id === 'T4');
    expect(t4).toMatchObject({ requiredCases: 10, observedCases: 0, blockedCases: 10, status: 'blocked' });
    expect(t4?.reason).toContain('independent human ratings');
  });
});
