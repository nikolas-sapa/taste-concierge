import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { durableWrite } from '../admission/ledger';
import { readPrivateJson, verifyPrivateDirectory } from '../qloo/evidence';
import { MODEL_RESERVATION_MICROS, MODEL_SNAPSHOT, PRICING_SOURCE } from './constants';

type SpendPolicy = { version: 1; model: string; authorized: true; authorizationSource: string;
  ceilingMicros: number; priorSpentMicros: number; pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number;
    regionalUplift: number; source: string; verifiedAt: string; expiresAt: number } };
type SpendLedger = { version: 1; policyDigest: string; consumedMicros: number; halted: boolean;
  charges: { id: string; amountMicros: number; chargedAt: string }[] };
const invalid = () => new Error('Model configuration unavailable');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function scopedJson(root: string, name: string, projectRoot: string, maxBytes = 65_536): Promise<unknown> {
  const file = join(root, name);
  if ((await lstat(file)).isSymbolicLink()) throw invalid();
  const resolved = await realpath(file);
  if (dirname(resolved) !== root) throw invalid();
  return readPrivateJson(resolved, projectRoot, maxBytes);
}

function policy(value: unknown, maxSpendUsd: number): SpendPolicy {
  if (!object(value) || value.version !== 1 || value.model !== MODEL_SNAPSHOT || value.authorized !== true ||
    typeof value.authorizationSource !== 'string' || !value.authorizationSource.trim() ||
    !Number.isSafeInteger(value.ceilingMicros) || value.ceilingMicros !== Math.floor(maxSpendUsd * 1_000_000) ||
    !Number.isSafeInteger(value.priorSpentMicros) || (value.priorSpentMicros as number) < 0 ||
    (value.priorSpentMicros as number) > (value.ceilingMicros as number) || !object(value.pricing) ||
    value.pricing.inputUsdPerMillion !== 0.75 || value.pricing.outputUsdPerMillion !== 4.5 ||
    value.pricing.regionalUplift !== 1.1 || value.pricing.source !== PRICING_SOURCE ||
    typeof value.pricing.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.pricing.verifiedAt)) ||
    Date.parse(value.pricing.verifiedAt) > Date.now() || typeof value.pricing.expiresAt !== 'number' ||
    !Number.isFinite(value.pricing.expiresAt) || Date.now() >= value.pricing.expiresAt) throw invalid();
  return value as unknown as SpendPolicy;
}
const digest = (value: SpendPolicy) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ledger(value: unknown, config: SpendPolicy): SpendLedger {
  if (!object(value) || value.version !== 1 || value.policyDigest !== digest(config) || typeof value.halted !== 'boolean' ||
    !Array.isArray(value.charges) || !Number.isSafeInteger(value.consumedMicros) ||
    value.consumedMicros !== config.priorSpentMicros + value.charges.length * MODEL_RESERVATION_MICROS ||
    (value.consumedMicros as number) > config.ceilingMicros) throw invalid();
  const ids = new Set<string>();
  for (const c of value.charges) {
    if (!object(c) || typeof c.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.id) || ids.has(c.id) ||
      c.amountMicros !== MODEL_RESERVATION_MICROS || typeof c.chargedAt !== 'string' ||
      !Number.isFinite(Date.parse(c.chargedAt))) throw invalid();
    ids.add(c.id);
  }
  return value as unknown as SpendLedger;
}

export class ModelSpendGate {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private constructor(private readonly root: string, private readonly projectRoot: string,
    private readonly maxSpendUsd: number, private readonly config: SpendPolicy, private data: SpendLedger) {}

  static async open(evidenceDir: string, projectRoot: string, maxSpendUsd: number): Promise<ModelSpendGate> {
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) throw invalid();
    const root = await verifyPrivateDirectory(evidenceDir, projectRoot);
    const config = policy(await scopedJson(root, 'model-policy.json', projectRoot), maxSpendUsd);
    const initial = ledger(await scopedJson(root, 'model-budget.json', projectRoot, 8_388_608), config);
    await mkdir(join(root, 'model-budget.json.lock'), { mode: 0o700 });
    const gate = new ModelSpendGate(root, projectRoot, maxSpendUsd, config, initial);
    try { await gate.inspect(); return gate; } catch { await gate.close(); throw invalid(); }
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue; let unlock!: () => void;
    this.queue = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    try {
      if (this.closed || this.poisoned) throw invalid();
      return await work();
    } catch { this.poisoned = true; throw invalid(); } finally { unlock(); }
  }

  private async inspect(): Promise<void> {
    const current = policy(await scopedJson(this.root, 'model-policy.json', this.projectRoot), this.maxSpendUsd);
    const persisted = ledger(await scopedJson(this.root, 'model-budget.json', this.projectRoot, 8_388_608), current);
    if (JSON.stringify(current) !== JSON.stringify(this.config) || JSON.stringify(persisted) !== JSON.stringify(this.data) || persisted.halted) throw invalid();
  }

  async isReady(): Promise<boolean> {
    try { return await this.locked(async () => { await this.inspect(); return this.data.consumedMicros + MODEL_RESERVATION_MICROS <= this.config.ceilingMicros; }); }
    catch { return false; }
  }

  charge(signal: AbortSignal): Promise<string> {
    return this.locked(async () => {
      await this.inspect();
      if (signal.aborted || this.data.consumedMicros + MODEL_RESERVATION_MICROS > this.config.ceilingMicros) throw invalid();
      const id = randomBytes(32).toString('hex');
      this.data.consumedMicros += MODEL_RESERVATION_MICROS;
      this.data.charges.push({ id, amountMicros: MODEL_RESERVATION_MICROS, chargedAt: new Date().toISOString() });
      await durableWrite(join(this.root, 'model-budget.json'), this.data);
      return id;
    });
  }

  async halt(): Promise<void> {
    await this.locked(async () => { await this.inspect(); this.data.halted = true; await durableWrite(join(this.root, 'model-budget.json'), this.data); });
  }

  assertSendAllowed(signal: AbortSignal): Promise<void> {
    return this.locked(async () => { await this.inspect(); if (signal.aborted) throw invalid(); });
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.closed) { this.closed = true; await rmdir(join(this.root, 'model-budget.json.lock')).catch(() => {}); }
  }
}
