import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Category, Seed } from '../../contracts/concierge';
import type { EvidenceRef, ResolvedInputs } from '../../contracts/server';
import { AdmissionLedger, validatePolicy, type PayloadPolicy } from '../admission/ledger';
import type { ExecutionPolicy } from '../admission/application-policy';
import { QlooError } from './errors';
import { readPrivateJson, saveEvidence, verifyPrivateDirectory } from './evidence';
import { seedType } from './normalize';

export type CapturedResult = { body: unknown; evidence: EvidenceRef };
export interface QlooClient {
  isReady(): Promise<boolean>;
  runOperation<T>(work: () => Promise<T>, requestSignal?: AbortSignal): Promise<T>;
  search(seed: Seed): Promise<CapturedResult>;
  recommend(inputs: ResolvedInputs, category: Category, radiusMeters: number): Promise<CapturedResult>;
  payloadPolicy(): PayloadPolicy;
}
export interface QlooAdmission {
  reserve(count?: number): Promise<string>;
  charge(id: string, signal?: AbortSignal): Promise<{ id: string; chargedAt: number }>;
  release(id: string): Promise<void>;
  halt(): Promise<void>;
  assertSendAllowed(id: string): void | Promise<void>;
  isReady(): Promise<boolean>;
  completeSend?(id: string, uncertain: boolean): Promise<void>;
}
export type CaptureData = Parameters<typeof saveEvidence>[2];
export interface QlooBackend {
  initialize(): Promise<{ policy: ExecutionPolicy; ledger: QlooAdmission }>;
  readPolicy(): Promise<ExecutionPolicy>;
  key(): Promise<string>;
  saveEvidence(data: CaptureData, attemptId: string): Promise<EvidenceRef>;
}
export type QlooClientConfig = { keyFile: string; policyFile: string; evidenceDir: string; projectRoot: string; backend?: QlooBackend };
type Operation = { reservation: string; signal: AbortSignal; attempts: number };

