import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { PracticalFixture } from '../../../src/contracts/server';
import { loadVerifiedBindings } from '../../../src/server/qloo/bindings';

const fixture: PracticalFixture = { fixtureId: 'unit-fixture', sourceEntityId: 'unit-source', name: 'Synthetic unit venue',
  coordinates: null, category: 'dining', cityId: 'athens', sourceUrl: 'https://example.invalid/unit-source',
  sourceRevision: 'unit', retrievedAt: new Date().toISOString(), license: 'CC0', verification: 'source-reported' };
const binding = { qlooEntityId: 'unit-entity', fixtureId: fixture.fixtureId, verified: true, evidenceRef: 'capture.json' };

test('missing bindings mean [] and approved capture membership can bind; no name inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-binding-unit-'));
  try {
    expect(await loadVerifiedBindings('', process.cwd(), [fixture])).toEqual([]);
    expect(await loadVerifiedBindings(dir, process.cwd(), [fixture])).toEqual([]);
    await writeFile(join(dir, 'capture.json'), JSON.stringify({ status: 200,
      body: { results: { entities: [{ entity_id: binding.qlooEntityId, subtype: 'urn:entity:place' }] } } }), { mode: 0o600 });
    await writeFile(join(dir, 'fixture-bindings.json'), JSON.stringify({ version: 1, bindings: [binding] }), { mode: 0o600 });
    expect(await loadVerifiedBindings(dir, process.cwd(), [fixture])).toEqual([binding]);
    await expect(loadVerifiedBindings(dir, process.cwd(), [])).rejects.toMatchObject({ reason: 'configuration' });
    await writeFile(join(dir, 'fixture-bindings.json'), JSON.stringify({ version: 1, bindings: [binding, binding] }));
    await expect(loadVerifiedBindings(dir, process.cwd(), [fixture])).rejects.toMatchObject({ reason: 'configuration' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('symlink escape, insecure file and unproven entity reject configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-binding-unit-'));
  const outside = await mkdtemp(join(tmpdir(), 'concierge-binding-outside-unit-'));
  try {
    const config = JSON.stringify({ version: 1, bindings: [binding] });
    await writeFile(join(outside, 'outside.json'), config, { mode: 0o600 });
    await symlink(join(outside, 'outside.json'), join(dir, 'fixture-bindings.json'));
    await expect(loadVerifiedBindings(dir, process.cwd(), [fixture])).rejects.toMatchObject({ reason: 'configuration' });
    await rm(join(dir, 'fixture-bindings.json'));
    await writeFile(join(dir, 'fixture-bindings.json'), config, { mode: 0o644 });
    await expect(loadVerifiedBindings(dir, process.cwd(), [fixture])).rejects.toMatchObject({ reason: 'configuration' });
    await rm(join(dir, 'fixture-bindings.json'));
    await writeFile(join(dir, 'fixture-bindings.json'), config, { mode: 0o600 });
    await writeFile(join(dir, 'capture.json'), JSON.stringify({ status: 200,
      body: { results: { entities: [{ entity_id: 'foreign-unit-entity', subtype: 'urn:entity:place' }] } } }), { mode: 0o600 });
    await expect(loadVerifiedBindings(dir, process.cwd(), [fixture])).rejects.toMatchObject({ reason: 'configuration' });
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
