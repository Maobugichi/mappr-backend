import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import test, { mock } from 'node:test';

// No dotenv, configured database, network, or real PostgreSQL construction.
process.env.DATABASE_URL = 'must-never-be-used';
delete process.env.MAPPR_REVISION_WRITES_ENABLED;
let poolAttempts = 0;
mock.module('pg', { namedExports: { Pool: class { constructor() { poolAttempts++; throw new Error('Real database forbidden'); } } } });
const { runS3bCutover, parseOperatorConfig, assertOperatorRequest } = await import('../../src/db/s3bCutover.ts');
const { planStoredOwnerRevisionBackfill, planRevisionBackfill } = await import('../../src/services/revisionState.ts');
const { backfillStoredOwnerRevisions } = await import('../../src/db/backfillCurrentRevision.ts');
const { main } = await import('../../scripts/s3b-cutover.mjs');
assert.equal(poolAttempts,0,'Import must not initialize a database');

const baselineSql = fs.readFileSync(new URL('../../src/db/baseline/001_existing_schema.sql',import.meta.url),'utf8');
const migrationSql = fs.readFileSync(new URL('../../src/db/migrations/013_current_revision.sql',import.meta.url),'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const mapA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mapB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secret = 'private-sentinel-never-print';
const system = { meta: { productName: secret, oneLineSummary: 'Fixture' }, product: { summary: 'Current', concepts: [] },
  users: [], features: [], techStack: [], architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [] };
const copy = value => structuredClone(value);
const config = { connectionString: `postgresql://operator:${secret}@isolated.invalid:5432/fixture`, sslRejectUnauthorized: true,
  expectedDatabase: 'fixture', expectedRole: 'operator', developmentOnly: true, scope: 'all-existing-development-maps' };
const fingerprint = createHash('sha256').update(JSON.stringify(['isolated.invalid','5432','/fixture','operator','fixture','operator','42'])).digest('hex');
const approved = { ...config, expectedTargetFingerprint: fingerprint,
  approval: { developerApproved: true, backupVerified: true, writersStopped: true, backupEvidence: 'Mock backup evidence', writerStopEvidence: 'Mock stop evidence' } };
const confirmation = 'AUTHORIZE_S3B_DEVELOPMENT_WRITE';

// Independent mock catalog inventory follows the S1 report, not operator output.
function catalog() {
  const col = (name,type,not_null=true,default_expression=null) => ({ column_name:name,data_type:type,not_null,default_expression });
  const id = col('id','uuid',true,'gen_random_uuid()'), mapId = col('map_id','uuid');
  const created = col('created_at','timestamp with time zone',true,'now()'), updated = { ...created,column_name:'updated_at' };
  const review = payload => [id,mapId,col(payload,'jsonb'),created,updated];
  const versioned = payload => [id,mapId,col('version','integer'),col(payload,'jsonb'),created,updated];
  const hashed = payload => [id,mapId,col('tech_arch_hash','text'),col(payload,'jsonb'),created,updated];
  const inventory = {
    maps:[id,col('anon_id','uuid'),col('input_description','text'),col('data','jsonb'),created,updated],
    generations:[id,col('anon_id','uuid'),col('map_id','uuid',false),created],
    map_versions:[id,mapId,col('version','integer'),col('data','jsonb'),col('patch','jsonb',false),col('summary','text'),created],
    architecture_reviews:review('findings'),missing_requirement_reviews:review('findings'),traceability_reviews:review('links'),
    api_contracts:versioned('endpoints'),relational_schemas:versioned('tables'),document_schemas:versioned('collections'),
    adrs:hashed('adrs'),readmes:[id,mapId,col('version','integer'),col('overview','text'),col('getting_started','jsonb'),created,updated],
    env_vars:hashed('vars'),deployments:[id,mapId,col('tech_arch_hash','text'),col('components','jsonb'),col('environments','jsonb'),
      col('cicd_steps','jsonb'),col('migrations','text',false),created,updated],
  };
  const tables = Object.keys(inventory).sort().map(table_name => ({ table_name,relkind:'r',relrowsecurity:false,can_alter:true,can_write:true }));
  const columns = Object.entries(inventory).flatMap(([table_name,cols]) => cols.map(col => ({ table_name,...col })));
  const constraints = [];
  for (const table_name of Object.keys(inventory)) {
    const add = (suffix,contype,definition) => constraints.push({ table_name,conname:`${table_name}_${suffix}`,contype,definition,convalidated:true,condeferrable:false });
    add('pkey','p','PRIMARY KEY (id)');
    if (table_name!=='maps') add('map_id_fkey','f',`FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE ${table_name==='generations'?'SET NULL':'CASCADE'}`);
    if (['architecture_reviews','missing_requirement_reviews','traceability_reviews'].includes(table_name)) add('map_id_key','u','UNIQUE (map_id)');
    if (['map_versions','api_contracts','relational_schemas','document_schemas','readmes'].includes(table_name)) add('map_id_version_key','u','UNIQUE (map_id, version)');
    if (['adrs','env_vars','deployments'].includes(table_name)) add('map_id_tech_arch_hash_key','u','UNIQUE (map_id, tech_arch_hash)');
  }
  const indexes = constraints.filter(row => row.contype!=='f').map(row => ({ table_name:row.table_name,index_name:row.conname,indisvalid:true,indisready:true,
    definition:`CREATE UNIQUE INDEX ${row.conname} ON public.${row.table_name} USING btree ${row.definition.match(/\(.+\)/)[0]}` }));
  for (const [table_name,index_name,cols] of [['maps','idx_maps_anon_id','anon_id'],['generations','idx_generations_anon_id_created_at','anon_id, created_at'],
    ['generations','idx_generations_created_at','created_at'],['map_versions','map_versions_map_id_version_idx','map_id, version DESC']]) {
    indexes.push({ table_name,index_name,indisvalid:true,indisready:true,definition:`CREATE INDEX ${index_name} ON public.${table_name} USING btree (${cols})` });
  }
  return { tables,columns,constraints,indexes,triggers:0 };
}

class Database {
  constructor(columnPresent=false) {
    this.columnPresent=columnPresent; this.catalog=catalog(); this.connections=0; this.releases=0; this.writes=[]; this.queries=[];
    this.identity={ database_name:'fixture',role_name:'operator',database_oid:'42',default_isolation:'read committed',server_version_num:170006 };
    this.state={ maps:[mapA,mapB].map(id => ({ id,anon_id:owner,data:copy(system),current_revision:null,
      input_description:secret,created_at:'original-created',updated_at:'original-updated' })),
      history:[1,2].map(version=>({ map_id:mapB,version,data:copy(system),patch:null,summary:'Original history',created_at:'original-history' })),
      artifacts:[{ content:'saved artifact' }],usage:[{ count:1 }] };
    this.failAt=null; this.beforeLock=null; this.readOnly=false; this.tx=null;
  }
  async connect() { this.connections++; return { query:(...args)=>this.query(...args),release:()=>this.releases++ }; }
  async query(text,values=[]) {
    const sql=text.replace(/--[^\r\n]*/g,'').replace(/\s+/g,' ').trim(); this.queries.push(sql);
    const rows=value=>({ rows:copy(value),rowCount:value.length });
    if (sql.includes('ALTER TABLE public.maps ADD COLUMN')) {
      assert.equal(this.readOnly,false); assert.equal(this.columnPresent,false); this.columnPresent=true; this.writes.push('migration013'); return rows([]);
    }
    if (sql.startsWith('BEGIN')) { assert.equal(this.tx,null); this.readOnly=sql.includes('READ ONLY'); this.tx=copy(this.state); return rows([]); }
    if (sql.startsWith('SET LOCAL')) { assert.ok(this.tx); return rows([]); }
    if (sql==='ROLLBACK') { this.tx=null; this.readOnly=false; return rows([]); }
    if (sql==='COMMIT') { assert.ok(this.tx); this.state=this.tx; this.tx=null; this.readOnly=false; return rows([]); }
    if (sql.includes('current_database() AS database_name')) return rows([this.identity]);
    if (sql.includes('c.relkind IN')) return rows(this.catalog.tables);
    if (sql.includes('FROM pg_catalog.pg_attribute')) return rows([...this.catalog.columns,...(this.columnPresent
      ? [{table_name:'maps',column_name:'current_revision',data_type:'integer',not_null:false,default_expression:null}] : [])]);
    if (sql.includes('FROM pg_catalog.pg_constraint')) return rows(this.catalog.constraints);
    if (sql.includes('FROM pg_catalog.pg_index')) return rows(this.catalog.indexes);
    if (sql.includes('FROM pg_catalog.pg_trigger')) return rows([{triggers:this.catalog.triggers}]);
    if (sql.startsWith('SELECT id,anon_id,data,')) return rows(this.tx.maps);
    if (sql.startsWith('SELECT v.map_id')) return rows(this.tx.history.map(row=>({ ...row,
      matches_current:isDeepStrictEqual(row.data,this.tx.maps.find(m=>m.id===row.map_id)?.data) })));
    if (sql.includes('FROM public.maps WHERE id = $1 FOR UPDATE')) {
      assert.equal(this.readOnly,false); if(this.beforeLock)this.beforeLock(this.tx,values[0]);
      return rows(this.tx.maps.filter(row=>row.id===values[0]));
    }
    if (sql.startsWith('SELECT version, data,')) return rows(this.tx.history.filter(row=>row.map_id===values[0])
      .map(row=>({ ...row,matches_current:isDeepStrictEqual(row.data,JSON.parse(values[1])) })));
    if (sql.startsWith('INSERT INTO public.map_versions')) {
      assert.equal(this.readOnly,false); this.writes.push('snapshot');
      this.tx.history.push({ map_id:values[0],version:1,data:JSON.parse(values[1]),patch:null,
        summary:'Initial generation (reviewed revision backfill)',created_at:'backfill-time' });
      return {rows:[],rowCount:1};
    }
    if (sql.startsWith('UPDATE public.maps SET current_revision')) {
      assert.equal(this.readOnly,false); this.writes.push('counter');
      if (this.failAt===values[1]) { this.failAt=null; throw new Error(`${secret} ${values[1]}`); }
      this.tx.maps.find(row=>row.id===values[1]).current_revision=values[0]; return {rows:[],rowCount:1};
    }
    throw new Error('Unexpected statement in offline mock');
  }
}
const run = (db,mode='status',extra={}) => runS3bCutover(db,{config:mode==='status'?config:approved,mode,
  ...(mode==='status'?{}:{confirmation}),baselineSql,migrationSql,...extra});
const refuses = (work,code) => assert.rejects(work,error=>error.code===code);

test('S3B status uses READ ONLY and returns counts without identities or payloads',async()=>{
  const db=new Database(),before=copy(db.state);
  const result=await run(db);
  assert.deepEqual(result.summary,{maps:2,snapshots:2,initialize:1,match:1,unchanged:0,quarantined:0,reasons:{}});
  assert.equal(result.targetFingerprint,fingerprint); assert.equal(result.targetPinned,false); assert.equal(result.revisionReady,false);
  assert.deepEqual(db.state,before); assert.deepEqual(db.writes,[]); assert.equal(db.connections,1); assert.equal(db.releases,1);
  assert.ok(db.queries[0].includes('READ ONLY')); assert.ok(db.queries.includes("SET LOCAL statement_timeout='10s'"));
  assert.ok(db.queries.includes("SET LOCAL lock_timeout='1s'")); assert.equal(db.tx,null);
  for(const value of [secret,owner,mapA,mapB,'fixture','operator'])assert.equal(JSON.stringify(result).includes(value),false);
});

test('S3B unapproved writes fail before connecting, irrespective of application DATABASE_URL',async t=>{
  for(const mode of ['migrate','backfill'])for(const variant of ['no approval','no target pin','no confirmation','wrong confirmation','backup false','writers false']){
    await t.test(`${mode}: ${variant}`,async()=>{
      const db=new Database(); const cfg=copy(approved); let token=confirmation;
      if(variant==='no approval')delete cfg.approval;
      if(variant==='no target pin')delete cfg.expectedTargetFingerprint;
      if(variant==='no confirmation')token=undefined;
      if(variant==='wrong confirmation')token='yes';
      if(variant==='backup false')cfg.approval.backupVerified=false;
      if(variant==='writers false')cfg.approval.writersStopped=false;
      await assert.rejects(()=>run(db,mode,{config:cfg,confirmation:token}));
      assert.equal(db.connections,0); assert.deepEqual(db.writes,[]);
    });
  }
});

test('S3B configuration requires explicit credentials and a narrow development scope',async t=>{
  for(const [name,overrides] of [['missing URL',{connectionString:undefined}],['missing password',{connectionString:'postgresql://operator@isolated.invalid/fixture'}],
    ['missing database',{connectionString:`postgresql://operator:${secret}@isolated.invalid/`}],['URL options',{connectionString:config.connectionString+'?options=unsafe'}],
    ['nondevelopment',{developmentOnly:false}],['unknown property',{DATABASE_URL:config.connectionString}],['wrong scope',{scope:'all'}]]){
    await t.test(name,()=>assert.throws(()=>parseOperatorConfig({...config,...overrides}),error=>error.code==='invalid_configuration'));
  }
  assert.throws(()=>assertOperatorRequest(config,'other'),error=>error.code==='invalid_mode');
});

test('S3B rejects actual target and isolation mismatches before any mutation',async t=>{
  for(const [name,edit,expected] of [['database',db=>db.identity.database_name='other','target_mismatch'],
    ['role',db=>db.identity.role_name='other','target_mismatch'],['fingerprint',db=>db.identity.database_oid='43','target_mismatch'],
    ['isolation',db=>db.identity.default_isolation='repeatable read','incorrect_isolation']]){
    await t.test(name,async()=>{const db=new Database();edit(db);await refuses(()=>run(db,'migrate'),expected);assert.deepEqual(db.writes,[]);assert.equal(db.tx,null);});
  }
});

test('S3B fails closed for unsupported schema and an unexpected existing column',async t=>{
  for(const [name,edit] of [['column',db=>db.catalog.columns.find(row=>row.table_name==='maps'&&row.column_name==='anon_id').not_null=false],
    ['unique history key',db=>db.catalog.constraints=db.catalog.constraints.filter(row=>row.conname!=='map_versions_map_id_version_key')],
    ['invalid index',db=>db.catalog.indexes[0].indisvalid=false],['trigger',db=>db.catalog.triggers=1],
    ['unknown table',db=>db.catalog.tables.push({table_name:'unknown',relkind:'r',relrowsecurity:false})]]){
    await t.test(name,async()=>{const db=new Database();edit(db);await refuses(()=>run(db,'migrate'),'unknown_schema');assert.deepEqual(db.writes,[]);});
  }
  const db=new Database(true);await refuses(()=>run(db,'migrate'),'unexpected_revision_column');assert.deepEqual(db.writes,[]);
  const missing=new Database();await refuses(()=>run(missing,'backfill'),'migration_required');assert.deepEqual(missing.writes,[]);
  await refuses(()=>run(new Database(),'migrate',{migrationSql:migrationSql+'\nDELETE FROM maps;'}),'unexpected_migration');
});

test('S3B bookkeeping eligibility validates owner metadata without implying browser ownership',async t=>{
  const base={anonId:owner,data:copy(system),currentRevision:null,snapshots:[]};
  assert.deepEqual(planStoredOwnerRevisionBackfill(base),{action:'initialize',revision:1});
  assert.deepEqual(planRevisionBackfill({...base,verifiedOwnerId:undefined}),{action:'quarantine',reason:'unknown_owner'});
  for(const anonId of [null,undefined,'not-a-uuid'])await t.test(`invalid owner metadata ${String(anonId)}`,()=>{
    assert.deepEqual(planStoredOwnerRevisionBackfill({...base,anonId}),{action:'quarantine',reason:'invalid_owner_metadata'});
  });
});

test('S3B quarantines a bad full inventory before migration or any backfill writes',async t=>{
  for(const [name,edit,reason] of [['owner metadata',db=>db.state.maps[0].anon_id=null,'invalid_owner_metadata'],
    ['current payload',db=>db.state.maps[0].data={},'invalid_system'],
    ['historical payload',db=>db.state.history[0].data={},'invalid_history'],
    ['noncontiguous history',db=>db.state.history[1].version=3,'invalid_history'],
    ['nonpositive history',db=>db.state.history[0].version=0,'invalid_history'],
    ['snapshot mismatch',db=>db.state.maps[1].data.product.summary='Unsnapshotted','snapshot_mismatch']]){
    await t.test(name,async()=>{
      const db=new Database();edit(db);const before=copy(db.state);const status=await run(db);
      assert.equal(status.readyForBackfill,false);assert.equal(status.summary.reasons[reason],1);
      await refuses(()=>run(db,'migrate'),'quarantined_inventory');db.columnPresent=true;
      await refuses(()=>run(db,'backfill'),'quarantined_inventory');assert.deepEqual(db.state,before);assert.deepEqual(db.writes,[]);
    });
  }
});

test('S3B approved mock migration applies only 013, then backfill preserves existing records and restarts unchanged',async()=>{
  const db=new Database(),before=copy(db.state);
  const migrated=await run(db,'migrate');assert.equal(migrated.columnPresent,true);assert.deepEqual(db.state,before);assert.deepEqual(db.writes,['migration013']);
  const done=await run(db,'backfill');assert.equal(done.revisionReady,true);assert.equal(done.summary.unchanged,2);
  assert.deepEqual(db.state.maps.map(row=>row.current_revision),[1,2]);
  assert.deepEqual(db.state.maps.map(({current_revision,...row})=>row),before.maps.map(({current_revision,...row})=>row));
  assert.deepEqual(db.state.history.filter(row=>row.map_id===mapB),before.history);
  assert.deepEqual(db.state.history.find(row=>row.map_id===mapA).data,before.maps[0].data);
  assert.deepEqual(db.state.artifacts,before.artifacts);assert.deepEqual(db.state.usage,before.usage);
  const writes=db.writes.length,completed=copy(db.state);const replay=await run(db,'backfill');
  assert.equal(replay.revisionReady,true);assert.equal(db.writes.length,writes);assert.deepEqual(db.state,completed);
  assert.equal(db.connections,db.releases);assert.equal(db.tx,null);
});

test('S3B SQL failure rolls back that map, keeps earlier commits and allows a safe restart',async()=>{
  const db=new Database(true);db.failAt=mapB;const original=copy(db.state);
  await refuses(()=>run(db,'backfill'),'operator_failed');
  assert.equal(db.state.maps[0].current_revision,1);assert.equal(db.state.maps[1].current_revision,null);
  assert.deepEqual(db.state.history.filter(row=>row.map_id===mapB),original.history);
  assert.equal(db.state.history.filter(row=>row.map_id===mapA).length,1);assert.equal(db.tx,null);
  const done=await run(db,'backfill');assert.equal(done.revisionReady,true);
  assert.equal(db.state.history.filter(row=>row.map_id===mapA).length,1);
});

test('S3B locked metadata recheck stops and preserves an external owner change',async()=>{
  const db=new Database(true);db.beforeLock=(state,id)=>{if(id===mapA){
    // An independent commit is visible at the later READ COMMITTED lock read;
    // it must persist even though maintenance itself makes no writes.
    db.state.maps.find(row=>row.id===id).anon_id=other;
    state.maps.find(row=>row.id===id).anon_id=other;
  }};
  const before=copy(db.state);await refuses(()=>run(db,'backfill'),'operator_failed');
  before.maps.find(row=>row.id===mapA).anon_id=other;
  assert.deepEqual(db.state,before);assert.deepEqual(db.writes,[]);
});

test('S3B missing or case-duplicate maintenance candidates fail safely',async()=>{
  const db=new Database(true);
  await assert.rejects(()=>backfillStoredOwnerRevisions(db,[{mapId:null,expectedStoredOwnerId:owner}]));assert.equal(db.connections,0);
  await assert.rejects(()=>backfillStoredOwnerRevisions(db,[mapA,mapA.toUpperCase()].map(mapId=>({mapId,expectedStoredOwnerId:owner}))));assert.equal(db.connections,0);
  await assert.rejects(()=>backfillStoredOwnerRevisions(db,[{mapId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expectedStoredOwnerId:owner}]));
  assert.deepEqual(db.writes,[]);
});

test('S3B CLI refuses unsafe requests before constructing pg and prints no private input',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mappr-s3b-offline-'));
  const filename=path.join(dir,'operator.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const output=[];const log=mock.method(console,'log',value=>output.push(value)),error=mock.method(console,'error',value=>output.push(value));
  try{
    assert.equal(await main(['--mode','migrate','--config',filename,'--confirm',confirmation]),1);
    assert.equal(await main(['--mode','status']),1);
    assert.equal(await main(['--config',filename,'--mode','backfill']),1);
    assert.equal(poolAttempts,0);
    for(const value of [secret,owner,mapA,mapB,filename,config.connectionString])assert.equal(output.join('\n').includes(value),false);
    assert.ok(output.some(value=>value.includes('execution_not_approved')));
  }finally{log.mock.restore();error.mock.restore();fs.unlinkSync(filename);fs.rmdirSync(dir);}
});
