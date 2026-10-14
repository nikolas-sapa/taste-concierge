import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, mkdir, rmdir, stat, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { QlooError } from '../qloo/errors';

export type PayloadPolicy = {
  categoryTagIds: { dining: string; attractions: string };
  origin: { latitude: number; longitude: number }; athensCityNames: string[];
};
export type PolicyWindow = { id: string; kind: 'rate' | 'quota'; startsAt: number;
  endsAt: number; ceiling: number; usedBeforeLedger: number };
export type ProviderPolicy = { version: 1; verified: true; priorUsageKnown: true;
  source: string; expiresAt: number; minIntervalMs: number; windows: PolicyWindow[]; payload: PayloadPolicy };
type Reservation = { remaining: number; windowIds: string[] };
type Charge = { id: string; reservation: string; chargedAt: number; windowIds: string[] };
type DiskLedger = { version: 1; policyDigest: string; sequence: number;
  halted: boolean; reservations: Record<string, Reservation>; charges: Charge[] };

const configuration = () => new QlooError('configuration');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const boundedString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500;

export function validatePolicy(v: unknown): ProviderPolicy {
  if (!object(v) || v.version !== 1 || v.verified !== true || v.priorUsageKnown !== true ||
    !boundedString(v.source) || !finite(v.expiresAt) || !finite(v.minIntervalMs) ||
    v.minIntervalMs < 0 || !Array.isArray(v.windows) || v.windows.length < 2 || v.windows.length > 100 ||
    !object(v.payload) || !object(v.payload.categoryTagIds) || !object(v.payload.origin) ||
    !boundedString(v.payload.categoryTagIds.dining) || !boundedString(v.payload.categoryTagIds.attractions) ||
    !finite(v.payload.origin.latitude) || Math.abs(v.payload.origin.latitude) > 90 ||
    !finite(v.payload.origin.longitude) || Math.abs(v.payload.origin.longitude) > 180 ||
    !Array.isArray(v.payload.athensCityNames) || v.payload.athensCityNames.length === 0 ||
    v.payload.athensCityNames.length > 30 || !v.payload.athensCityNames.every(boundedString)) throw configuration();
  const ids = new Set<string>();
  for (const w of v.windows) {
    if (!object(w) || !boundedString(w.id) || ids.has(w.id) || (w.kind !== 'rate' && w.kind !== 'quota') ||
      !finite(w.startsAt) || !finite(w.endsAt) || w.startsAt >= w.endsAt ||
      !Number.isSafeInteger(w.ceiling) || (w.ceiling as number) < 1 ||
      !Number.isSafeInteger(w.usedBeforeLedger) || (w.usedBeforeLedger as number) < 0 ||
      (w.usedBeforeLedger as number) > (w.ceiling as number)) throw configuration();
    ids.add(w.id);
  }
  return v as unknown as ProviderPolicy;
}

const digest = (p: ProviderPolicy) => createHash('sha256').update(JSON.stringify(p)).digest('hex');
async function privateLedgerParent(file: string, projectRoot: string): Promise<string> {
  if (!isAbsolute(file) || !isAbsolute(projectRoot)) throw configuration();
  const [parent, project] = await Promise.all([realpath(dirname(file)), realpath(projectRoot)]);
  const rel = relative(project, parent);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) ||
    ((await stat(parent)).mode & 0o777) !== 0o700) throw configuration();
  return parent;
}

async function readLedger(file: string, projectRoot: string): Promise<{ file: string; data: unknown }> {
  const parent = await privateLedgerParent(file, projectRoot);
  if ((await lstat(file)).isSymbolicLink()) throw configuration();
  const resolved = await realpath(file);
  if (dirname(resolved) !== parent) throw configuration();
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 8_388_608) throw configuration();
    const bytes = await handle.readFile();
    if (bytes.byteLength > 8_388_608) throw configuration();
    return { file: resolved, data: JSON.parse(bytes.toString('utf8')) as unknown };
  } finally { await handle.close(); }
}
export async function durableWrite(file: string, data: unknown): Promise<void> {
  const temp = `${file}.tmp-${randomBytes(16).toString('hex')}`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw configuration();
  }
}

