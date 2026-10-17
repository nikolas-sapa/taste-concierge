import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

// Split only outside SQL strings, line comments and dollar-quoted function bodies.
export function migrationStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0; let quote = ''; let comment = false;
  for (let i = 0; i < source.length; i++) {
    if (comment) { if (source[i] === '\n') comment = false; continue; }
    if (quote) {
      if (source.startsWith(quote, i)) {
        if (quote === "'" && source[i + 1] === "'") { i++; continue; }
        i += quote.length - 1; quote = '';
      }
      continue;
    }
    if (source.startsWith('--', i)) { comment = true; i++; continue; }
    if (source[i] === "'") { quote = "'"; continue; }
    const dollar = source.slice(i).match(/^\$[A-Za-z_0-9]*\$/)?.[0];
    if (dollar) { quote = dollar; i += dollar.length - 1; continue; }
    if (source[i] === ';') { const statement = source.slice(start, i).trim(); if (statement) statements.push(statement); start = i + 1; }
  }
  const tail = source.slice(start).trim();
  if (tail) statements.push(tail);
  if (quote) throw new Error('Invalid migration source');
  return statements;
}
export async function migrateRuntime(databaseUrl: string): Promise<void> {
  const source = await readFile(new URL('../migrations/001-runtime.sql', import.meta.url), 'utf8');
  try {
    const sql = neon(databaseUrl);
    await sql.transaction(migrationStatements(source).map(statement => sql.query(statement)), {
      fetchOptions: { signal: AbortSignal.timeout(20_000) },
    });
  } catch { throw new Error('Runtime migration failed'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { process.stderr.write('Migration database configuration missing\n'); process.exitCode = 1; }
  else {
    try { await migrateRuntime(databaseUrl); process.stdout.write('Runtime migration applied\n'); }
    catch { process.stderr.write('Runtime migration failed\n'); process.exitCode = 1; }
  }
}
