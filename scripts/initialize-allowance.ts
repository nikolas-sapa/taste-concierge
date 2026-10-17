import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

const fail = () => new Error('Application allowance initialization rejected');

/** Explicit operator action only. Runtime role has no table writes or initializer RPC. */
export async function initializeAllowance(options: { databaseUrl: string; policy: unknown; databaseSchema?: string }): Promise<void> {
  const schema = options.databaseSchema ?? 'taste_runtime';
  try {
    if (!options.databaseUrl || !/^taste_runtime(?:_test_[a-f0-9]+)?$/.test(schema)) throw fail();
    const sql = neon(options.databaseUrl);
    const rows = await sql.query(`with locked as materialized (
      select * from ${schema}.provider_state where id=1 for update
    ) update ${schema}.provider_state target set policy=$1::jsonb from locked
      where target.id=locked.id and locked.policy is null and target.policy is null
        and locked.send_id is null and locked.send_until is null
        and not exists(select 1 from ${schema}.provider_reservations where expires_at>clock_timestamp())
        and not exists(select 1 from ${schema}.provider_attempts where state in ('intent','uncertain'))
        and ${schema}.valid_application_policy($1::jsonb,extract(epoch from clock_timestamp())*1000)
      returning target.id`, [JSON.stringify(options.policy)], { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    if (rows.length !== 1) throw fail();
  } catch { throw fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    const file = process.argv[2];
    if (!databaseUrl || !file || !isAbsolute(file) || (await lstat(file)).isSymbolicLink()) throw fail();
    const resolved = await realpath(file);
    const project = await realpath(new URL('..', import.meta.url).pathname);
    const rel = relative(project, resolved);
    const info = await stat(resolved);
    if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) || !info.isFile() ||
      info.size > 65_536 || (info.mode & 0o777) !== 0o600 || ((await stat(dirname(resolved))).mode & 0o777) !== 0o700) throw fail();
    const bytes = await readFile(resolved);
    if (bytes.byteLength > 65_536) throw fail();
    await initializeAllowance({ databaseUrl, policy: JSON.parse(bytes.toString('utf8')) as unknown });
    process.stdout.write('Application allowance initialized once, existing history preserved\n');
  } catch { process.stderr.write('Application allowance initialization rejected\n'); process.exitCode = 1; }
}
