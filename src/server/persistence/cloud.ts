import 'server-only';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PracticalFixture } from '../../contracts/server';
import { createQlooClient, type QlooBackend, type QlooClient } from '../qloo/client';
import { captureMembership } from '../qloo/bindings';
import type { FixtureBinding } from '../qloo/normalize';
import { QlooError } from '../qloo/errors';
import { ProviderRepository, type ProviderOperation } from './provider';

const operations = new AsyncLocalStorage<ProviderOperation>();
export function withCloudOperation<T>(context: { ref: string; fence: string; revision: number }, work: () => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(context.ref) || !/^[a-f0-9]{64}$/.test(context.fence) ||
    !Number.isSafeInteger(context.revision) || context.revision < 0 || operations.getStore()) throw new QlooError('configuration');
  return operations.run({ tokenHash: createHash('sha256').update(context.ref).digest('hex'),
    fence: context.fence, revision: context.revision }, work);
}

export type CloudQlooConfig = { databaseUrl: string; keySource: () => Promise<string>; databaseSchema?: string };
export function createCloudQlooClient(config: CloudQlooConfig, transport: typeof fetch = fetch): QlooClient {
  const repository = new ProviderRepository(config.databaseUrl, config.databaseSchema, () => operations.getStore());
  const backend: QlooBackend = {
    initialize: async () => ({ policy: await repository.initialize(), ledger: repository }),
    readPolicy: () => repository.readPolicy(),
    key: async () => {
      const key = (await config.keySource()).trim();
      if (!key || Buffer.byteLength(key) > 4096 || /[\r\n]/.test(key)) throw new QlooError('configuration');
      return key;
    },
    saveEvidence: (data, attemptId) => repository.saveEvidence(data, attemptId),
  };
  return createQlooClient({ keyFile: '', policyFile: '', evidenceDir: '', projectRoot: '', backend }, transport);
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export async function loadCloudBindings(databaseUrl: string, fixtures: readonly PracticalFixture[], databaseSchema?: string): Promise<FixtureBinding[]> {
  const result = await new ProviderRepository(databaseUrl, databaseSchema).rpc('bindings');
  if (result.status !== 'ok' || !Array.isArray(result.rows) || result.rows.length > 500) throw new QlooError('configuration');
  const identities = new Set<string>();
  const bindings: FixtureBinding[] = [];
  for (const value of result.rows) {
    if (!object(value) || typeof value.qlooEntityId !== 'string' || typeof value.fixtureId !== 'string' ||
      typeof value.evidenceRef !== 'string' || typeof value.envelope !== 'string' || typeof value.digest !== 'string' ||
      identities.has(value.qlooEntityId) || fixtures.filter(f => f.fixtureId === value.fixtureId).length !== 1) throw new QlooError('configuration');
    const bytes = Buffer.from(value.envelope, 'base64');
    if (bytes.byteLength > 4_194_304 || createHash('sha256').update(bytes).digest('hex') !== value.digest) throw new QlooError('configuration');
    let capture: unknown;
    try { capture = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new QlooError('configuration'); }
    try { if (!captureMembership(capture, value.qlooEntityId)) throw new QlooError('configuration'); }
    catch { throw new QlooError('configuration'); }
    identities.add(value.qlooEntityId);
    bindings.push({ qlooEntityId: value.qlooEntityId, fixtureId: value.fixtureId, evidenceRef: value.evidenceRef, verified: true });
  }
  return bindings;
}
