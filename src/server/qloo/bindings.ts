import 'server-only';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { PracticalFixture } from '../../contracts/server';
import { verifyPrivateDirectory } from './evidence';
import { QlooError } from './errors';
import type { FixtureBinding } from './normalize';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500;
const failure = () => new QlooError('configuration');

async function readWithinRoot(file: string, root: string, projectRoot: string, maxBytes: number): Promise<unknown> {
  const resolved = await realpath(file);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw failure();
  await verifyPrivateDirectory(dirname(resolved), projectRoot);
  const info = await stat(resolved);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > maxBytes) throw failure();
  const bytes = await readFile(resolved);
  if (bytes.byteLength > maxBytes) throw failure();
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

export function captureMembership(capture: unknown, entityId: string): boolean {
  if (!object(capture)) return false;
  let body: unknown = capture.body;
  if (typeof capture.rawBody === 'string' && capture.rawEncoding === 'base64') {
    const bytes = Buffer.from(capture.rawBody, 'base64');
    if (bytes.byteLength > 2_097_152) return false;
    body = JSON.parse(bytes.toString('utf8')) as unknown;
  }
  return capture.status === 200 && object(body) && object(body.results) && Array.isArray(body.results.entities) &&
    body.results.entities.some(row => object(row) && row.entity_id === entityId && row.subtype === 'urn:entity:place');
}

/** Operator-approved private identity bindings only. Never infers correspondence from names or proximity. */
export async function loadVerifiedBindings(evidenceDir: string, projectRoot: string,
  fixtures: readonly PracticalFixture[]): Promise<FixtureBinding[]> {
  if (!evidenceDir) return [];
  if (!isAbsolute(evidenceDir)) throw failure();
  const file = join(evidenceDir, 'fixture-bindings.json');
  try { await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw failure(); }
  try {
    const root = await verifyPrivateDirectory(evidenceDir, projectRoot);
    const config = await readWithinRoot(file, root, projectRoot, 524_288);
    if (!object(config) || config.version !== 1 || !Array.isArray(config.bindings) || config.bindings.length > 500) throw failure();
    const fixtureCounts = new Map<string, number>();
    for (const f of fixtures) fixtureCounts.set(f.fixtureId, (fixtureCounts.get(f.fixtureId) ?? 0) + 1);
    const identities = new Set<string>();
    const result: FixtureBinding[] = [];
    for (const row of config.bindings) {
      if (!object(row) || row.verified !== true || !text(row.qlooEntityId) || !text(row.fixtureId) || !text(row.evidenceRef) ||
        identities.has(row.qlooEntityId) || fixtureCounts.get(row.fixtureId) !== 1 || isAbsolute(row.evidenceRef) ||
        row.evidenceRef.split(/[\\/]/).some(segment => segment === '..' || segment === '')) throw failure();
      const capture = await readWithinRoot(join(root, row.evidenceRef), root, projectRoot, 4_194_304);
      if (!captureMembership(capture, row.qlooEntityId)) throw failure();
      identities.add(row.qlooEntityId);
      result.push({ qlooEntityId: row.qlooEntityId, fixtureId: row.fixtureId, verified: true, evidenceRef: row.evidenceRef });
    }
    return result;
  } catch { throw failure(); }
}
