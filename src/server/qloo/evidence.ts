import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { EvidenceRef } from '../../contracts/server';
import { durableWrite } from '../admission/ledger';
import { QlooError } from './errors';

export async function verifyPrivateDirectory(directory: string, projectRoot: string): Promise<string> {
  try {
    if (!isAbsolute(directory) || !isAbsolute(projectRoot)) throw new QlooError('configuration');
    const [privateRoot, project] = await Promise.all([realpath(directory), realpath(projectRoot)]);
    const rel = relative(project, privateRoot);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) ||
      !(await stat(privateRoot)).isDirectory() || ((await stat(privateRoot)).mode & 0o777) !== 0o700) {
      throw new QlooError('configuration');
    }
    return privateRoot;
  } catch { throw new QlooError('configuration'); }
}

export async function readPrivateJson(file: string, projectRoot: string, maxBytes = 65_536): Promise<unknown> {
  try {
    if (!isAbsolute(file)) throw new QlooError('configuration');
    const resolved = await realpath(file);
    await verifyPrivateDirectory(dirname(resolved), projectRoot);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o777) !== 0o600) throw new QlooError('configuration');
    const bytes = await readFile(resolved);
    if (bytes.byteLength > maxBytes) throw new QlooError('configuration');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch { throw new QlooError('configuration'); }
}

export async function saveEvidence(directory: string, projectRoot: string, data: {
  route: string; parameters: Record<string, string>; status: number;
  headers: Record<string, string>; raw: Uint8Array; receivedAt: string;
}): Promise<EvidenceRef> {
  const root = await verifyPrivateDirectory(directory, projectRoot);
  const privateRef = `${randomBytes(32).toString('hex')}.json`;
  const digest = createHash('sha256').update(data.raw).digest('hex');
  await durableWrite(join(root, privateRef), { request: { method: 'GET', route: data.route,
    parameters: data.parameters, headerNames: ['X-Api-Key', 'Accept'] },
    status: data.status, responseHeaders: data.headers, rawBody: Buffer.from(data.raw).toString('base64'),
    rawEncoding: 'base64', digest, retrievedAt: data.receivedAt });
  return { privateRef, digest, retrievedAt: data.receivedAt };
}
