import type { Brief, Category, ConciergeResult, Coordinate, SeedKind } from './concierge';
export type EvidenceRef = { privateRef: string; digest: string; retrievedAt: string };
export type ResolvedSeed = { seedIndex: number; kind: SeedKind;
  qlooEntityId: string; name: string; evidence: EvidenceRef };
export type ResolvedInputs = { entities: ResolvedSeed[] };
export type PracticalFixture = {
  fixtureId: string; sourceEntityId: string; name: string;
  coordinates: Coordinate | null; category: Category | null;
  cityId: 'athens' | null; sourceUrl: string; sourceRevision: string | null;
  retrievedAt: string | null; license: 'CC0' | 'ODbL-1.0';
  verification: 'source-reported' | 'unknown' | 'conflicting';
};
export type InternalCandidate = {
  qlooEntityId: string; name: string; category: Category;
  evidence: EvidenceRef; fixtureId: string | null; qlooRank?: number;
};
export type RecommendationBatch = {
  byCategory: Record<Category, InternalCandidate[]>;
};
export type ConstraintDecision =
  | { status: 'valid'; byCategory: Record<Category, InternalCandidate[]> }
  | { status: 'none'; reasons: string[] };
export type SessionState = {
  revision: number; brief: Brief | null; resolved: ResolvedInputs | null;
  pending: Map<string, { seedIndex: number; seed: ResolvedSeed }>;
  venues: Map<string, InternalCandidate>; result: ConciergeResult | null;
  expiresAt: number; operationFence: string | null;
};
export type ModelReasonCode = 'stated-preference' | 'source-category' | 'within-radius' | 'qloo-rank';
export type ModelSelection = { fixtureRef: string; category: Category;
  role: 'primary' | 'alternative'; order: 1 | 2 | 3 | 4; reasonCodes: ModelReasonCode[] };
