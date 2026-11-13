import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import test, { mock } from 'node:test';
import { DailyFixture } from '../fixtures/daily-admission.mjs';

process.env.COOKIE_SECRET = 's3a-isolated-test-secret';
process.env.FRONTEND_ORIGIN = 'https://frontend.mappr.test';
process.env.DATABASE_URL = 'mock-only-never-connect';
process.env.MAPPR_REVISION_WRITES_ENABLED = 'true';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.MAPPR_DAILY_ADMISSION_ENABLED;

const owner = randomUUID(), other = randomUUID(), mapA = randomUUID(), mapB = randomUUID();
const timestamp = new Date('2026-11-07T11:00:00Z');
const initial = {
  meta: { productName: 'Revision fixture', oneLineSummary: 'Mock only' },
  product: { summary: 'A revision test.', concepts: [] }, users: [], features: [], techStack: [],
  architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [],
};
const emptyPatch = { addNodes: [], removeNodeIds: [], updateNodes: [], addEdges: [], removeEdges: [] };
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// SQL boundary simulator with per-map locks and transaction-local staged writes.
// It never interprets a URL, imports a real pool, or executes PostgreSQL SQL.
class Database {
  constructor() {
    this.maps = new Map([mapA, mapB].map(id => [id, { id, anon_id: owner, data: copy(initial), current_revision: 1,
      input_description: 'Fixture description', created_at: timestamp, updated_at: timestamp }]));
    this.history = new Map([mapA, mapB].map(id => [id, [{ version: 1, data: copy(initial), patch: null, summary: 'Initial generation', created_at: timestamp }]]));
    this.usage = []; this.clients = new Set(); this.locks = new Map(); this.waiters = new Map();
    this.queries = []; this.commits = []; this.rollbacks = []; this.aiCalls = 0;
    this.failAt = null; this.schemaReady = true; this.pause = null; this.aiHook = null;
    this.clock = new Date(timestamp); this.daily = new DailyFixture(this);
  }
  async connect() {
    const tx = { open: false, maps: new Map(), history: [], usage: [], locks: new Set(), attemptedWrites: 0 };
    this.clients.add(tx);
    return { query: (sql, args) => this.query(sql, args, tx), release: () => this.clients.delete(tx) };
  }
  async lock(tx, id) {
    while (this.locks.has(id) && this.locks.get(id) !== tx) {
      await new Promise(resolve => { const waiting = this.waiters.get(id) ?? []; waiting.push(resolve); this.waiters.set(id, waiting); });
    }
    this.locks.set(id, tx); tx.locks.add(id);
    if (this.pause?.id === id) { this.pause.entered.resolve(); await this.pause.release.promise; }
  }
  unlock(tx) {
    for (const id of tx.locks) {
      this.locks.delete(id);
      const waiting = this.waiters.get(id) ?? []; this.waiters.delete(id); waiting.forEach(resolve => resolve());
    }
    tx.locks.clear();
  }
  fail(stage) {
    if (this.failAt === stage) { this.failAt = null; throw Object.assign(new Error('Synthetic SQL failure'), { code: 'XX000' }); }
  }
  rows(id, tx) {
    const row = tx?.maps.get(id) ?? this.maps.get(id);
    if (!row) return [];
    const versions = [...(this.history.get(id) ?? []), ...(tx?.history.filter(item => item.mapId === id).map(item => item.row) ?? [])];
    const ordered = [...versions].sort((a, b) => a.version - b.version);
    return [copy({ ...row, minimum_revision: ordered[0]?.version ?? null,
      maximum_revision: ordered.at(-1)?.version ?? null, snapshot_count: ordered.length,
      snapshot_matches: Boolean(ordered.length && isDeepStrictEqual(ordered.at(-1).data, row.data)) })];
  }
  async query(text, values = [], tx) {
    const sql = text.replace(/\s+/g, ' ').trim(); this.queries.push(sql);
    if (sql === 'BEGIN') { assert.ok(tx); tx.open = true; this.daily.begin(tx); return { rows: [] }; }
    if (sql.startsWith('SET ')) return { rows: [] };
    if (sql === 'ROLLBACK') {
      this.rollbacks.push({ attemptedWrites: tx.attemptedWrites }); tx.open = false; this.daily.rollback(tx); this.unlock(tx); return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.fail('commit');
      this.daily.commit(tx);
      for (const [id, row] of tx.maps) this.maps.set(id, copy(row));
      for (const { mapId, row } of tx.history) this.history.set(mapId, [...(this.history.get(mapId) ?? []), copy(row)]);
      this.usage.push(...copy(tx.usage)); this.commits.push({ maps: [...tx.maps.keys()], snapshots: tx.history.length, usage: tx.usage.length });
      tx.open = false; this.unlock(tx); return { rows: [] };
    }
    const daily = await this.daily.query(sql, values, tx); if (daily) return daily;
    if (sql === 'SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2') {
      return { rows: this.maps.get(values[0])?.anon_id === values[1] ? [{}] : [] };
    }
    if (!this.schemaReady && /current_revision/.test(sql)) throw Object.assign(new Error('Synthetic missing column'), { code: '42703' });
    if (sql.includes('FROM maps WHERE id = $1 FOR UPDATE')) {
      await this.lock(tx, values[0]);
      const row = this.maps.get(values[0]);
      return { rows: row ? [copy({ id: row.id, anon_id: row.anon_id, current_revision: row.current_revision,
        base_matches: isDeepStrictEqual(row.data, JSON.parse(values[1])) })] : [] };
    }
    if (sql.startsWith('SELECT m.id, m.anon_id')) return { rows: this.rows(values[0], tx) };
    if (sql.startsWith('SELECT version, summary, created_at FROM map_versions')) {
      return { rows: copy([...(this.history.get(values[0]) ?? [])].sort((a, b) => b.version - a.version)) };
    }
    if (sql.startsWith('SELECT version, data FROM map_versions')) {
      return { rows: copy((this.history.get(values[0]) ?? []).filter(row => [values[1], values[2]].includes(row.version))) };
    }
    if (sql.startsWith('INSERT INTO maps ')) {
      assert.ok(tx?.open); tx.attemptedWrites++; this.fail('map');
      const id = randomUUID(); const row = { id, anon_id: values[0], input_description: values[1], data: JSON.parse(values[2]), current_revision: 1, created_at: timestamp, updated_at: timestamp };
      tx.maps.set(id, row); return { rows: [copy(row)], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO map_versions ')) {
      assert.ok(tx?.open); tx.attemptedWrites++; this.fail('snapshot');
      const [id, version, data, patch, summary] = values;
      if ([...(this.history.get(id) ?? []), ...tx.history.filter(item => item.mapId === id).map(item => item.row)].some(row => row.version === version)) {
        throw Object.assign(new Error('Synthetic duplicate version'), { code: '23505' });
      }
      tx.history.push({ mapId: id, row: { version, data: JSON.parse(data), patch: patch === null ? null : JSON.parse(patch), summary, created_at: timestamp } });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE maps SET data = $1, current_revision = $2')) {
      assert.ok(tx?.open); tx.attemptedWrites++; this.fail('update');
      tx.maps.set(values[2], { ...copy(this.maps.get(values[2])), data: JSON.parse(values[0]), current_revision: values[1], updated_at: timestamp });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO generations ')) {
      assert.ok(tx?.open); tx.attemptedWrites++; this.fail('usage'); tx.usage.push({ anonId: values[0], mapId: values[1] }); return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL in isolated revision mock');
  }
}

let db = new Database();
mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real database initialization is forbidden'); } } } });
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: {
  pool: { query: (...args) => db.query(...args), connect: () => db.connect() },
} });
mock.module(new URL('../../src/services/rateLimit.ts', import.meta.url).href, { namedExports: { FREE_DAILY_LIMIT: 2, GLOBAL_DAILY_CEILING: 200, checkRateLimits: async () => ({ allowed: true }) } });
class AIGenerationError extends Error {}
mock.module(new URL('../../src/services/aiClient.ts', import.meta.url).href, { namedExports: {
  AIGenerationError,
  generateStructured: async config => {
    assert.equal(db.clients.size, 0, 'AI must not run while its database connection is held');
    assert.equal(db.locks.size, 0, 'AI must not run under a map lock');
    db.aiCalls++;
    if (db.aiHook) await db.aiHook();
    if (config.groqSchemaName === 'mappr_system') return copy(initial);
    assert.equal(config.groqSchemaName, 'architecture_iteration');
    const label = config.buildPrompt().includes('beta') ? 'beta' : 'alpha';
    return { summary: `Added ${label}.`, patch: { ...copy(emptyPatch), addNodes: [{ id: label, label, type: 'service', description: `${label} fixture` }] } };
  },
} });

