import 'server-only';
export const MODEL_SNAPSHOT = 'gpt-5.4-mini-2026-03-17';
export const PRICING_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.4-mini';
// Official pricing verified October 14, 2026: uncached input $0.75/M, output $4.50/M.
// 400,000 input tokens + 1,024 output tokens, with 10% regional uplift, rounded up to cents.
// Conservative allocation, NOT actual billing. Requires separately authorized private policy.
export const MODEL_RESERVATION_MICROS = 340_000;
export const COMMON_REASONS = ['stated-preference', 'source-category', 'within-radius'] as const;
export const TREATMENT_REASONS = [...COMMON_REASONS, 'qloo-rank'] as const;
