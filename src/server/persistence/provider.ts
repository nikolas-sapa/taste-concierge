import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { validateCloudPolicy, type ExecutionPolicy } from '../admission/application-policy';
import type { CaptureData, QlooAdmission } from '../qloo/client';
import type { EvidenceRef } from '../../contracts/server';
import { QlooError } from '../qloo/errors';

type RpcResult = { status: string; policy?: unknown; id?: string; chargedAt?: number; waitMs?: number; rows?: unknown[] };
export type ProviderOperation = { tokenHash: string; fence: string; revision: number };
const configuration = () => new QlooError('configuration');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class ProviderRepository implements QlooAdmission {
  private readonly sql;
  private expectedPolicy?: string;
  constructor(databaseUrl: string, private readonly schema = 'taste_runtime',
    private readonly operation: () => ProviderOperation | undefined = () => undefined) {
    if (!databaseUrl || !/^taste_runtime(?:_test_[a-f0-9]+)?$/.test(schema)) throw configuration();
    try { this.sql = neon(databaseUrl); } catch { throw configuration(); }
  }

  async rpc(action: string, ref = '', payload: unknown = {}): Promise<RpcResult> {
    try {
      const rows = await this.sql.query(`select ${this.schema}.provider_action($1, $2, $3::jsonb) as result`,
        [action, ref, JSON.stringify(payload)], { fetchOptions: { signal: AbortSignal.timeout(5000) } });
      const result: unknown = rows[0]?.result;
      if (!object(result) || typeof result.status !== 'string') throw configuration();
      return result as RpcResult;
    } catch { throw configuration(); }
  }

  async readPolicy(): Promise<ExecutionPolicy> {
    const result = await this.rpc('read');
    if (result.status !== 'ok') throw configuration();
    // Keep exact policy for change detection. SQL independently enforces the stricter local 5s gap.
    return validateCloudPolicy(result.policy);
  }

  async initialize(): Promise<ExecutionPolicy> {
    const policy = await this.readPolicy();
    this.expectedPolicy = JSON.stringify(policy);
    return policy;
  }

  private async checkedPolicy(): Promise<void> {
    const current = await this.readPolicy();
    if (!this.expectedPolicy || JSON.stringify(current) !== this.expectedPolicy) throw configuration();
  }

  async isReady(): Promise<boolean> {
    try { await this.checkedPolicy(); return true; } catch { return false; }
  }

  async reserve(count = 5): Promise<string> {
    await this.checkedPolicy();
    const operation = this.operation();
    if (!operation || !/^[a-f0-9]{64}$/.test(operation.tokenHash) || !/^[a-f0-9]{64}$/.test(operation.fence) ||
      !Number.isSafeInteger(operation.revision) || operation.revision < 0) throw configuration();
    const id = randomBytes(32).toString('hex');
    const result = await this.rpc('reserve', id, { count, ...operation });
    if (result.status === 'limited') throw new QlooError('rate-limit');
    if (result.status !== 'ok') throw configuration();
    return id;
  }

  async charge(reservation: string, signal?: AbortSignal): Promise<{ id: string; chargedAt: number }> {
    const id = randomBytes(32).toString('hex');
    for (;;) {
      if (signal?.aborted) throw new QlooError('timeout');
      await this.checkedPolicy();
      const result = await this.rpc('charge', id, { reservation });
      if (result.status === 'ok' && typeof result.chargedAt === 'number') return { id, chargedAt: result.chargedAt };
      if (result.status === 'wait' && typeof result.waitMs === 'number') {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) { reject(new QlooError('timeout')); return; }
          const stop = () => { clearTimeout(timer); reject(new QlooError('timeout')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.max(25, Math.min(1000, result.waitMs!)));
          signal?.addEventListener('abort', stop, { once: true });
        });
        continue;
      }
      if (result.status === 'limited') throw new QlooError('rate-limit');
      throw configuration();
    }
  }

  async assertSendAllowed(id: string): Promise<void> {
    await this.checkedPolicy();
    if ((await this.rpc('assert', id)).status !== 'ok') throw configuration();
  }
  async completeSend(id: string, uncertain: boolean): Promise<void> {
    if ((await this.rpc('complete', id, { uncertain })).status !== 'ok') throw configuration();
  }
  async release(id: string): Promise<void> {
    if ((await this.rpc('release', id)).status !== 'ok') throw configuration();
  }
  async halt(): Promise<void> {
    if ((await this.rpc('halt')).status !== 'ok') throw configuration();
  }

  async saveEvidence(data: CaptureData, attemptId: string): Promise<EvidenceRef> {
    if (data.raw.byteLength > 2_097_152) throw configuration();
    const privateRef = `${randomBytes(32).toString('hex')}.json`;
    const digest = createHash('sha256').update(data.raw).digest('hex');
    const headers = Object.fromEntries(Object.entries(data.headers).filter(([name]) =>
      /^(?:content-type|date|retry-after|(?:x-)?(?:ratelimit|rate-limit|quota)[a-z-]*)$/i.test(name)));
    const metadata = { request: { method: 'GET', route: data.route, parameters: data.parameters,
      headerNames: ['X-Api-Key', 'Accept'] }, status: data.status, responseHeaders: headers,
    digest, retrievedAt: data.receivedAt, rawEncoding: 'base64' };
    if (Buffer.byteLength(JSON.stringify(metadata)) > 8192) throw configuration();
    const result = await this.rpc('capture', attemptId, { privateRef, digest, metadata,
      rawBody: Buffer.from(data.raw).toString('base64') });
    if (result.status !== 'ok') throw configuration();
    return { privateRef, digest, retrievedAt: data.receivedAt };
  }
}
