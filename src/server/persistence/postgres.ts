import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { SessionState } from '../../contracts/server';
import type { BeginResult } from '../session/store';
import { isRecord, isRevision } from '../input/validate';
import { decodeSessionEnvelope, encodeSessionEnvelope } from './codec';
import type { SessionRepository } from './ports';

export class PostgresPersistenceError extends Error {
  constructor() { super('Persistent storage unavailable'); this.name = 'PostgresPersistenceError'; }
}
const token = () => randomBytes(32).toString('hex');
const isToken = (value: string) => /^[a-f0-9]{64}$/.test(value);
const hash = (value: string) => `\\x${createHash('sha256').update(value).digest('hex')}`;
function executor(databaseUrl: string) {
  let sql: NeonQueryFunction<false, false>;
  try { sql = neon(databaseUrl); } catch { throw new PostgresPersistenceError(); }
  return async (statement: string, params: unknown[]): Promise<unknown> => {
    try {
      const rows = await sql.query(statement, params, { fetchOptions: { signal: AbortSignal.timeout(5_000) } });
      if (rows.length !== 1 || !Object.hasOwn(rows[0], 'value')) throw new PostgresPersistenceError();
      return rows[0].value;
    } catch { throw new PostgresPersistenceError(); }
  };
}
export function createPostgresSessionRepository(databaseUrl: string, schema = 'taste_runtime'): SessionRepository {
  if (!/^taste_runtime(?:_test_[a-f0-9]+)?$/.test(schema)) throw new PostgresPersistenceError();
  const execute = executor(databaseUrl);
  async function outcome(statement: string, params: unknown[]): Promise<Record<string, unknown>> {
    const value = await execute(statement, params);
    if (!isRecord(value) || typeof value.status !== 'string') throw new PostgresPersistenceError();
    return value;
  }
  return {
    async create() {
      const ref = token();
      const initial: SessionState = { revision: 0, brief: null, resolved: null, pending: new Map(),
        venues: new Map(), result: null, expiresAt: 1, operationFence: null };
      const value = await outcome(`SELECT ${schema}.session_create($1::bytea,$2::jsonb) AS value`, [hash(ref), encodeSessionEnvelope(initial)]);
      if (value.status === 'capacity') return null;
      if (value.status !== 'created') throw new PostgresPersistenceError();
      return { ref, state: decodeSessionEnvelope(value.envelope) };
    },
    async get(ref) {
      if (!isToken(ref)) return null;
      const value = await outcome(`SELECT ${schema}.session_get($1::bytea) AS value`, [hash(ref)]);
      if (value.status === 'missing') return null;
      if (value.status !== 'found') throw new PostgresPersistenceError();
      return decodeSessionEnvelope(value.envelope);
    },
    async begin(ref, revision, mode = 'update', leaseMs = 90_000): Promise<BeginResult> {
      if (!isToken(ref)) return { status: 'missing' };
      if (!isRevision(revision)) return { status: 'stale' };
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 90_000) throw new PostgresPersistenceError();
      const value = await outcome(`SELECT ${schema}.session_begin($1::bytea,$2::bigint,$3::text,$4::text,$5::integer) AS value`, [hash(ref), revision, mode, token(), leaseMs]);
      if (value.status === 'admitted' && typeof value.fence === 'string' && isToken(value.fence)) {
        return { status: 'admitted', fence: value.fence, state: decodeSessionEnvelope(value.envelope) };
      }
      if (value.status === 'missing' || value.status === 'stale' || value.status === 'busy' || value.status === 'invalid-initial') return { status: value.status };
      throw new PostgresPersistenceError();
    },
    async commit(ref, fence, expectedRevision, next) {
      if (!isToken(ref) || !isToken(fence) || !isRevision(expectedRevision) || next.operationFence !== fence) return false;
      const result = await execute(`SELECT ${schema}.session_commit($1::bytea,$2::text,$3::bigint,$4::jsonb) AS value`,
        [hash(ref), fence, expectedRevision, encodeSessionEnvelope(next)]);
      if (typeof result !== 'boolean') throw new PostgresPersistenceError();
      return result;
    },
    async finish(ref, fence) {
      if (!isToken(ref) || !isToken(fence)) return;
      await execute(`SELECT ${schema}.session_finish($1::bytea,$2::text) AS value`, [hash(ref), fence]);
    },
  };
}
export function createPostgresBodyLimiter(databaseUrl: string): {
  acquire(): Promise<string | null>; release(id: string): Promise<void>;
} {
  const execute = executor(databaseUrl);
  return {
    async acquire() {
      const id = token();
      const admitted = await execute('SELECT taste_runtime.body_acquire($1::text) AS value', [id]);
      if (typeof admitted !== 'boolean') throw new PostgresPersistenceError();
      return admitted ? id : null;
    },
    async release(id) {
      if (!isToken(id)) return;
      await execute('SELECT taste_runtime.body_release($1::text) AS value', [id]);
    },
  };
}
export async function postgresRuntimeReady(databaseUrl: string): Promise<boolean> {
  try { return await executor(databaseUrl)('SELECT taste_runtime.health() AS value', []) === true; }
  catch { return false; }
}
