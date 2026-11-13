import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DailyFixture } from '../fixtures/daily-admission.mjs';
process.env.DATABASE_URL = 'mock-only-never-connect';
process.env.FREE_DAILY_LIMIT = '2'; process.env.GLOBAL_DAILY_CEILING = '200';
process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real PostgreSQL forbidden'); } } } });
let db;
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: { pool: { connect: () => db.connect(), query: (...a)=>db.query(...a) } } });
const { DailyAdmission, DailyAdmissionError, recordSuccessfulGeneration, dailyAdmissionEnabled } = await import('../../src/services/dailyAdmission.ts');
const actor = randomUUID(), other = randomUUID(), mapId = randomUUID();
class Database {
  constructor() { this.clock=new Date('2026-11-11T12:00:00Z'); this.usage=[]; this.clients=new Set(); this.daily=new DailyFixture(this);
    this.map={id:mapId,anon_id:actor}; this.published=[]; this.mapLocks=new Map(); this.waiters=[]; this.failAt=null; this.uncertain=false; }
  async lock(tx,id) { while(this.mapLocks.has(id)&&this.mapLocks.get(id)!==tx) await new Promise(done=>this.waiters.push(done)); this.mapLocks.set(id,tx); tx.mapLocks.add(id); }
  release(tx) { for(const id of tx.mapLocks) this.mapLocks.delete(id); this.waiters.splice(0).forEach(done=>done()); }
  async connect() { const tx={usage:[],published:[],mapLocks:new Set()}; this.clients.add(tx); return {query:(s,a)=>this.query(s,a,tx),release:()=>this.clients.delete(tx)}; }
  checkpoint(stage) { if(this.failAt===stage){this.failAt=null; throw new Error('private-fixture SQL error');} }
  async query(sql,args=[],tx) {
    if(sql==='BEGIN'){this.daily.begin(tx); return {rows:[]};}
    if(sql.startsWith('SET '))return {rows:[]};
    if(sql==='ROLLBACK'){this.daily.rollback(tx);this.release(tx); return {rows:[]};}
    if(sql==='COMMIT'){this.checkpoint('commit');this.daily.commit(tx);this.usage.push(...structuredClone(tx.usage));this.published.push(...tx.published);this.release(tx);
      if(this.uncertain){this.uncertain=false;throw new Error('Lost fixture commit acknowledgement');} return {rows:[]};}
    const daily=await this.daily.query(sql,args,tx); if(daily)return daily;
    if(sql==='fixture:publication'){tx.published.push(args[0]);return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO generations ')){tx.usage.push({actorId:args[0],mapId:args[1],createdAt:this.clock});return {rows:[],rowCount:1};}
    throw new Error('Unexpected fixture query');
  }
}
function reset(){db=new Database();process.env.MAPPR_DAILY_ADMISSION_ENABLED='true';delete process.env.DAILY_AI_ATTEMPT_LIMIT;delete process.env.GLOBAL_DAILY_AI_ATTEMPT_LIMIT;return new DailyAdmission(db);}
async function transaction(work){const client=await db.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
async function publish(service,attempt){return transaction(async client=>{
  if(attempt.mapId)await client.query('/* daily:map */ SELECT id FROM maps WHERE id=$1 FOR UPDATE',[attempt.mapId]);
  await client.query('fixture:publication',[attempt.id]);await service.success(client,attempt,mapId);
});}
const denied=(work,code)=>assert.rejects(work,error=>error.code===code);
const clean=()=>{assert.equal(db.clients.size,0);assert.equal(db.daily.locks.size,0);assert.equal(db.mapLocks.size,0);};

test('daily admission races different operation types for the last actor unit without starting denied providers',async()=>{
  const service=reset();db.usage.push({actorId:actor,createdAt:db.clock});let providers=0;
  const results=await Promise.allSettled(['generate','iterate','readme','overview_preview'].map(async operation=>{
    const attempt=await service.reserve({actorId:actor,operation});providers++;return attempt;
  }));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(providers,1);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='daily_limit_exceeded'));
  const attempt=results.find(r=>r.status==='fulfilled').value;await publish(service,attempt);
  assert.equal(db.usage.length,2);assert.equal(db.daily.attempts.get(attempt.id).state,'succeeded');
  await denied(()=>service.reserve({actorId:actor,operation:'traceability'}),'daily_limit_exceeded');clean();
});

