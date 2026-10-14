import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Profile = { id: string; brief: { cityId: string; seeds: unknown[]; constraints: { radiusMeters: number } }; categories: string[] };
type Cases = {
  constraints: { id: string }[];
  realJourneys: { id: string }[];
  preferenceEdits: { id: string }[];
  outages: { id: string }[];
  anonymousJourneys: { id: string }[];
  ablation: { profiles: string[]; minimumImprovementRequired: number; randomizationClaim: boolean };
};

type Target = {
  id: string;
  requiredCases: number;
  observedCases: number;
  passedCases: number;
  failedCases: number;
  blockedCases: number;
  status: 'blocked';
  reason: string;
};

export type PublicSummary = {
  schemaVersion: 1;
  mode: 'offline-preflight';
  acceptance: {
    passedTargets: 0;
    totalTargets: 7;
    executedTargets: 0;
    targets: Target[];
  };
  statement: string;
};

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T;
}

export function loadProtocol() {
  const profiles = readJson<{ profileCount: number; profiles: Profile[] }>(new URL('./profiles.json', import.meta.url));
  const cases = readJson<Cases>(new URL('./cases.json', import.meta.url));
  const rubric = readJson<{ minimumImprovementRequired: number; minimumIndependentHumanEvaluators: number; missingOutputRating: null; randomizationClaim: boolean }>(new URL('./rubric.json', import.meta.url));

  if (profiles.profileCount !== 10 || profiles.profiles.length !== 10) {
    throw new Error('Frozen evaluation protocol must contain exactly ten profiles');
  }
  if (new Set(profiles.profiles.map((profile) => profile.id)).size !== 10) {
    throw new Error('Frozen evaluation profile IDs must be unique');
  }
  const exactIds = (items: { id: string }[], prefix: string, count: number) => {
    if (items.length !== count || new Set(items.map((item) => item.id)).size !== count) {
      throw new Error(`Frozen protocol must contain ${count} unique ${prefix} cases`);
    }
    if (items.some((item) => !item.id.startsWith(prefix))) throw new Error(`Invalid ${prefix} case ID`);
  };
  exactIds(cases.constraints, 'C', 20);
  exactIds(cases.realJourneys, 'R', 3);
  exactIds(cases.preferenceEdits, 'E', 5);
  exactIds(cases.outages, 'O', 5);
  exactIds(cases.anonymousJourneys, 'J', 5);
  if (cases.ablation.profiles.length !== 10 || rubric.minimumImprovementRequired !== 0
    || rubric.minimumIndependentHumanEvaluators !== 1 || rubric.missingOutputRating !== null
    || rubric.randomizationClaim !== false || cases.ablation.randomizationClaim !== false) {
    throw new Error('Ablation protocol or rubric changed from its frozen criteria');
  }
  return { profiles, cases, rubric };
}

/**
 * Offline mode validates frozen public definitions only. It never reads private evidence,
 * contacts external services, invents observations, or treats unit tests as acceptance.
 */
export function buildBlockedSummary(): PublicSummary {
  const { profiles, cases, rubric } = loadProtocol();
  const target = (id: string, requiredCases: number, reason: string): Target => ({
    id,
    requiredCases,
    observedCases: 0,
    passedCases: 0,
    failedCases: 0,
    blockedCases: requiredCases,
    status: 'blocked',
    reason,
  });
  const targets = [
    target('T1', profiles.profileCount, 'Missing verified live Qloo profile receipts and private response linkage.'),
    target('T2', cases.constraints.length, 'Missing frozen real-response candidate bindings and expected/actual private decisions.'),
    target('T3', cases.realJourneys.length, 'Missing real application journey receipts for both categories.'),
    target('T4', cases.ablation.profiles.length, 'Missing paired treatment/baseline outputs, shared-pool proof, and independent human ratings.'),
    target('T5', cases.preferenceEdits.length, 'Missing before/after application state and dependency receipts.'),
    target('T6', cases.anonymousJourneys.length, 'Missing frozen published release and anonymous browser-session receipts.'),
    target('T7', cases.outages.length, 'Missing labeled fault-injection receipts and safe-output assertions.'),
  ];
  if (rubric.minimumIndependentHumanEvaluators !== 1 || rubric.missingOutputRating !== null) {
    throw new Error('Ablation ratings must remain incomplete until independent ratings exist');
  }
  return {
    schemaVersion: 1,
    mode: 'offline-preflight',
    acceptance: {
      passedTargets: 0,
      totalTargets: 7,
      executedTargets: 0,
      targets,
    },
    statement: 'Preflight only. All seven acceptance targets are blocked for missing evidence; none were executed or assessed as failed. Unit-test results are separate and do not count as acceptance.',
  };
}
