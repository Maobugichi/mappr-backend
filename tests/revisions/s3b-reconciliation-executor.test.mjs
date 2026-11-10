import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test,{mock} from 'node:test';

process.env.DATABASE_URL='never-connect';
let poolAttempts=0;
mock.module('pg',{namedExports:{Pool:class{constructor(){poolAttempts++;throw new Error('Real database forbidden');}}}});
const {buildReconciliationReview}=await import('../../scripts/lib/s3b-reconciliation.mjs');
const {runReconciliation}=await import('../../scripts/lib/s3b-reconciliation-executor.mjs');
const {readPrivateJson}=await import('../../scripts/s3b-cutover.mjs');
const {privateEvidencePath}=await import('../../scripts/lib/s3b-private-evidence.mjs');
assert.equal(poolAttempts,0);
const copy=value=>structuredClone(value),owner='11111111-1111-4111-8111-111111111111';
const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const target=createHash('sha256').update(JSON.stringify(['isolated.invalid','5432','/fixture','operator','fixture','operator','42'])).digest('hex');
const config={connectionString:'postgresql://operator:private-sentinel@isolated.invalid:5432/fixture',sslRejectUnauthorized:true,
  expectedDatabase:'fixture',expectedRole:'operator',expectedTargetFingerprint:target,developmentOnly:true,scope:'all-existing-development-maps'};
const approved={...config,approval:{developerApproved:true,backupVerified:true,writersStopped:true,backupEvidence:'offline fixture',writerStopEvidence:'offline fixture'}};
const confirmation='AUTHORIZE_S3B_RECONCILIATION_WRITE';
const baselineSql=fs.readFileSync(new URL('../../src/db/baseline/001_existing_schema.sql',import.meta.url),'utf8');
const base={meta:{productName:'private-sentinel',oneLineSummary:''},product:{summary:'',concepts:[]},users:[],features:[],techStack:[],
  architecture:{nodes:[],edges:[]},dataModel:{entities:[],relations:[]},designSystem:{colors:[],typography:[],spacing:[],components:[]},developmentPlan:[]};

