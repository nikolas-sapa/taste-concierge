import 'server-only';
import { resolve } from 'node:path';
import { SessionStore } from './session/store';
import { createQlooClient } from './qloo/client';
import { configureConcierge } from './concierge/assemble';
import { loadPracticalFixtures } from './practical';
import { loadVerifiedBindings } from './qloo/bindings';
import { createModelService } from './model/responses';

async function createRuntime() {
  const client = createQlooClient({
    keyFile: process.env.QLOO_KEY_FILE ?? '',
    policyFile: process.env.QLOO_POLICY_FILE ?? '',
    evidenceDir: process.env.PRIVATE_EVIDENCE_DIR ?? '',
    projectRoot: resolve(/* turbopackIgnore: true */ process.cwd()),
  });
  const fixtures = loadPracticalFixtures();
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
  configureConcierge({ client, fixtures, bindings, model });
  return {
    client, bindingConfigurationValid, sessions: new SessionStore(), production: process.env.NODE_ENV === 'production',
    origin: process.env.APP_ORIGIN ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3100'),
  };
}

// One Node instance, shared across route modules and development hot reloads.
const shared = globalThis as typeof globalThis & { tasteConciergeRuntime?: ReturnType<typeof createRuntime> };
export function getRuntime(): ReturnType<typeof createRuntime> {
  return shared.tasteConciergeRuntime ??= createRuntime();
}
