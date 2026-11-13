import assert from 'node:assert/strict';
const copy = x => structuredClone(x);
// Independent in-memory state machine for SQL boundaries, NOT a PostgreSQL
// parser/isolation proof. Shared by real engine and artifact-route fixtures.
export class DailyFixture {
  constructor(db) { this.db = db; this.attempts = new Map(); this.tx = new WeakMap(); this.locks = new Map(); this.waiters = new Map(); this.timezone = 'UTC'; this.policyTimezone = 'UTC'; this.failAt = null; }
  now() { return this.db.clock ?? new Date(this.db.time); }
  begin(tx) { this.tx.set(tx, { attempts: new Map(), locks: new Set(), quota: false }); }
  unlock(tx) { const state = this.tx.get(tx); for (const id of state?.locks ?? []) { this.locks.delete(id); this.waiters.get(id)?.splice(0).forEach(done => done()); } }
  commit(tx) { for (const [id, row] of this.tx.get(tx)?.attempts ?? []) this.attempts.set(id, copy(row)); this.unlock(tx); }
  rollback(tx) { this.unlock(tx); }
  async lock(tx, id) { while (this.locks.has(id) && this.locks.get(id) !== tx) await new Promise(done => { const list = this.waiters.get(id) ?? []; list.push(done); this.waiters.set(id,list); }); this.locks.set(id,tx); this.tx.get(tx).locks.add(id); }
  all(tx) { return new Map([...this.attempts, ...(this.tx.get(tx)?.attempts ?? [])]); }
  async query(sql, args, tx) {
    if (!sql.startsWith('/* daily:')) return null;
    const result = rows => ({ rows: copy(rows), rowCount: rows.length });
    const name = sql.match(/^\/\* daily:([^ ]+) \*\//)[1], state = this.tx.get(tx);
    if (this.failAt === name) { this.failAt = null; throw new Error('private-fixture SQL error'); }
    if (['map','proposal-lock','artifact-lock'].includes(name)) {
      assert.equal(state.quota, false, 'Never wait for a publication lock after quota');
      if (name === 'map') {
        await this.db.lock(tx, args[0]);
        const row = typeof this.db.map === 'function' ? this.db.map(tx, args[0]) : this.db.map ?? this.db.maps?.get(args[0]);
        return result(row && row.id === args[0] ? [{ id: row.id, anon_id: row.anon_id }] : []);
      }
      return result([]);
    }
    if (name === 'global') { await this.lock(tx, 'global'); state.quota = true; return result([]); }
    if (name === 'actor') { assert.equal(this.locks.get('global'), tx); await this.lock(tx, args[0]); return result([]); }
    if (name === 'expired') return result([...this.attempts.values()].filter(a => a.state === 'reserved' && a.lease_expires_at <= this.now()).slice(0,50));
    if (name === 'bucket') { const day = new Date(this.now()); day.setUTCHours(0,0,0,0); return result([{ now: this.now(), day_start: day,
      day_end: new Date(+day+86400000), timezone: this.timezone, quota_timezone: this.policyTimezone, policy_version: 'daily-success-v1' }]); }
    assert.equal(this.locks.get('global'), tx, 'Mutating/counting accounting always holds global lock');
    if (name === 'counts') {
      const [start,end,actor] = args, attempts = [...this.all(tx).values()];
      const sameDay = a => +a.quota_day_start === +start && +a.quota_day_end === +end;
      const used = [...this.db.usage,...(tx.usage??[])].filter(u => u.attemptId ? sameDay(this.all(tx).get(u.attemptId))
        : +(u.createdAt??this.now())>=+start && +(u.createdAt??this.now())<+end).map(u=>u.actorId??u.owner??u.anonId);
      used.push(...attempts.filter(a=>a.state==='reserved'&&sameDay(a)).map(a=>a.actor_id));
      return result([{ global_used: used.length, actor_used: used.filter(a=>a===actor).length,
        global_attempts: attempts.filter(sameDay).length, actor_attempts: attempts.filter(a=>sameDay(a)&&a.actor_id===actor).length }]);
    }
    if (name === 'reserve') {
      if(this.all(tx).has(args[0])) return {rows:[],rowCount:0};
      const [id,actor_id,map_id,proposal_id,operation,policy_version,quota_day_start,quota_day_end,quota_timezone,admitted_at,lease_expires_at]=args;
      state.attempts.set(id,{id,actor_id,map_id,proposal_id,operation,policy_version,quota_day_start,quota_day_end,quota_timezone,admitted_at,lease_expires_at,state:'reserved'});
      this.db.onDailyReserve?.();
      return {rows:[],rowCount:1};
    }
    const attempt = this.all(tx).get(args[0]);
    if (name === 'attempt') return result(attempt?[attempt]:[]);
    if (name === 'succeed') {
      if(attempt.state!=='reserved'||attempt.lease_expires_at<=this.now()) return {rows:[],rowCount:0};
      state.attempts.set(attempt.id,{...attempt,state:'succeeded',map_id:args[1],finished_at:this.now()}); return {rows:[],rowCount:1};
    }
    if (name === 'usage') {
      this.db.checkpoint?.('usage'); this.db.fail?.('usage'); assert.equal(this.db.usage.some(u=>u.attemptId===args[2]),false);
      tx.usage.push({actorId:args[0],mapId:args[1],attemptId:args[2],createdAt:this.now()}); return {rows:[],rowCount:1};
    }
    if (name === 'proof') return result([{now:this.now(),used:this.db.usage.some(u=>u.attemptId===args[0]),
      artifact_saved:this.db.generations?.get(args[0])?.origin==='generated',
      proposal_state:this.db.proposal?.(tx,args[1])?.state??this.db.proposals?.get(args[1])?.state}]);
    if (name === 'expire-proposal') {
      const proposal=this.db.proposal(tx,args[0]); tx.proposals.set(args[0],{...copy(proposal),state:'failed',terminal_error:{code:'generation_timeout',details:{}}}); return {rows:[],rowCount:1};
    }
    if (name === 'fail') { state.attempts.set(attempt.id,{...attempt,state:'failed',finished_at:this.now()}); return {rows:[],rowCount:1}; }
    throw new Error('Unhandled synthetic accounting statement');
  }
}