// Catalog adapter serves the existing tested baseline as metadata, never SQL DDL.
function catalog(){
  const tables=[],columns=[],constraints=[],indexes=[];
  for(const [,table,body] of baselineSql.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)){
    tables.push({table_name:table,relkind:'r',relrowsecurity:false,can_alter:true,can_write:true});
    for(const line of body.split('\n').map(s=>s.trim().replace(/,$/,'')).filter(Boolean)){
      const c=line.match(/^(\w+) (uuid|integer|text|jsonb|timestamptz)( NOT NULL)?(?: DEFAULT (.+))?$/);
      if(c){columns.push({table_name:table,column_name:c[1],data_type:c[2],not_null:Boolean(c[3]),default_expression:c[4]??null});continue;}
      const m=line.match(/^CONSTRAINT (\w+) (PRIMARY KEY|UNIQUE|FOREIGN KEY) (.+)$/),type=m[2]==='PRIMARY KEY'?'p':m[2]==='UNIQUE'?'u':'f';
      constraints.push({table_name:table,conname:m[1],contype:type,convalidated:true,condeferrable:false,definition:m[2]+' '+m[3]});
      if(type!=='f')indexes.push({table_name:table,index_name:m[1],indisvalid:true,indisready:true,definition:`CREATE UNIQUE INDEX ${m[1]} ON public.${table} USING btree ${m[3]}`});
    }
  }
  for(const [,name,table,cols] of baselineSql.matchAll(/CREATE INDEX (\w+) ON public\.(\w+) USING btree \(([^)]+)\);/g))indexes.push({table_name:table,index_name:name,indisvalid:true,indisready:true,definition:`CREATE INDEX ${name} ON public.${table} USING btree (${cols})`});
  return{tables,columns,constraints,indexes};
}
function fixtures(){
  return Array.from({length:14},(_,i)=>{
    const data=copy(base);data.unrelated={retain:['original',null,17]};
    if(i<13)data.developmentPlan=[{phase:1,title:'Phase',items:Array.from({length:i===0?11:10},(_,j)=>`  private task ${i}/${j}\r\n 🧭  `)}];
    if(i<3)data.architecture.nodes=Array.from({length:i===2?9:8},(_,j)=>({id:'node-'+j,label:'Existing label '+j,type:'service'}));
    return{mapId:id(i+1),ownerId:owner,data,dataJsonbText:JSON.stringify(data),inputDescription:'private-sentinel',createdAt:'created-original',updatedAt:'updated-original'};
  });
}
const source=row=>({mapId:row.mapId,ownerId:row.ownerId,data:row.data,dataJsonbText:row.dataJsonbText});
function packet(rows){const p=buildReconciliationReview(rows.map(source),target);p.taskPolicy.approved=true;
  for(const map of p.architecture)for(const node of map.nodes){node.approved=true;node.proposedDescription='Reviewed synthetic behavior for '+node.nodeId;}
  return p;
}
function patch(original,values,start=0){
  const candidate=copy(original);
  for(let i=start;i<values.length;){const path=values[i++];assert.ok(Array.isArray(path));let parent=candidate,old=original;
    for(const part of path.slice(0,-1)){parent=parent[part];old=old[part];}
    const last=path.at(-1);parent[last]=path[0]==='developmentPlan'?{description:old[last],relatedFeatures:[]}:values[i++];
  }
  return candidate;
}
class Database{
  constructor(){this.rows=fixtures();this.history=[{mapId:id(14),version:1,data:copy(this.rows[13].data)}];this.catalog=catalog();
    this.column=false;this.connections=0;this.releases=0;this.queries=[];this.updates=0;this.lockReads=0;this.tx=null;this.failMap=null;
    this.uncertainMap=null;this.zeroRow=false;this.tamperTimestamp=false;this.onLock=null;
    this.identity={database_name:'fixture',role_name:'operator',database_oid:'42',default_isolation:'read committed',server_version_num:170006};}
  async connect(){this.connections++;return{query:(...args)=>this.query(...args),release:()=>this.releases++};}
  async query(text,values=[]){
    const sql=text.replace(/\s+/g,' ').trim();this.queries.push(sql);const result=rows=>({rows:copy(rows),rowCount:rows.length});
    if(sql.startsWith('BEGIN')){assert.equal(this.tx,null);this.tx={readOnly:sql.includes('READ ONLY'),updates:new Map(),locks:new Set()};return result([]);}
    if(sql.startsWith('SET LOCAL')){assert.ok(this.tx);return result([]);}
    if(sql==='ROLLBACK'){this.tx=null;return result([]);}
    if(sql==='COMMIT'){
      const changed=[...this.tx.updates.keys()];for(const [key,row]of this.tx.updates)this.rows[this.rows.findIndex(r=>r.mapId===key)]=copy(row);
      this.tx=null;if(changed.includes(this.uncertainMap)){this.uncertainMap=null;throw new Error('private-sentinel uncertain commit');}return result([]);
    }
    if(sql.includes('current_database() AS database_name'))return result([this.identity]);
    if(sql.includes('c.relkind IN'))return result(this.catalog.tables);
    if(sql.includes('FROM pg_catalog.pg_attribute'))return result([...this.catalog.columns,...(this.column?[{table_name:'maps',column_name:'current_revision',data_type:'integer',not_null:false,default_expression:null}]:[])]);
    if(sql.includes('FROM pg_catalog.pg_constraint'))return result(this.catalog.constraints);
    if(sql.includes('FROM pg_catalog.pg_index'))return result(this.catalog.indexes);
    if(sql.includes('FROM pg_catalog.pg_trigger'))return result([{triggers:0}]);
    if(sql.startsWith('/* reconcile:inventory */'))return result(this.rows);
    if(sql.startsWith('/* reconcile:history */'))return result(this.history.map(row=>({...row,matches_current:isDeepStrictEqual(row.data,this.rows.find(m=>m.mapId===row.mapId)?.data)})));
    if(sql.startsWith('/* reconcile:project */')){const data=patch(JSON.parse(values[0]),values.slice(1));
      if(this.tamperProjection && data.architecture.nodes.length)data.architecture.nodes[0].description='Unapproved replacement';
      return result([{data,dataJsonbText:JSON.stringify(data)}]);}
    if(sql.startsWith('/* reconcile:compare */')){
      if(sql.endsWith('FOR UPDATE')){assert.equal(this.tx.readOnly,false);this.lockReads++;this.tx.locks.add(values[0]);if(this.onLock)this.onLock(this,values[0]);}
      const row=this.tx?.updates.get(values[0])??this.rows.find(row=>row.mapId===values[0]);
      return result(row?[{...row,matches_original:isDeepStrictEqual(row.data,JSON.parse(values[1])),matches_candidate:isDeepStrictEqual(row.data,JSON.parse(values[2]))}]:[]);
    }
    if(sql.startsWith('/* reconcile:locked-history */'))return result([{count:this.history.filter(row=>row.mapId===values[0]).length}]);
    if(sql.startsWith('/* reconcile:update */')){
      assert.equal(this.tx.readOnly,false);const [mapId,ownerId,before,after]=values.slice(-4);assert.ok(this.tx.locks.has(mapId));this.updates++;
      if(this.failMap===mapId){this.failMap=null;throw new Error('private-sentinel SQL failure');}
      if(this.zeroRow)return{rows:[],rowCount:0};
      const original=this.rows.find(row=>row.mapId===mapId);assert.equal(original.ownerId,ownerId);assert.deepEqual(original.data,JSON.parse(before));
      const data=patch(original.data,values.slice(0,-4)),row={...copy(original),data,dataJsonbText:JSON.stringify(data)};
      if(this.tamperTimestamp)row.updatedAt='unexpected';this.tx.updates.set(mapId,row);
      return result([{...row,matches_candidate:isDeepStrictEqual(data,JSON.parse(after))}]);
    }
    throw new Error('Unexpected SQL in offline executor mock');
  }
}
class Evidence{constructor(){this.value=null;this.saves=0;this.fail=false;}async read(){return copy(this.value);}async save(value){if(this.fail)throw new Error('private-sentinel evidence failure');this.value=copy(value);this.saves++;}}
const run=(db,mode='validate',extra={})=>runReconciliation(db,{config:mode==='execute'?approved:config,packet:packet(fixtures()),mode,
  ...(mode==='execute'?{confirmation}:{}),baselineSql,...extra});