// Explicit one-time initialization only after main has reconciled provider prior usage.
// Never called by application startup; existing state cannot be overwritten.
export async function initializeLedger(file: string, policy: ProviderPolicy, projectRoot = process.cwd()): Promise<void> {
  validatePolicy(policy);
  file = join(await privateLedgerParent(file, projectRoot), basename(file));
  const data: DiskLedger = { version: 1, policyDigest: digest(policy), sequence: 0,
    halted: false, reservations: {}, charges: [] };
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class AdmissionLedger {
  private queue: Promise<void> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private constructor(private readonly file: string, readonly policy: ProviderPolicy,
    private data: DiskLedger, private readonly now: () => number, private readonly projectRoot: string) {}

  static async open(file: string, supplied: ProviderPolicy, now = Date.now, projectRoot = process.cwd()): Promise<AdmissionLedger> {
    const policy = validatePolicy(supplied);
    let locked = false;
    try {
      const captured = await readLedger(file, projectRoot);
      file = captured.file;
      await mkdir(`${file}.lock`, { mode: 0o700 }); locked = true;
      const value: unknown = (await readLedger(file, projectRoot)).data;
      if (!object(value) || value.version !== 1 || value.policyDigest !== digest(policy) ||
        !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
        typeof value.halted !== 'boolean' || !object(value.reservations) || !Array.isArray(value.charges)) throw configuration();
      const windowIds = new Set(policy.windows.map(w => w.id));
      const chargeIds = new Set<string>();
      for (const c of value.charges) {
        if (!object(c) || !boundedString(c.id) || chargeIds.has(c.id) || !boundedString(c.reservation) ||
          !finite(c.chargedAt) || !Array.isArray(c.windowIds) || c.windowIds.length < 2 ||
          !c.windowIds.every(id => typeof id === 'string' && windowIds.has(id))) throw configuration();
        chargeIds.add(c.id);
      }
      for (const [id, r] of Object.entries(value.reservations)) {
        if (!boundedString(id) || !object(r) || !Number.isInteger(r.remaining) ||
          (r.remaining as number) < 0 || (r.remaining as number) > 5 || !Array.isArray(r.windowIds) ||
          !r.windowIds.every(x => typeof x === 'string' && windowIds.has(x))) throw configuration();
      }
      const ledger = new AdmissionLedger(file, structuredClone(policy), value as unknown as DiskLedger, now, projectRoot);
      ledger.activeWindows();
      // Charged entries survive restart. Only recorded uncharged reservation slots are released.
      if (Object.keys(ledger.data.reservations).length) {
        ledger.data.reservations = {}; ledger.data.sequence++;
        await durableWrite(file, ledger.data);
      }
      return ledger;
    } catch {
      if (locked) await rmdir(`${file}.lock`).catch(() => {});
      throw configuration();
    }
  }

  private activeWindows(): PolicyWindow[] {
    const now = this.now();
    if (now >= this.policy.expiresAt) throw configuration();
    const active = this.policy.windows.filter(w => w.startsAt <= now && now < w.endsAt);
    if (!active.some(w => w.kind === 'rate') || !active.some(w => w.kind === 'quota')) throw configuration();
    return active;
  }

  private async mutate<T>(fn: () => T): Promise<T> {
    const previous = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try {
      if (this.poisoned || this.closed) throw configuration();
      const persisted = (await readLedger(this.file, this.projectRoot)).data as DiskLedger;
      if (persisted.sequence !== this.data.sequence || persisted.policyDigest !== this.data.policyDigest ||
        JSON.stringify(persisted) !== JSON.stringify(this.data)) { this.poisoned = true; throw configuration(); }
      const result = fn();
      this.data.sequence++;
      await durableWrite(this.file, this.data);
      return result;
    } catch (e) {
      if (!(e instanceof QlooError) || e.reason === 'configuration') this.poisoned = true;
      throw e instanceof QlooError ? e : configuration();
    } finally { unlock(); }
  }

  private hasBudget(windows: PolicyWindow[], requested: number, exclude?: string): boolean {
    return windows.every(w => {
      const used = this.data.charges.filter(c => c.windowIds.includes(w.id)).length;
      // Conservative: all live reservations consume current send-time windows, including rollover.
      const reserved = Object.entries(this.data.reservations)
        .filter(([id]) => id !== exclude).reduce((sum, [, r]) => sum + r.remaining, 0);
      return w.usedBeforeLedger + used + reserved + requested <= w.ceiling;
    });
  }

  reserve(count = 5): Promise<string> {
    return this.mutate(() => {
      const windows = this.activeWindows();
      if (!Number.isInteger(count) || count < 1 || count > 5) throw configuration();
      if (this.data.halted || Object.keys(this.data.reservations).length >= 3 || !this.hasBudget(windows, count)) {
        throw new QlooError('rate-limit');
      }
      const id = randomBytes(32).toString('hex');
      this.data.reservations[id] = { remaining: count, windowIds: windows.map(w => w.id) };
      return id;
    });
  }

  charge(id: string): Promise<{ id: string; chargedAt: number }> {
    return this.mutate(() => {
      const r = this.data.reservations[id];
      const windows = this.activeWindows();
      if (!r || r.remaining < 1) throw configuration();
      if (this.data.halted || !this.hasBudget(windows, r.remaining, id)) throw new QlooError('rate-limit');
      const last = this.data.charges.at(-1);
      if (last && this.now() - last.chargedAt < this.policy.minIntervalMs) throw new QlooError('rate-limit');
      const charge = { id: randomBytes(32).toString('hex'), reservation: id,
        chargedAt: this.now(), windowIds: windows.map(w => w.id) };
      r.remaining--; r.windowIds = charge.windowIds;
      this.data.charges.push(charge);
      return { id: charge.id, chargedAt: charge.chargedAt };
    });
  }

  release(id: string): Promise<void> {
    return this.mutate(() => { delete this.data.reservations[id]; });
  }

  halt(): Promise<void> { return this.mutate(() => { this.data.halted = true; }); }

  assertSendAllowed(chargeId: string): void {
    if (this.poisoned || this.closed || this.data.halted) throw configuration();
    const charge = this.data.charges.find(c => c.id === chargeId);
    const active = this.activeWindows().map(w => w.id).sort();
    if (!charge || JSON.stringify([...charge.windowIds].sort()) !== JSON.stringify(active)) throw configuration();
  }

  async isReady(): Promise<boolean> {
    const previous = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try {
      this.activeWindows();
      if (this.closed || this.poisoned || this.data.halted) return false;
      const persisted = (await readLedger(this.file, this.projectRoot)).data;
      if (JSON.stringify(persisted) !== JSON.stringify(this.data)) { this.poisoned = true; return false; }
      return true;
    } catch { this.poisoned = true; return false; }
    finally { unlock(); }
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.closed) { this.closed = true; await rmdir(`${this.file}.lock`).catch(() => {}); }
  }
}