test('global last-unit race across actors and types serializes all shared budget users',async()=>{
  const service=reset();db.usage=Array.from({length:199},()=>({actorId:randomUUID(),createdAt:db.clock}));
  const results=await Promise.allSettled([service.reserve({actorId:actor,operation:'generate'}),service.reserve({actorId:other,operation:'api_contract'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'capacity_exceeded');
  clean();
});

test('settlement replaces one hold with one usage row, preserves history, and refuses duplicate publication',async()=>{
  const service=reset(),historical={actorId:actor,createdAt:new Date(db.clock),privateMetadata:'fixture'};db.usage.push(structuredClone(historical));
  const attempt=await service.reserve({actorId:actor,operation:'generate'});await publish(service,attempt);
  assert.deepEqual(db.usage[0],historical);assert.equal(db.published.length,1);assert.equal(db.usage.length,2);
  await denied(()=>publish(service,attempt),'attempt_in_progress');assert.equal(db.usage.length,2);assert.equal(db.published.length,1);
  await service.failure(attempt);assert.equal(db.daily.attempts.get(attempt.id).state,'succeeded');clean();
});

test('confirmed failure releases its hold but not its abuse-attempt count; failed requests cannot call providers indefinitely',async()=>{
  const service=reset();process.env.DAILY_AI_ATTEMPT_LIMIT='2';
  for(let i=0;i<2;i++){const attempt=await service.reserve({actorId:actor,operation:'iterate'});await service.failure(attempt);}
  await denied(()=>service.reserve({actorId:actor,operation:'readme'}),'attempt_limit_exceeded');assert.equal(db.usage.length,0);
  const otherAttempt=await service.reserve({actorId:other,operation:'generate'});await service.failure(otherAttempt);
  process.env.GLOBAL_DAILY_AI_ATTEMPT_LIMIT='3';await denied(()=>service.reserve({actorId:randomUUID(),operation:'generate'}),'attempt_limit_exceeded');clean();
});

test('usage/publication/commit rollback never leaves a successful unit and confirmed failure can settle afterward',async t=>{
  for(const stage of ['usage','commit'])await t.test(stage,async()=>{
    const service=reset(),attempt=await service.reserve({actorId:actor,mapId,operation:'iterate'});db.failAt=stage;
    await assert.rejects(()=>publish(service,attempt));assert.equal(db.usage.length,0);assert.equal(db.published.length,0);
    assert.equal(db.daily.attempts.get(attempt.id).state,'reserved');await service.failure(attempt);
    assert.equal(db.daily.attempts.get(attempt.id).state,'failed');clean();
  });
});

test('lost admission acknowledgement never starts a provider; expiry recovers the committed hold',async()=>{
  const service=reset();db.onDailyReserve=()=>{db.uncertain=true;};
  await denied(()=>service.reserve({actorId:actor,operation:'generate'}),'daily_admission_not_ready');
  assert.equal(db.daily.attempts.size,1);db.onDailyReserve=null;db.clock=new Date(+db.clock+181000);
  await service.recoverExpired();assert.equal([...db.daily.attempts.values()][0].state,'failed');assert.equal(db.usage.length,0);clean();
});

test('lost successful COMMIT is discovered as succeeded and is never released or blindly republished',async()=>{
  const service=reset(),attempt=await service.reserve({actorId:actor,operation:'generate'});db.uncertain=true;
  await assert.rejects(()=>publish(service,attempt));await service.failure(attempt);
  assert.equal(db.daily.attempts.get(attempt.id).state,'succeeded');assert.equal(db.usage.length,1);assert.equal(db.published.length,1);clean();
});

test('expired recovery and a late worker race safely; no late successful publication can commit',async()=>{
  const service=reset(),attempt=await service.reserve({actorId:actor,mapId,operation:'iterate'});db.clock=new Date(+db.clock+181000);
  const results=await Promise.allSettled([service.recoverExpired(),publish(service,attempt)]);
  assert.equal(results[1].status,'rejected');assert.equal(db.daily.attempts.get(attempt.id).state,'failed');
  assert.equal(db.usage.length,0);assert.equal(db.published.length,0);clean();
});

test('cross-midnight work belongs to its captured day; old usage is counted by creation day without rewriting it',async()=>{
  const service=reset();db.clock=new Date('2026-11-11T23:59:30Z');db.usage.push({actorId:actor,createdAt:new Date(db.clock)});
  const old=await service.reserve({actorId:actor,operation:'generate'});db.clock=new Date('2026-11-12T00:00:05Z');await publish(service,old);
  const a=await service.reserve({actorId:actor,operation:'iterate'}),b=await service.reserve({actorId:actor,operation:'readme'});
  await denied(()=>service.reserve({actorId:actor,operation:'generate'}),'daily_limit_exceeded');
  assert.equal(db.daily.attempts.get(old.id).quota_day_start.toISOString(),'2026-11-11T00:00:00.000Z');
  assert.equal(db.usage[1].createdAt.toISOString(),'2026-11-12T00:00:05.000Z');await service.failure(a);await service.failure(b);clean();
});

test('policy/session timezone mismatch and invalid attempt configuration fail closed before provider work',async()=>{
  const service=reset();db.daily.timezone='Different/Fixture';await denied(()=>service.reserve({actorId:actor,operation:'generate'}),'daily_admission_not_ready');
  db.daily.timezone='UTC';for(const value of ['0','NaN','Infinity','1.5']){process.env.DAILY_AI_ATTEMPT_LIMIT=value;
    await denied(()=>service.reserve({actorId:actor,operation:'generate'}),'daily_admission_not_ready');}
  assert.equal(db.daily.attempts.size,0);clean();
});

test('inconsistent committed usage beside a reserved attempt is not silently released',async()=>{
  const service=reset(),attempt=await service.reserve({actorId:actor,operation:'generate'});db.usage.push({actorId:actor,attemptId:attempt.id,createdAt:db.clock});
  await denied(()=>service.failure(attempt),'daily_admission_not_ready');assert.equal(db.daily.attempts.get(attempt.id).state,'reserved');clean();
});

test('pre-migration default-off mode preserves original accounting; missing tokens are rejected in enabled mode',async()=>{
  reset();delete process.env.MAPPR_DAILY_ADMISSION_ENABLED;assert.equal(dailyAdmissionEnabled(),false);
  assert.equal(await new DailyAdmission(db).reserve({actorId:actor,operation:'generate'}),undefined);
  await transaction(client=>recordSuccessfulGeneration(client,actor,mapId));assert.equal(db.usage.length,1);
  process.env.MAPPR_DAILY_ADMISSION_ENABLED='true';await denied(()=>transaction(client=>recordSuccessfulGeneration(client,actor,mapId)),'daily_admission_not_ready');clean();
});

test('prepared additive migration preserves legacy usage and binds durable attempts without payment schema',()=>{
  const sql=readFileSync(new URL('../../src/db/migrations/016_daily_generation_admission.sql',import.meta.url),'utf8').replace(/--[^\r\n]*/g,'');
  assert.match(sql,/CREATE TABLE public\.generation_attempts/);assert.match(sql,/FOREIGN KEY \(attempt_id,anon_id\)/);
  assert.match(sql,/UNIQUE \(attempt_id\)/);assert.match(sql,/ON DELETE SET NULL/);assert.match(sql,/current_setting\('TimeZone'\)/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.match(sql,/REVOKE ALL/);
  assert.match(sql,/ARRAY\['daily_admission_policy','generation_attempts'\]/);
  assert.match(sql,/ARRAY\['anon','authenticated'\]/);
  assert.match(sql,/REVOKE ALL ON TABLE public\.%I FROM %I/);
  assert.match(sql,/pg_catalog\.has_table_privilege/);
  assert.match(sql,/SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN/);
  assert.match(sql,/ERRCODE='42501'/);
  assert.doesNotMatch(sql,/CREATE POLICY|FORCE ROW LEVEL SECURITY|ALTER DEFAULT PRIVILEGES|GRANT\b/);
  assert.doesNotMatch(sql,/(?:^|;)\s*(?:UPDATE|DELETE|DROP|TRUNCATE)\b/im);
  assert.doesNotMatch(sql,/CREATE TABLE[^;]*(?:wallet|payment|subscription|checkout)/i);
});