const refused=(work,code)=>assert.rejects(work,error=>error.code===code);

test('read-only validate covers the complete cohort without DB DML or evidence writes',async()=>{
  const db=new Database(),store=new Evidence(),before=copy(db.rows);const result=await run(db,'validate',{evidenceStore:store});
  assert.equal(result.validated,13);assert.equal(result.tasks,131);assert.equal(result.descriptions,25);assert.equal(result.original,13);assert.equal(result.simulatedQuarantine,0);
  assert.equal(db.updates,0);assert.equal(db.lockReads,0);assert.equal(store.saves,0);assert.deepEqual(db.rows,before);assert.equal(db.connections,db.releases);
  assert.ok(db.queries.filter(sql=>sql.startsWith('BEGIN')).every(sql=>sql.includes('READ ONLY')));
  for(const privateValue of ['private-sentinel',owner,id(1),'private task'])assert.equal(JSON.stringify(result).includes(privateValue),false);
});

test('write approvals, confirmation, pinned target, evidence and complete description approvals gate connection',async t=>{
  for(const name of ['developer','backup','writers','confirmation','pin','evidence','node approval','policy approval'])await t.test(name,async()=>{
    const db=new Database(),cfg=copy(approved),review=packet(fixtures());const args={config:cfg,evidenceStore:new Evidence(),packet:review};
    if(name==='developer')delete cfg.approval;
    if(name==='backup')cfg.approval.backupVerified=false;
    if(name==='writers')cfg.approval.writersStopped=false;
    if(name==='confirmation')args.confirmation='yes';
    if(name==='pin')delete cfg.expectedTargetFingerprint;
    if(name==='evidence')args.evidenceStore=undefined;
    if(name==='node approval')review.architecture[0].nodes[0].approved=false;
    if(name==='policy approval')review.taskPolicy.approved=false;
    await assert.rejects(()=>run(db,'execute',args));assert.equal(db.connections,0);assert.equal(db.updates,0);
  });
});

