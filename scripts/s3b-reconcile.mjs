// Explicit one-use command only; imports never construct a pool or touch files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CutoverError } from '../src/db/s3bCutover.ts';
import { readPrivateJson } from './s3b-cutover.mjs';
import { ReconciliationError } from './lib/s3b-reconciliation.mjs';
import { assertRestricted,FileEvidenceStore } from './lib/s3b-private-evidence.mjs';
import { assertReconciliationRequest,runReconciliation,ExecutorError } from './lib/s3b-reconciliation-executor.mjs';

export async function main(args) {
  let pool;
  try {
    const flags=new Map();
    for (let i=0;i<args.length;i+=2) {
      if (!['--mode','--config','--review','--evidence','--confirm'].includes(args[i]) || !args[i+1] || flags.has(args[i])) throw new ReconciliationError('invalid_arguments');
      flags.set(args[i],args[i+1]);
    }
    const mode=flags.get('--mode')??'validate';
    const config=readPrivateJson(flags.get('--config')),packet=readPrivateJson(flags.get('--review'),8*1024*1024);
    assertReconciliationRequest(config,mode,flags.get('--confirm'),packet);
    assertRestricted(fs.realpathSync(flags.get('--config')));assertRestricted(fs.realpathSync(flags.get('--review')));
    if (mode==='execute' && !flags.get('--evidence')) throw new ReconciliationError('private_evidence_required');
    const evidenceStore=flags.get('--evidence')?new FileEvidenceStore(flags.get('--evidence')):undefined;
    const { Pool }=await import('pg');
    pool=new Pool({connectionString:config.connectionString,ssl:{rejectUnauthorized:config.sslRejectUnauthorized},max:1,connectionTimeoutMillis:10000});
    pool.on('error',()=>{});
    const result=await runReconciliation(pool,{config,packet,mode,confirmation:flags.get('--confirm'),evidenceStore,
      baselineSql:fs.readFileSync(new URL('../src/db/baseline/001_existing_schema.sql',import.meta.url),'utf8')});
    console.log(JSON.stringify(result));return 0;
  } catch (error) {
    const code=error instanceof ExecutorError || error instanceof CutoverError || error instanceof ReconciliationError?error.code:'reconciliation_failed';
    console.error(JSON.stringify({error:code,...(error instanceof ExecutorError?{progress:error.progress}:{})}));return 1;
  } finally {
    if (pool) try {await pool.end();} catch {console.error(JSON.stringify({error:'reconciliation_failed'}));return 1;}
  }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=await main(process.argv.slice(2));
