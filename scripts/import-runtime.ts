import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

const fail = () => new Error('Private runtime import failed');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function migrateProvider(databaseUrl: string): Promise<void> {
  const { migrationStatements } = await import(new URL('./migrate-runtime.ts', import.meta.url).href);
  const source = await readFile(new URL('../migrations/002-provider.sql', import.meta.url), 'utf8');
  const sql = neon(databaseUrl);
  try {
    await sql.transaction((migrationStatements(source) as string[]).map(statement => sql.query(statement)),
      { fetchOptions: { signal: AbortSignal.timeout(20_000) } });
  } catch { throw fail(); }
}

/** Explicit operator import only. Policy/allowance initialization is intentionally separate. */
export async function importRuntimeEvidence(options: {
  databaseUrl: string; evidenceDir: string; projectRoot: string; fixtureIds: readonly string[]; databaseSchema?: string;
}): Promise<number> {
  const { databaseUrl, evidenceDir, projectRoot, fixtureIds } = options;
  const schema = options.databaseSchema ?? 'taste_runtime';
  try {
    if (!/^taste_runtime(?:_test_[a-f0-9]+)?$/.test(schema)) throw fail();
    if (!isAbsolute(evidenceDir) || !isAbsolute(projectRoot)) throw fail();
    const [root, project] = await Promise.all([realpath(evidenceDir), realpath(projectRoot)]);
    const fromProject = relative(project, root);
    if (!fromProject || (!isAbsolute(fromProject) && fromProject !== '..' && !fromProject.startsWith(`..${sep}`)) ||
      ((await stat(root)).mode & 0o777) !== 0o700) throw fail();
    async function secureRead(ref: string, cap: number): Promise<Buffer> {
      if (isAbsolute(ref) || ref.split(/[\\/]/).some(part => !part || part === '..')) throw fail();
      const file = join(root, ref);
      if ((await lstat(file)).isSymbolicLink()) throw fail();
      const resolved = await realpath(file);
      const rel = relative(root, resolved);
      const info = await stat(resolved);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !info.isFile() ||
        info.size > cap || (info.mode & 0o777) !== 0o600 || ((await stat(dirname(resolved))).mode & 0o777) !== 0o700) throw fail();
      const bytes = await readFile(resolved);
      if (bytes.byteLength > cap) throw fail();
      return bytes;
    }
    const envelope: unknown = JSON.parse((await secureRead('fixture-bindings.json', 524_288)).toString('utf8'));
    if (!object(envelope) || envelope.version !== 1 || !Array.isArray(envelope.bindings) || envelope.bindings.length > 500 ||
      new Set(fixtureIds).size !== fixtureIds.length) throw fail();
    const entities = new Set<string>();
    const captures = new Map<string, { bytes: Buffer; digest: string }>();
    const bindings: { entity: string; fixture: string; evidence: string }[] = [];
    for (const row of envelope.bindings) {
      if (!object(row) || row.verified !== true || typeof row.qlooEntityId !== 'string' || !row.qlooEntityId || row.qlooEntityId.length > 500 ||
        typeof row.fixtureId !== 'string' || !fixtureIds.includes(row.fixtureId) || typeof row.evidenceRef !== 'string' ||
        !row.evidenceRef || row.evidenceRef.length > 500 || entities.has(row.qlooEntityId)) throw fail();
      const bytes = await secureRead(row.evidenceRef, 4_194_304);
      const capture: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(capture) || capture.status !== 200) throw fail();
      let body: unknown = capture.body;
      if (capture.rawEncoding === 'base64' && typeof capture.rawBody === 'string') {
        const raw = Buffer.from(capture.rawBody, 'base64');
        if (raw.byteLength > 2_097_152 || (typeof capture.digest === 'string' &&
          createHash('sha256').update(raw).digest('hex') !== capture.digest)) throw fail();
        body = JSON.parse(raw.toString('utf8'));
      }
      if (!object(body) || !object(body.results) || !Array.isArray(body.results.entities) ||
        !body.results.entities.some(value => object(value) && value.entity_id === row.qlooEntityId && value.subtype === 'urn:entity:place')) throw fail();
      entities.add(row.qlooEntityId);
      captures.set(row.evidenceRef, { bytes, digest: createHash('sha256').update(bytes).digest('hex') });
      bindings.push({ entity: row.qlooEntityId, fixture: row.fixtureId, evidence: row.evidenceRef });
    }
    const sql = neon(databaseUrl);
    // Lock the same capacity row as live capture writes. Re-import only exact existing evidence/bindings.
    const statements = [sql.query(`select id from ${schema}.provider_state where id=1 for update`)];
    for (const [id, capture] of captures) {
      statements.push(sql.query(`insert into ${schema}.provider_captures(id,raw,digest,metadata,kind)
        values($1,decode($2,'base64'),$3,'{}'::jsonb,'import') on conflict(id) do update
        set digest=case when ${schema}.provider_captures.digest=excluded.digest and ${schema}.provider_captures.kind='import'
          then excluded.digest else 'invalid' end
        returning id`, [id, capture.bytes.toString('base64'), capture.digest]));
    }
    for (const binding of bindings) {
      statements.push(sql.query(`insert into ${schema}.provider_bindings(entity_id,fixture_id,evidence_ref) values($1,$2,$3)
        on conflict(entity_id) do update set fixture_id=case
          when ${schema}.provider_bindings.fixture_id=excluded.fixture_id and ${schema}.provider_bindings.evidence_ref=excluded.evidence_ref
          then excluded.fixture_id else null end
        returning entity_id`, [binding.entity, binding.fixture, binding.evidence]));
    }
    statements.push(sql.query(`update ${schema}.provider_state set allocated_bytes=(select coalesce(sum(octet_length(raw)+octet_length(metadata::text)),0)
      from ${schema}.provider_captures)+(select coalesce(sum(allocated_bytes),0) from ${schema}.provider_attempts where capture_ref is null)
      where id=1 returning id`));
    const results = await sql.transaction(statements, { fetchOptions: { signal: AbortSignal.timeout(20_000) } });
    if (results.some(rows => rows.length !== 1)) throw fail();
    return bindings.length;
  } catch { throw fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw fail();
    await migrateProvider(databaseUrl);
    if (process.argv.includes('--bindings')) {
      const evidenceDir = process.env.PRIVATE_EVIDENCE_DIR;
      if (!evidenceDir) throw fail();
      const fixtures: unknown = JSON.parse(await readFile(new URL('../data/practical/athens.json', import.meta.url), 'utf8'));
      if (!object(fixtures) || !Array.isArray(fixtures.records) || !fixtures.records.every(row => object(row) && typeof row.fixtureId === 'string')) throw fail();
      const count = await importRuntimeEvidence({ databaseUrl, evidenceDir,
        projectRoot: new URL('..', import.meta.url).pathname, fixtureIds: fixtures.records.map(row => (row as { fixtureId: string }).fixtureId) });
      process.stdout.write(`Private bindings imported: ${count}\n`);
    } else process.stdout.write('Provider migration applied; live policy remains unconfigured\n');
  } catch { process.stderr.write('Private runtime migration/import failed\n'); process.exitCode = 1; }
}
