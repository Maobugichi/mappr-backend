// Invoke explicitly with node --import tsx. Importing this module never connects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOperatorConfig, assertOperatorRequest, runS3bCutover, CutoverError } from '../src/db/s3bCutover.ts';

export function readPrivateJson(filename,maxBytes=65536) {
  if (!filename || !path.isAbsolute(filename)) throw new CutoverError('private_configuration_required');
  const resolved=fs.realpathSync(filename);
  const repo=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
  const relative=path.relative(repo,resolved);
  if (relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative))) throw new CutoverError('configuration_must_be_outside_repository');
  if (fs.statSync(resolved).size>maxBytes) throw new CutoverError('invalid_configuration');
  return JSON.parse(fs.readFileSync(resolved,'utf8'));
}

export async function main(args) {
  let pool;
  try {
    const flags = new Map();
    for (let i=0; i<args.length; i+=2) {
      if (!['--mode','--config','--confirm'].includes(args[i]) || !args[i+1] || flags.has(args[i])) throw new CutoverError('invalid_arguments');
      flags.set(args[i],args[i+1]);
    }
    const mode = flags.get('--mode') ?? 'status';
    const filename = flags.get('--config');
    const config = parseOperatorConfig(readPrivateJson(filename));
    assertOperatorRequest(config,mode,flags.get('--confirm'));
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: config.connectionString, ssl: { rejectUnauthorized: config.sslRejectUnauthorized },
      max: 1, connectionTimeoutMillis: 10000 });
    pool.on('error',() => {}); // Never emit raw driver errors to operator logs.
    const result = await runS3bCutover(pool,{ config, mode, confirmation: flags.get('--confirm'),
      baselineSql: fs.readFileSync(new URL('../src/db/baseline/001_existing_schema.sql',import.meta.url),'utf8'),
      migrationSql: fs.readFileSync(new URL('../src/db/migrations/013_current_revision.sql',import.meta.url),'utf8') });
    console.log(JSON.stringify(result));
    return result.readyForBackfill ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof CutoverError ? error.code : 'operator_failed' }));
    return 1;
  } finally {
    if (pool) {
      try { await pool.end(); }
      catch { console.error(JSON.stringify({ error: 'operator_failed' })); return 1; }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
