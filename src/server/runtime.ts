import 'server-only';
import { resolve } from 'node:path';
import { SessionStore } from './session/store';
import { createQlooClient } from './qloo/client';
import { createConcierge } from './concierge/assemble';
import { createUpdatePreferences } from './concierge/update';
import { loadPracticalFixtures } from './practical';
import { loadVerifiedBindings } from './qloo/bindings';
import { createModelService, type ModelService } from './model/responses';
import { asyncLocalSessionRepository } from './persistence/ports';
import { createPostgresBodyLimiter, createPostgresSessionRepository, postgresRuntimeReady } from './persistence/postgres';
import { createCloudQlooClient, loadCloudBindings } from './persistence/cloud';

export function requestConfiguration() {
  const production = process.env.NODE_ENV === 'production';
  return { production, origin: process.env.APP_ORIGIN ?? (production ? '' : 'http://localhost:3100') };
}

const disabledModel: ModelService = {
  async isReady() { return false; },
  async generateBaseline() { return { status: 'unavailable', reason: 'model-unavailable' }; },
  async interpretTreatment() { return { status: 'unavailable', reason: 'model-unavailable' }; },
  async close() {},
};

async function createRuntime() {
  const config = requestConfiguration();
  const storage = process.env.RUNTIME_STORAGE ?? (config.production ? '' : 'filesystem');
  if (storage !== 'postgres' && storage !== 'filesystem') throw new Error('Runtime storage unavailable');
  if (process.env.VERCEL === '1' && storage !== 'postgres') throw new Error('Persistent storage required');
  const fixtures = loadPracticalFixtures();
  if (storage === 'postgres') {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const client = createCloudQlooClient({ databaseUrl, keySource: async () => process.env.QLOO_API_KEY ?? '' });
    const bindings = await loadCloudBindings(databaseUrl, fixtures);
    const concierge = createConcierge({ client, fixtures, bindings, model: disabledModel });
    return { ...config, client, concierge, updatePreferences: createUpdatePreferences(concierge),
      bindingConfigurationValid: true, sessions: createPostgresSessionRepository(databaseUrl),
      bodyLimiter: createPostgresBodyLimiter(databaseUrl), storageReady: () => postgresRuntimeReady(databaseUrl) };
  }
  const client = createQlooClient({
    keyFile: process.env.QLOO_KEY_FILE ?? '',
    policyFile: process.env.QLOO_POLICY_FILE ?? '',
    evidenceDir: process.env.PRIVATE_EVIDENCE_DIR ?? '',
    projectRoot: resolve(/* turbopackIgnore: true */ process.cwd()),
  });
  let bindingConfigurationValid = true;
  let bindings: Awaited<ReturnType<typeof loadVerifiedBindings>> = [];
  try {
    bindings = await loadVerifiedBindings(process.env.PRIVATE_EVIDENCE_DIR ?? '', resolve(/* turbopackIgnore: true */ process.cwd()), fixtures);
  } catch { bindingConfigurationValid = false; }
  const model = createModelService({
    keyFile: process.env.OPENAI_KEY_FILE ?? '',
    maxSpendUsd: Number(process.env.MODEL_SPEND_LIMIT_USD ?? '0'),
    evidenceDir: process.env.PRIVATE_EVIDENCE_DIR ?? '',
    projectRoot: resolve(/* turbopackIgnore: true */ process.cwd()),
  });
  const concierge = createConcierge({ client, fixtures, bindings, model });
  return {
    ...config, client, bindingConfigurationValid, concierge, updatePreferences: createUpdatePreferences(concierge),
    sessions: asyncLocalSessionRepository(new SessionStore()), bodyLimiter: undefined, storageReady: async () => true,
  };
}

// Immutable services may be shared within a process. Cloud state lives in PostgreSQL.
const shared = globalThis as typeof globalThis & { tasteConciergeRuntime?: ReturnType<typeof createRuntime> };
export function getRuntime(): ReturnType<typeof createRuntime> {
  return shared.tasteConciergeRuntime ??= createRuntime().catch(error => {
    delete shared.tasteConciergeRuntime;
    throw error;
  });
}