test('stale raw source, owner, node context, malformed packet, unknown targets and target mismatch refuse all writes',async t=>{
  for(const name of ['source','owner','context','packet','unknown','target'])await t.test(name,async()=>{
    const db=new Database(),review=packet(fixtures()),store=new Evidence();
    if(name==='source'){db.rows[0].data.product.summary='changed';db.rows[0].dataJsonbText=JSON.stringify(db.rows[0].data);}
    if(name==='owner')db.rows[0].ownerId='22222222-2222-4222-8222-222222222222';
    if(name==='context')review.architecture[0].nodes[0].label='changed';
    if(name==='packet')review.extra='unexpected';
    if(name==='unknown')review.sources[0].mapId=id(90);
    if(name==='target')db.identity.database_oid='changed';
    await assert.rejects(()=>run(db,'execute',{packet:review,evidenceStore:store}));assert.equal(db.updates,0);assert.equal(store.saves,0);
  });
});

test('quarantine, history and schema surprises are rejected globally before updates',async t=>{
  for(const name of ['invalid unrelated map','history on selected','history gap','column','schema'])await t.test(name,async()=>{
    const db=new Database(),store=new Evidence();
    if(name==='invalid unrelated map'){db.rows[13].data={};db.rows[13].dataJsonbText='{}';}
    if(name==='history on selected')db.history.push({mapId:id(1),version:1,data:copy(base)});
    if(name==='history gap')db.history[0].version=3;
    if(name==='column')db.column=true;
    if(name==='schema')db.catalog.columns[0].not_null=false;
    await assert.rejects(()=>run(db,'execute',{evidenceStore:store}));assert.equal(db.updates,0);assert.equal(store.saves,0);
  });
});

test('SQL projection must match the exact approved description, not merely its schema',async()=>{
  const db=new Database(),store=new Evidence();db.tamperProjection=true;
  await refused(()=>run(db,'execute',{evidenceStore:store}),'candidate_invalid');
  assert.equal(db.updates,0);assert.equal(store.saves,0);
});

