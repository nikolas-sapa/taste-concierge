import 'server-only';
import { randomBytes } from 'node:crypto';
import type { SessionState } from '../../contracts/server';

export type BeginResult =
  | { status: 'admitted'; fence: string; state: SessionState }
  | { status: 'missing' | 'stale' | 'busy' | 'invalid-initial' };

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private creations: number[] = [];
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly ttlMs: number;

  constructor(options: { maxSessions?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxSessions = options.maxSessions ?? 200;
    this.ttlMs = options.ttlMs ?? 1_800_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 200 ||
      !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 1_800_000) {
      throw new Error('Invalid session limits');
    }
  }

  private expire(): void {
    const now = this.now();
    for (const [ref, state] of this.sessions) if (state.expiresAt <= now) this.sessions.delete(ref);
    this.creations = this.creations.filter(at => at > now - 60_000);
  }

  create(): { ref: string; state: SessionState } | null {
    this.expire();
    if (this.sessions.size >= this.maxSessions || this.creations.length >= 20) return null;
    const ref = randomBytes(32).toString('hex');
    const state: SessionState = { revision: 0, brief: null, resolved: null,
      pending: new Map(), venues: new Map(), result: null,
      expiresAt: this.now() + this.ttlMs, operationFence: null };
    this.sessions.set(ref, state);
    this.creations.push(this.now());
    return { ref, state: structuredClone(state) };
  }

  get(ref: string): SessionState | null {
    this.expire();
    const state = this.sessions.get(ref);
    if (!state) return null;
    state.expiresAt = this.now() + this.ttlMs;
    return structuredClone(state);
  }

  begin(ref: string, revision: number, mode: 'initialize' | 'update' | 'select' = 'update'): BeginResult {
    this.expire();
    const state = this.sessions.get(ref);
    if (!state) return { status: 'missing' };
    if (state.operationFence) return { status: 'busy' };
    if (!Number.isInteger(revision) || revision !== state.revision) return { status: 'stale' };
    if (mode === 'initialize' && (state.revision !== 0 || state.brief !== null || state.result !== null)) {
      return { status: 'invalid-initial' };
    }
    const fence = randomBytes(32).toString('hex');
    state.operationFence = fence;
    state.expiresAt = this.now() + this.ttlMs;
    return { status: 'admitted', fence, state: structuredClone(state) };
  }

  commit(ref: string, fence: string, expectedRevision: number, next: SessionState): boolean {
    this.expire();
    const state = this.sessions.get(ref);
    if (!state || state.operationFence !== fence || state.revision !== expectedRevision ||
      next.operationFence !== fence) return false;
    const committed = structuredClone(next);
    committed.revision = expectedRevision + 1;
    if (committed.result && 'revision' in committed.result) committed.result.revision = committed.revision;
    committed.operationFence = null;
    committed.expiresAt = this.now() + this.ttlMs;
    this.sessions.set(ref, committed);
    return true;
  }

  finish(ref: string, fence: string): void {
    const state = this.sessions.get(ref);
    if (state?.operationFence === fence) state.operationFence = null;
  }
}
