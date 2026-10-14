import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { AdmissionLedger, initializeLedger, type ProviderPolicy } from '../../src/server/admission/ledger';

const policy = (): ProviderPolicy => ({ version: 1, verified: true, priorUsageKnown: true,
  source: 'synthetic unit policy, not provider evidence', expiresAt: 100_000,
  minIntervalMs: 0, windows: [
    { id: 'unit-rate', kind: 'rate', startsAt: 0, endsAt: 50_000, ceiling: 20, usedBeforeLedger: 0 },
    { id: 'unit-quota', kind: 'quota', startsAt: 0, endsAt: 100_000, ceiling: 20, usedBeforeLedger: 0 },
  ], payload: { categoryTagIds: { dining: 'synthetic-dining', attractions: 'synthetic-museum' },
    origin: { latitude: 0, longitude: 0 }, athensCityNames: ['Unit city'] },
});

test('3 reservations allowed, 4th rejected; cancellation refunds only 4 uncharged attempts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-ledger-unit-'));
  const file = join(dir, 'ledger.json');
  let ledger: AdmissionLedger | undefined;
  try {
    await initializeLedger(file, policy());
    ledger = await AdmissionLedger.open(file, policy(), () => 1);
    const a = await ledger.reserve(5);
    const b = await ledger.reserve(5);
    const c = await ledger.reserve(5);
    await expect(ledger.reserve(5)).rejects.toMatchObject({ reason: 'rate-limit' });
    await ledger.charge(a);
    await ledger.release(a);
    await ledger.release(b);
    await ledger.release(c);
    await ledger.close();
    ledger = await AdmissionLedger.open(file, policy(), () => 2);
    expect(JSON.parse(await readFile(file, 'utf8')).charges).toHaveLength(1);
    const next = await ledger.reserve(5);
    await ledger.release(next);
  } finally { await ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('missing/corrupt ledger and unknown policy deny without initialization or refill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-ledger-unit-'));
  const file = join(dir, 'ledger.json');
  try {
    await expect(AdmissionLedger.open(file, policy(), () => 1)).rejects.toMatchObject({ reason: 'configuration' });
    await writeFile(file, '{broken', { mode: 0o600 });
    await expect(AdmissionLedger.open(file, policy(), () => 1)).rejects.toMatchObject({ reason: 'configuration' });
    await expect(initializeLedger(file, policy())).rejects.toBeDefined();
    await expect(AdmissionLedger.open(file, { ...policy(), priorUsageKnown: false } as unknown as ProviderPolicy, () => 1))
      .rejects.toMatchObject({ reason: 'configuration' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('send-time window rollover with no active rate window denies charge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-ledger-unit-'));
  const file = join(dir, 'ledger.json');
  let now = 1;
  let ledger: AdmissionLedger | undefined;
  try {
    await initializeLedger(file, policy());
    ledger = await AdmissionLedger.open(file, policy(), () => now);
    const reservation = await ledger.reserve(5);
    now = 50_000;
    await expect(ledger.charge(reservation)).rejects.toMatchObject({ reason: 'configuration' });
    expect(JSON.parse(await readFile(file, 'utf8')).charges).toHaveLength(0);
  } finally { await ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('ledger symlink target rejected at open and after replacement during operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-ledger-unit-'));
  const outside = await mkdtemp(join(tmpdir(), 'concierge-ledger-outside-unit-'));
  const file = join(dir, 'ledger.json');
  const target = join(outside, 'ledger.json');
  let ledger: AdmissionLedger | undefined;
  try {
    await initializeLedger(target, policy());
    await symlink(target, file);
    await expect(AdmissionLedger.open(file, policy(), () => 1)).rejects.toMatchObject({ reason: 'configuration' });
    await unlink(file);
    await initializeLedger(file, policy());
    ledger = await AdmissionLedger.open(file, policy(), () => 1);
    const reservation = await ledger.reserve(5);
    await unlink(file);
    await symlink(target, file);
    await expect(ledger.charge(reservation)).rejects.toMatchObject({ reason: 'configuration' });
    expect(JSON.parse(await readFile(target, 'utf8')).charges).toHaveLength(0);
    expect(await ledger.isReady()).toBe(false);
  } finally { await ledger?.close(); await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