const { createApp } = await import('../../src/app.ts');
const { readCanonicalBase, readRevisionedMap, commitArchitectureRevision } = await import('../../src/services/canonicalRevision.ts');
const { planRevisionBackfill } = await import('../../src/services/revisionState.ts');

test('S3A revision-aware routes and transactions with no real database', { timeout: 90000 }, async t => {
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const signed = actor => `mappr_anon=${actor}.${createHmac('sha256', process.env.COOKIE_SECRET).update(actor).digest('hex')}`;
  async function request(method, path, body, actor = owner) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { cookie: signed(actor),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) } }, res => {
        const parts = []; res.on('data', data => parts.push(data)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(parts).toString()) }));
      });
      req.setTimeout(10000, () => req.destroy(new Error('Local revision test timeout'))); req.on('error', reject); req.end(encoded);
    });
  }
  const iterate = (id = mapA, instruction = 'Add alpha.') => request('POST', `/maps/${id}/iterate`, { instruction });
  const resultFor = label => ({ newSystem: { ...copy(initial), architecture: { nodes: [{ id: label, label, type: 'service', description: label }], edges: [] } }, groundedPatch: copy(emptyPatch), summary: label });
  const assertClean = () => { assert.equal(db.clients.size, 0); assert.equal(db.locks.size, 0); };
  const quietErrors = async work => { const log = mock.method(console, 'error', () => {}); try { return await work(); } finally { log.mock.restore(); } };

  await t.test('generation commits current revision 1, exact full initial snapshot, and usage atomically', async () => {
    db = new Database();
    const response = await request('POST', '/generate', { description: 'A sufficiently long generation fixture description.' });
    assert.equal(response.status, 201); assert.equal(response.data.revision, 1);
    assert.deepEqual(Object.keys(response.data).sort(), ['id','createdAt','updatedAt','data','revision'].sort());
    const map = db.maps.get(response.data.id); const history = db.history.get(response.data.id);
    assert.equal(map.current_revision, 1); assert.deepEqual(history.map(row => row.version), [1]);
    assert.deepEqual(history[0].data, map.data); assert.deepEqual(map.data, response.data.data);
    assert.equal(history[0].patch, null); assert.equal(db.usage.length, 1);
    assert.equal(db.commits.length, 1); assert.deepEqual(db.commits[0], { maps: [map.id], snapshots: 1, usage: 1 });
    assert.equal(db.aiCalls, 1); assertClean();
  });

  for (const stage of ['map', 'snapshot', 'usage', 'commit']) {
    await t.test(`generation SQL failure at ${stage} leaves no map/snapshot/usage`, async () => {
      db = new Database(); db.failAt = stage;
      const response = await quietErrors(() => request('POST', '/generate', { description: 'A sufficiently long generation fixture description.' }));
      assert.equal(response.status, 500); assert.equal(db.maps.size, 2); assert.equal(db.history.size, 2);
      assert.equal(db.usage.length, 0); assert.equal(db.commits.length, 0); assert.equal(db.rollbacks.length, 1); assertClean();
    });
  }

  await t.test('iteration increments the same sequence and preserves legacy success fields', async () => {
    db = new Database();
    const response = await iterate(); assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.data).sort(), ['mapId','version','revision','summary','patch','data'].sort());
    assert.equal(response.data.version, 2); assert.equal(response.data.revision, 2);
    assert.equal(db.maps.get(mapA).current_revision, 2); assert.deepEqual(db.history.get(mapA).map(row => row.version), [1,2]);
    assert.deepEqual(db.history.get(mapA)[1].data, response.data.data); assert.equal(db.usage.length, 1); assertClean();
  });

  await t.test('two same-base requests yield one winner and a typed conflict with zero loser writes', async () => {
    db = new Database(); const entered = deferred();
    db.aiHook = async () => { if (db.aiCalls === 2) entered.resolve(); await entered.promise; };
    const responses = await Promise.all([iterate(mapA, 'Add alpha.'), iterate(mapA, 'Add beta.')]);
    const winner = responses.find(row => row.status === 201), loser = responses.find(row => row.status === 409);
    assert.ok(winner && loser); assert.equal(loser.data.error, 'revision_conflict');
    assert.deepEqual(loser.data.details, { expectedBaseRevision: 1, currentRevision: 2 });
    assert.equal(db.aiCalls, 2, 'No regeneration/rebase after conflict');
    assert.equal(db.commits.length, 1); assert.equal(db.rollbacks.length, 1); assert.equal(db.rollbacks[0].attemptedWrites, 0);
    assert.equal(db.usage.length, 1); assert.deepEqual(db.history.get(mapA).map(row => row.version), [1,2]);
    assert.deepEqual(db.maps.get(mapA).data, winner.data.data); assertClean();
  });

  for (const stage of ['snapshot', 'update', 'usage', 'commit']) {
    await t.test(`iteration SQL failure at ${stage} rolls back data/history/usage`, async () => {
      db = new Database(); db.failAt = stage;
      const response = await quietErrors(iterate); assert.equal(response.status, 500);
      assert.deepEqual(db.maps.get(mapA).data, initial); assert.equal(db.maps.get(mapA).current_revision, 1);
      assert.deepEqual(db.history.get(mapA).map(row => row.version), [1]);
      assert.equal(db.usage.length, 0); assert.equal(db.commits.length, 0); assert.equal(db.aiCalls, 1); assertClean();
    });
  }

  await t.test('different maps commit independently while one map lock is held', async () => {
    db = new Database();
    const baseA = await readCanonicalBase(mapA, owner), baseB = await readCanonicalBase(mapB, owner);
    const entered = deferred(), release = deferred(); db.pause = { id: mapA, entered, release };
    const pending = commitArchitectureRevision({ mapId: mapA, anonId: owner, base: baseA, result: resultFor('alpha') });
    await entered.promise;
    try {
      const independent = commitArchitectureRevision({ mapId: mapB, anonId: owner, base: baseB, result: resultFor('beta') });
      let timer;
      try { assert.equal(await Promise.race([independent, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent map was blocked')), 3000); })]), 2); }
      finally { clearTimeout(timer); }
      assert.equal(db.maps.get(mapA).current_revision, 1); assert.equal(db.maps.get(mapB).current_revision, 2);
    } finally { release.resolve(); await pending; }
    assert.equal(db.commits.length, 2); assert.equal(db.usage.length, 2); assertClean();
  });

  await t.test('owner is checked at admission and again after AI at locked commit', async () => {
    db = new Database();
    const denied = await request('POST', `/maps/${mapA}/iterate`, { instruction: 'Add alpha.' }, other);
    assert.equal(denied.status, 404); assert.equal(db.aiCalls, 0); assert.equal(db.clients.size, 0);
    db.aiHook = async () => { db.maps.get(mapA).anon_id = other; };
    const changed = await iterate(); assert.equal(changed.status, 404);
    assert.equal(db.usage.length, 0); assert.equal(db.history.get(mapA).length, 1); assert.equal(db.rollbacks[0].attemptedWrites, 0); assertClean();
  });

  await t.test('GET returns a coherent positive revision and historical numbering/diff stays compatible', async () => {
    db = new Database(); const old = await readRevisionedMap(mapA);
    const applied = await iterate(); assert.equal(applied.status, 201);
    assert.equal(old.current_revision, 1); assert.deepEqual(old.data, initial);
    const current = await request('GET', `/maps/${mapA}`);
    assert.equal(current.status, 200); assert.equal(current.data.revision, 2); assert.deepEqual(current.data.data, applied.data.data);
    assert.deepEqual(Object.keys(current.data).sort(), ['id','inputDescription','data','createdAt','updatedAt','revision'].sort());
    const history = await request('GET', `/maps/${mapA}/versions`);
    assert.deepEqual(history.data.map(row => row.version), [2,1]);
    assert.deepEqual(Object.keys(history.data[0]).sort(), ['version','summary','createdAt'].sort());
    const diff = await request('GET', `/maps/${mapA}/diff?from=1&to=2`);
    assert.equal(diff.status, 200); assert.equal(diff.data.diff.hasChanges, true);
    assert.equal(diff.data.diff.architecture.nodes.added[0].id, 'alpha'); assertClean();
  });

  await t.test('enabled rollout fails safely on absent column, unbackfilled data, gaps, and drift before AI', async () => {
    for (const fixture of ['absent-column','unbackfilled','gap','mismatch','invalid-system']) {
      db = new Database();
      if (fixture === 'absent-column') db.schemaReady = false;
      if (fixture === 'unbackfilled') db.maps.get(mapA).current_revision = null;
      if (fixture === 'gap') { db.maps.get(mapA).current_revision = 3; db.history.get(mapA).push({ version: 3, data: copy(initial) }); }
      if (fixture === 'mismatch') db.maps.get(mapA).data.product.summary = 'Unsnapshotted fixture change';
      if (fixture === 'invalid-system') db.maps.get(mapA).data = {};
      const read = await request('GET', `/maps/${mapA}`); assert.equal(read.status, 503); assert.equal(read.data.error, 'revision_not_ready');
      const mutation = await iterate(); assert.equal(mutation.status, 503); assert.equal(mutation.data.error, 'revision_not_ready');
      assert.equal(db.aiCalls, 0); assert.equal(db.usage.length, 0); assert.equal(db.commits.length, 0); assertClean();
    }
  });
});

test('S3A prepared migration is expansion-only and is never executed by this suite', () => {
  const sql = readFileSync(new URL('../../src/db/migrations/013_current_revision.sql', import.meta.url), 'utf8').replace(/--[^\r\n]*/g, '');
  assert.match(sql, /ALTER TABLE public\.maps ADD COLUMN current_revision integer;/);
  assert.doesNotMatch(sql, /\b(?:DEFAULT|NOT NULL|UPDATE|INSERT|DELETE|DROP|CREATE TABLE|CHECK)\b/i);
  assert.match(sql, /lock_timeout/); assert.match(sql, /statement_timeout/);
});

test('S4D real generation and Architecture POSTs share durable admission and preserve response/revision contracts',async t=>{
  process.env.MAPPR_DAILY_ADMISSION_ENABLED='true';t.after(()=>delete process.env.MAPPR_DAILY_ADMISSION_ENABLED);
  db=new Database();const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  const cookie=`mappr_anon=${owner}.${createHmac('sha256',process.env.COOKIE_SECRET).update(owner).digest('hex')}`;
  async function post(path,body){const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',
    headers:{Cookie:cookie,Origin:process.env.FRONTEND_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
  db.aiHook=async()=>assert.equal(db.daily.locks.size,0,'No quota lock during provider');
  const generated=await post('/generate',{description:'A sufficiently long daily allowance fixture.'});assert.equal(generated.status,201);assert.equal(generated.data.revision,1);
  const iterated=await post(`/maps/${mapA}/iterate`,{instruction:'Add alpha.'});assert.equal(iterated.status,201);assert.equal(iterated.data.revision,2);
  assert.deepEqual(Object.keys(iterated.data).sort(),['mapId','version','revision','summary','patch','data'].sort());
  const denied=await post('/generate',{description:'A sufficiently long third generation attempt.'});assert.equal(denied.status,429);
  assert.equal(denied.data.error,'daily_limit_exceeded');assert.equal(db.aiCalls,2);assert.equal(db.usage.length,2);
  assert.deepEqual([...db.daily.attempts.values()].map(a=>a.state),['succeeded','succeeded']);
  assert.equal(db.clients.size,0);assert.equal(db.daily.locks.size,0);assert.equal(db.locks.size,0);
});

test('S3A pure backfill planner covers reviewed initialization, restart, and quarantine without running backfill', async t => {
  const base = { anonId: owner, verifiedOwnerId: owner, data: copy(initial), currentRevision: null, snapshots: [] };
  const snapshot = { version: 1, data: copy(initial), matches_current: true };
  const cases = [
    ['unversioned', {}, { action: 'initialize', revision: 1 }],
    ['matching', { snapshots: [snapshot] }, { action: 'match', revision: 1 }],
    ['restart already ready', { currentRevision: 1, snapshots: [snapshot] }, { action: 'unchanged', revision: 1 }],
    ['mismatch', { snapshots: [{ ...snapshot, matches_current: false }] }, { action: 'quarantine', reason: 'snapshot_mismatch' }],
    ['gap', { snapshots: [snapshot, { ...snapshot, version: 3 }] }, { action: 'quarantine', reason: 'invalid_history' }],
    ['duplicate history', { snapshots: [snapshot, snapshot] }, { action: 'quarantine', reason: 'invalid_history' }],
    ['invalid map', { data: {} }, { action: 'quarantine', reason: 'invalid_system' }],
    ['invalid historical snapshot', { snapshots: [{ ...snapshot, data: {} }] }, { action: 'quarantine', reason: 'invalid_history' }],
    ['unknown owner', { verifiedOwnerId: undefined }, { action: 'quarantine', reason: 'unknown_owner' }],
    ['different owner', { verifiedOwnerId: other }, { action: 'quarantine', reason: 'unknown_owner' }],
    ['invalid owner', { anonId: 'not-a-uuid' }, { action: 'quarantine', reason: 'unknown_owner' }],
    ['counter without history', { currentRevision: 1 }, { action: 'quarantine', reason: 'invalid_current_revision' }],
    ['incorrect initialized counter', { currentRevision: 2, snapshots: [snapshot] }, { action: 'quarantine', reason: 'invalid_current_revision' }],
    ['JSONB key order proof', { snapshots: [{ ...snapshot, data: { ...copy(initial), meta: { oneLineSummary: 'Mock only', productName: 'Revision fixture' } } }] }, { action: 'match', revision: 1 }],
  ];
  for (const [name, overrides, expected] of cases) await t.test(name, () => {
    const fixture = copy({ ...base, ...overrides }), before = copy(fixture);
    assert.deepEqual(planRevisionBackfill(fixture), expected); assert.deepEqual(fixture, before);
  });
});
