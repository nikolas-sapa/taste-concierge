import 'server-only';
import type { SessionState } from '../../contracts/server';
import { SessionStore, type BeginResult } from '../session/store';

export interface SessionRepository {
  create(): Promise<{ ref: string; state: SessionState } | null>;
  get(ref: string): Promise<SessionState | null>;
  begin(ref: string, revision: number, mode?: 'initialize' | 'update' | 'select', leaseMs?: number): Promise<BeginResult>;
  commit(ref: string, fence: string, expectedRevision: number, next: SessionState): Promise<boolean>;
  finish(ref: string, fence: string): Promise<void>;
}

export function asyncLocalSessionRepository(store = new SessionStore()): SessionRepository {
  return {
    create: async () => store.create(),
    get: async ref => store.get(ref),
    begin: async (ref, revision, mode) => store.begin(ref, revision, mode),
    commit: async (ref, fence, revision, next) => store.commit(ref, fence, revision, next),
    finish: async (ref, fence) => store.finish(ref, fence),
  };
}
