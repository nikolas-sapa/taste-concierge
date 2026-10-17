export type Category = 'dining' | 'attractions';
export type SeedKind = 'movie' | 'artist' | 'place';
export type Seed = { kind: SeedKind; text: string };
export type Coordinate = { latitude: number; longitude: number };
export type Brief = {
  cityId: 'athens';
  seeds: Seed[];
  diningPreference: string;
  attractionPreference: string;
  constraints: {
    radiusMeters: number;
    excludedVenueRefs: string[];
    maxBudgetEur?: number;
    localOpeningTime?: string;
  };
};
export type PracticalFact = {
  source: 'independent' | 'qloo';
  field: 'city' | 'category' | 'coordinates';
  value: string | Coordinate | null;
  sourceUrl: string | null;
  sourceRevision: string | null;
  retrievedAt: string | null;
  status: 'source-reported' | 'unknown' | 'conflicting';
};
export type VenueCard = {
  ref: string;
  name: string;
  category: Category;
  source: 'qloo' | 'generic-llm';
  interpretation: string;
  practicalFacts: PracticalFact[];
  limitations: string[];
  retrievedAt: string;
};
export type CandidateOption = {
  ref: string;
  name: string;
  kind: SeedKind;
  disambiguation: string | null;
};
export type BaselineResult =
  | { status: 'ready'; model: string; items: VenueCard[] }
  | { status: 'unavailable'; reason: 'model-unavailable' | 'invalid-output' };
export type ConciergeResult =
  | { state: 'needs-disambiguation'; revision: number;
      unresolved: { seedIndex: number; options: CandidateOption[] }[] }
  | { state: 'ready'; revision: number;
      items: Record<Category, { primary: VenueCard; alternative: VenueCard | null }>;
      baseline: BaselineResult }
  | { state: 'no-valid-result'; revision: number;
      reasons: ('no-entity-match' | 'no-category-coverage' | 'no-practical-match' | 'constraints-unsatisfied')[] }
  | { state: 'unsupported-constraint'; revision: number;
      fields: ('maxBudgetEur' | 'localOpeningTime')[] }
  | { state: 'service-unavailable'; revision: number;
      reason: 'configuration' | 'authentication' | 'timeout' | 'rate-limit' | 'upstream' | 'network';
      retryable: boolean }
  | { state: 'invalid-input'; revision: number; fields: string[] };
export type Selection = { seedIndex: number; candidateRef: string };
export type EditEvent = {
  changed: ('seeds' | 'diningPreference' | 'attractionPreference' | 'constraints')[];
};