test('mock execution persists original evidence first and changes only approved JSONB paths',async()=>{
  const db=new Database(),store=new Evidence(),before=copy(db.rows),history=copy(db.history);
  const result=await run(db,'execute',{evidenceStore:store});assert.equal(result.applied,13);assert.equal(result.remaining,0);assert.equal(store.saves,1);assert.equal(store.value.originals.length,13);
  assert.equal(db.lockReads,13);assert.equal(db.updates,13);assert.deepEqual(db.history,history);
  for(let i=0;i<13;i++){
    const {data,dataJsonbText,...metadata}=db.rows[i],{data:old,dataJsonbText:oldText,...oldMetadata}=before[i];assert.deepEqual(metadata,oldMetadata);assert.deepEqual(data.unrelated,old.unrelated);
    assert.deepEqual(data.developmentPlan[0].items.map(item=>Buffer.from(item.description)),old.developmentPlan[0].items.map(item=>Buffer.from(item)));
  }
  assert.deepEqual(db.rows[13],before[13]);assert.equal(db.connections,db.releases);assert.equal(db.tx,null);
  const updateSql=db.queries.find(sql=>sql.startsWith('/* reconcile:update */'));
  assert.match(updateSql,/UPDATE public\.maps SET data=jsonb_set/);assert.match(updateSql,/data #>/);assert.doesNotMatch(updateSql,/SET (?:updated_at|anon_id)|INSERT|DELETE|ALTER/);
  const updates=db.updates,replayed=await run(db,'execute',{evidenceStore:store});assert.equal(replayed.applied,0);assert.equal(replayed.alreadyApplied,13);assert.equal(db.updates,updates);assert.equal(store.saves,1);
});

test('per-map failure keeps earlier commits and restart recognizes completed maps',async()=>{
  const db=new Database(),store=new Evidence();db.failMap=id(3);
  await assert.rejects(()=>run(db,'execute',{evidenceStore:store}),error=>error.code==='reconciliation_failed'&&error.progress.applied===2&&error.progress.remaining===11&&!error.message.includes('private-sentinel'));
  assert.equal(typeof db.rows[0].data.developmentPlan[0].items[0],'object');assert.equal(typeof db.rows[2].data.developmentPlan[0].items[0],'string');assert.equal(db.tx,null);
  const done=await run(db,'execute',{evidenceStore:store});assert.equal(done.alreadyApplied,2);assert.equal(done.applied,11);
});

test('uncertain COMMIT is reconciled from original evidence without duplicate updates',async()=>{
  const db=new Database(),store=new Evidence();db.uncertainMap=id(2);
  await assert.rejects(()=>run(db,'execute',{evidenceStore:store}),error=>error.progress.applied===1);
  assert.equal(typeof db.rows[1].data.developmentPlan[0].items[0],'object');const writes=db.updates;
  const done=await run(db,'execute',{evidenceStore:store});assert.equal(done.alreadyApplied,2);assert.equal(done.applied,11);assert.equal(db.updates,writes+11);
});

test('third state and changed approval evidence are never silently overwritten',async()=>{
  const db=new Database(),store=new Evidence();await run(db,'execute',{evidenceStore:store});
  db.rows[0].data.product.summary='external third state';db.rows[0].dataJsonbText=JSON.stringify(db.rows[0].data);const writes=db.updates;
  await refused(()=>run(db,'execute',{evidenceStore:store}),'unexpected_third_state');assert.equal(db.updates,writes);
  const other=new Database(),journal=new Evidence();await run(other,'execute',{evidenceStore:journal});
  const changed=packet(fixtures());changed.architecture[0].nodes[0].proposedDescription='different reviewed text';
  await refused(()=>run(other,'execute',{packet:changed,evidenceStore:journal}),'invalid_evidence');
});

test('row-lock rechecks catch new history, changed owner and revision-column races',async t=>{
  for(const name of ['history','owner','column'])await t.test(name,async()=>{
    const db=new Database(),store=new Evidence();db.onLock=(db,key)=>{
      if(key!==id(1))return;
      if(name==='history')db.history.push({mapId:key,version:1,data:copy(base)});
      if(name==='owner')db.rows[0].ownerId='22222222-2222-4222-8222-222222222222';
      if(name==='column')db.column=true;
    };
    await assert.rejects(()=>run(db,'execute',{evidenceStore:store}));assert.equal(db.updates,0);assert.equal(db.tx,null);
  });
});

test('durability failure, zero affected rows and timestamp drift stop safely',async t=>{
  for(const name of ['evidence','zero rows','timestamp'])await t.test(name,async()=>{
    const db=new Database(),store=new Evidence(),before=copy(db.rows);
    if(name==='evidence')store.fail=true;if(name==='zero rows')db.zeroRow=true;if(name==='timestamp')db.tamperTimestamp=true;
    await assert.rejects(()=>run(db,'execute',{evidenceStore:store}));assert.deepEqual(db.rows,before);assert.equal(db.tx,null);
  });
});

test('private path safeguards reject in-repository config and evidence',()=>{
  const filename=fileURLToPath(new URL('../../package.json',import.meta.url));
  assert.throws(()=>readPrivateJson(filename),error=>error.code==='configuration_must_be_outside_repository');
  assert.throws(()=>privateEvidencePath(filename),error=>error.code==='evidence_must_be_outside_repository');
});

test('CLI import and unapproved execution do not construct a pool or leak inputs',async()=>{
  mock.module(new URL('../../scripts/s3b-cutover.mjs',import.meta.url).href,{namedExports:{readPrivateJson:name=>name==='config'?config:packet(fixtures())}});
  const {main}=await import('../../scripts/s3b-reconcile.mjs');assert.equal(poolAttempts,0);
  const output=[];const error=mock.method(console,'error',value=>output.push(value));
  try{assert.equal(await main(['--mode','execute','--config','config','--review','review','--confirm',confirmation]),1);assert.equal(poolAttempts,0);
    for(const value of ['private-sentinel',owner,id(1),'private task'])assert.equal(output.join('').includes(value),false);
  }finally{error.mock.restore();}
});