function aborted(signal: AbortSignal): void { if (signal.aborted) throw new QlooError('timeout'); }
async function waitAbortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  aborted(signal);
  let listener!: () => void;
  const timeout = new Promise<never>((_, reject) => {
    listener = () => reject(new QlooError('timeout'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { await Promise.race([promise, timeout]); } finally { signal.removeEventListener('abort', listener); }
}

class NativeQlooClient implements QlooClient {
  private policy?: ExecutionPolicy;
  private ledger?: QlooAdmission;
  private initializing?: Promise<void>;
  private readonly operations = new AsyncLocalStorage<Operation>();
  private sendQueue: Promise<void> = Promise.resolve();
  private lastCompletedAt = 0;

  constructor(private readonly config: QlooClientConfig, private readonly transport: typeof fetch) {}

  private async key(): Promise<string> {
    if (this.config.backend) return this.config.backend.key();
    try {
      const { keyFile, projectRoot } = this.config;
      if (!isAbsolute(keyFile)) throw new QlooError('configuration');
      const [resolved, project] = await Promise.all([realpath(keyFile), realpath(projectRoot)]);
      const rel = relative(project, resolved);
      if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new QlooError('configuration');
      const info = await stat(resolved);
      if (!info.isFile() || info.size < 1 || info.size > 4096 || (info.mode & 0o777) !== 0o600 ||
        ((await stat(dirname(resolved))).mode & 0o777) !== 0o700) throw new QlooError('configuration');
      const value = (await readFile(resolved, 'utf8')).trim();
      if (!value || /[\r\n]/.test(value)) throw new QlooError('configuration');
      return value;
    } catch { throw new QlooError('configuration'); }
  }

  private async initialize(): Promise<void> {
    if (this.ledger) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        if (this.config.backend) {
          const initialized = await this.config.backend.initialize();
          await this.key();
          this.policy = initialized.policy; this.ledger = initialized.ledger;
          return;
        }
        const root = await verifyPrivateDirectory(this.config.evidenceDir, this.config.projectRoot);
        await verifyPrivateDirectory(dirname(this.config.policyFile), this.config.projectRoot);
        // Numerical policy and reconciled prior usage are mandatory. Manual Q0 is never loaded here.
        const policy = validatePolicy(await readPrivateJson(this.config.policyFile, this.config.projectRoot));
        await this.key();
        const ledger = await AdmissionLedger.open(join(root, 'app-admission.json'), policy, Date.now, this.config.projectRoot);
        this.policy = policy; this.ledger = ledger;
      })();
    }
    try { await this.initializing; } finally { this.initializing = undefined; }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.initialize();
      const current = await this.readPolicy();
      return JSON.stringify(current) === JSON.stringify(this.policy) && !!this.ledger && await this.ledger.isReady();
    } catch { return false; }
  }

  payloadPolicy(): PayloadPolicy {
    if (!this.policy) throw new QlooError('configuration');
    return structuredClone(this.policy.payload);
  }

  private async readPolicy(): Promise<ExecutionPolicy> {
    return this.config.backend ? this.config.backend.readPolicy()
      : validatePolicy(await readPrivateJson(this.config.policyFile, this.config.projectRoot));
  }

  async runOperation<T>(work: () => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
    if (requestSignal?.aborted) throw new QlooError('timeout');
    if (this.operations.getStore()) throw new QlooError('configuration');
    if (!await this.isReady() || !this.ledger) throw new QlooError('configuration');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    let reservation: string | undefined;
    try {
      aborted(signal);
      reservation = await this.ledger.reserve(5);
      aborted(signal);
      return await this.operations.run({ reservation, signal, attempts: 0 }, work);
    } finally {
      clearTimeout(timer); controller.abort();
      if (reservation) await this.ledger.release(reservation);
    }
  }

  private async serialized<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.sendQueue;
    let unlock!: () => void;
    this.sendQueue = new Promise<void>(resolve => { unlock = resolve; });
    let acquired = false;
    try {
      await waitAbortable(previous, signal); acquired = true;
      return await work();
    } finally {
      if (acquired) unlock(); else void previous.then(unlock, unlock);
    }
  }

  private async request(route: '/search' | '/v2/insights', parameters: Record<string, string>): Promise<CapturedResult> {
    const operation = this.operations.getStore();
    if (!operation || !this.ledger || !this.policy) throw new QlooError('configuration');
    return this.serialized(operation.signal, async () => {
      aborted(operation.signal);
      if (operation.attempts >= 5) throw new QlooError('configuration');
      const current = await this.readPolicy();
      if (JSON.stringify(current) !== JSON.stringify(this.policy)) throw new QlooError('configuration');
      const gap = this.policy!.minIntervalMs - (Date.now() - this.lastCompletedAt);
      if (gap > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await waitAbortable(new Promise<void>(resolve => { timer = setTimeout(resolve, gap); }), operation.signal); }
        finally { if (timer) clearTimeout(timer); }
      }
      const credential = await this.key();
      aborted(operation.signal);
      const charge = await this.ledger!.charge(operation.reservation, operation.signal);
      operation.attempts++;
      const timeout = AbortSignal.timeout(15_000);
      const signal = AbortSignal.any([operation.signal, timeout]);
      let completed = false;
      let transportStarted = false;
      try {
        aborted(signal);
        await this.ledger!.assertSendAllowed(charge.id);
        aborted(signal);
        const url = new URL(route, 'https://hackathon.api.qloo.com');
        for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
        transportStarted = true;
        const response = await this.transport(url, { method: 'GET', redirect: 'error',
          headers: { 'X-Api-Key': credential, Accept: 'application/json' }, signal });
        const headers = Object.fromEntries(response.headers);
        const zeroRemaining = Object.entries(headers).some(([name, value]) =>
          /(?:quota|ratelimit|rate-limit).*remaining|remaining.*quota/i.test(name) && /^0(?:\.0+)?$/.test(value.trim()));
        if (response.status === 401 || response.status === 429 || response.status === 403 || zeroRemaining) await this.ledger!.halt();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (!response.body) throw new QlooError('upstream');
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2_097_152) { await reader.cancel(); completed = true; throw new QlooError('upstream'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        completed = true;
        const raw = Buffer.concat(chunks);
        const capture = { route, parameters, status: response.status, headers, raw, receivedAt: new Date().toISOString() };
        const evidence = this.config.backend ? await this.config.backend.saveEvidence(capture, charge.id)
          : await saveEvidence(this.config.evidenceDir, this.config.projectRoot, capture);
        if (response.status === 401 || response.status === 403) throw new QlooError('authentication');
        if (response.status === 429 || zeroRemaining) throw new QlooError('rate-limit');
        if (response.status === 404 && route === '/search') return { body: { results: [] }, evidence };
        if (!response.ok) throw new QlooError('upstream');
        let body: unknown;
        try { body = JSON.parse(raw.toString('utf8')) as unknown; } catch { throw new QlooError('upstream'); }
        if (body && typeof body === 'object') {
          const errors = (body as { error?: unknown; errors?: unknown }).errors ?? (body as { error?: unknown }).error;
          if (errors && /quota|rate.?limit|access.?policy|forbidden|not.authorized|credential.*expir/i.test(JSON.stringify(errors))) {
            await this.ledger!.halt();
            throw new QlooError('rate-limit');
          }
        }
        return { body, evidence };
      } catch (error) {
        if (error instanceof QlooError) throw error;
        if (signal.aborted) throw new QlooError('timeout');
        throw new QlooError('network');
      } finally {
        this.lastCompletedAt = Date.now();
        await this.ledger!.completeSend?.(charge.id, transportStarted && !completed);
      }
    });
  }

  search(seed: Seed): Promise<CapturedResult> {
    return this.request('/search', { query: seed.text, types: seedType(seed.kind), take: '20' });
  }

  recommend(inputs: ResolvedInputs, category: Category, radiusMeters: number): Promise<CapturedResult> {
    const payload = this.payloadPolicy();
    return this.request('/v2/insights', { 'filter.type': 'urn:entity:place',
      'signal.interests.entities': inputs.entities.map(e => e.qlooEntityId).join(','),
      'filter.tags': payload.categoryTagIds[category],
      'filter.location': `POINT(${payload.origin.longitude} ${payload.origin.latitude})`,
      'filter.location.radius': String(radiusMeters), 'filter.geocode.country_code': 'GR', take: '30' });
  }
}

export function createQlooClient(config: QlooClientConfig, transport: typeof fetch = fetch): QlooClient {
  return new NativeQlooClient(config, transport);
}
