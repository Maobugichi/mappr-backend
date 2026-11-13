import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import test, { mock } from 'node:test';
import { DailyFixture } from '../fixtures/daily-admission.mjs';

// Worker-local configuration only. No dotenv, real pg/provider, deployed HTTP,
// operator config or private packet is imported by this suite.
process.env.DATABASE_URL = 'never-connect';
process.env.COOKIE_SECRET = 's4a-fixture-secret-not-for-deployment';
process.env.FRONTEND_ORIGIN = 'https://frontend.mappr.test';
process.env.NODE_ENV = 'test';
process.env.MAPPR_REVISION_WRITES_ENABLED = 'true';
delete process.env.MAPPR_CHANGES_ENABLED;
delete process.env.CHANGE_PROPOSAL_TTL_SECONDS;
delete process.env.MAPPR_DAILY_ADMISSION_ENABLED;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const actor = randomUUID(), stranger = randomUUID(), mapA = randomUUID(), mapB = randomUUID();
const initial = { meta: { productName: 'Fixture', oneLineSummary: 'Keep this tagline' },
  product: { summary: 'Original summary', concepts: ['retain'] }, users: [], features: [], techStack: [],
  architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [],
  extension: { nested: ['retain', null, 17] } };
const request = (revision = 1) => ({ instruction: 'Clarify the product summary.',
  context: { activeView: 'overview', selectedTarget: null }, expectedBaseRevision: revision });
const approval = (revision = 1) => ({ approved: true, expectedBaseRevision: revision });
const emptyPatch = { addNodes: [], removeNodeIds: [], updateNodes: [], addEdges: [], removeEdges: [] };
const edgeKey = edge => JSON.stringify([edge.from,edge.to,edge.label??null]);
function graphProjection(data, json) {
  const wanted=JSON.parse(json),old=data.architecture;
  data.architecture={...old,nodes:wanted.nodes.map(n=>({...old.nodes.find(p=>p.id===n.id),...n})),
    edges:wanted.edges.map(e=>copy(old.edges.find(p=>edgeKey(p)===edgeKey(e))??e))};
}
function stackProjection(data, json) {
  data.techStack = JSON.parse(json).map(entry => ({ ...data.techStack.find(old => old.category === entry.category), ...entry }));
}
const modelRelationKey = value => JSON.stringify([value.from, value.to, value.label ?? null]);
function modelProjection(data, json) {
  const wanted = JSON.parse(json), old = data.dataModel;
  data.dataModel = { ...old, entities: wanted.entities.map(value => {
    const original = old.entities.find(item => item.id === value.id);
    return { ...original, ...value, fields: value.fields.map(item => ({ ...original?.fields.find(field => field.name === item.name), ...item })) };
  }), relations: wanted.relations.map(value => {
    const original = old.relations.find(item => modelRelationKey(item) === modelRelationKey(value));
    return original ? { ...original, type: value.type } : value;
  }) };
}
let db;
const offlineAdmission = { assertConfigured() {}, async reserve() {}, async ready() {}, async failed() {} };
let providerHook;

// Per-map lock and transaction staging simulator. Statements read the latest
// committed state after waiting, matching the required READ COMMITTED boundary.
// It is not PostgreSQL and does not claim real DDL/row-lock integration coverage.
class Database {
  constructor() {
    this.clock = new Date('2026-11-10T12:00:00Z');
    this.maps = new Map([mapA, mapB].map(id => [id, { id, anon_id: actor, data: copy(initial), current_revision: 1,
      input_description: 'Keep original input', created_at: this.clock, updated_at: this.clock }]));
    this.history = [mapA, mapB].map(map_id => ({ map_id, version: 1, data: copy(initial), patch: null,
      summary: 'Original generation', created_at: this.clock, proposal_id: null }));
    this.proposals = new Map(); this.usage = []; this.artifacts = { readme: { keep: 'old prose' }, adrs: { keep: 'old ADR' } };
    this.clients = new Set(); this.locks = new Map(); this.waiters = new Map(); this.queries = [];
    this.modelCalls = 0; this.failAt = null; this.uncertainCommit = false; this.onWait = null; this.schemaReady = true;
    this.admissionEvents = []; this.admissionFail = null;
    this.tamperProjection = false;
    this.expireAtReady = false;
    this.daily = new DailyFixture(this);
  }
  async connect() {
    const tx = { maps: new Map(), proposals: new Map(), history: [], usage: [], admissionEvents: [], locks: new Set(), open: false };
    this.clients.add(tx);
    return { query: (sql, args) => this.query(sql, args, tx), release: () => this.clients.delete(tx) };
  }
  async lock(tx, id) {
    while (this.locks.has(id) && this.locks.get(id) !== tx) {
      if (this.onWait) this.onWait();
      await new Promise(resolve => { const list = this.waiters.get(id) ?? []; list.push(resolve); this.waiters.set(id, list); });
    }
    this.locks.set(id, tx); tx.locks.add(id);
  }
  unlock(tx) {
    for (const id of tx.locks) { this.locks.delete(id); const list = this.waiters.get(id) ?? []; this.waiters.delete(id); list.forEach(resolve => resolve()); }
    tx.locks.clear();
  }
  map(tx, id) { return tx?.maps.get(id) ?? this.maps.get(id); }
  proposal(tx, id) { return tx?.proposals.get(id) ?? this.proposals.get(id); }
  rowsFor(tx, id) {
    const row = this.map(tx, id); if (!row) return [];
    const history = [...this.history, ...(tx?.history ?? [])].filter(row => row.map_id === id).sort((a, b) => a.version - b.version);
    return [{ ...copy(row), minimum_revision: history[0]?.version ?? null, maximum_revision: history.at(-1)?.version ?? null,
      snapshot_count: history.length, snapshot_matches: isDeepStrictEqual(history.at(-1)?.data, row.data) }];
  }
  checkpoint(stage) { if (this.failAt === stage) { this.failAt = null; throw new Error('private-sentinel simulated SQL failure'); } }
  async query(text, args = [], tx) {
    const sql = text.replace(/\s+/g, ' ').trim(); this.queries.push(sql);
    const rows = list => ({ rows: copy(list), rowCount: list.length });
    if (sql === 'BEGIN') { assert.ok(tx); tx.open = true; this.daily.begin(tx); return rows([]); }
    if (sql.startsWith('SET LOCAL') || sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') { assert.ok(tx?.open); return rows([]); }
    if (sql === 'ROLLBACK') { tx.open = false; this.daily.rollback(tx); this.unlock(tx); return rows([]); }
    if (sql === 'COMMIT') {
      this.checkpoint('commit');
      this.daily.commit(tx);
      for (const [id, value] of tx.maps) this.maps.set(id, copy(value));
      for (const [id, value] of tx.proposals) this.proposals.set(id, copy(value));
      this.history.push(...copy(tx.history)); this.usage.push(...copy(tx.usage)); this.admissionEvents.push(...copy(tx.admissionEvents)); tx.open = false; this.unlock(tx);
      if (this.uncertainCommit) { this.uncertainCommit = false; throw new Error('private-sentinel lost commit acknowledgement'); }
      return rows([]);
    }
    const daily = await this.daily.query(sql, args, tx); if (daily) return daily;
    if (sql === 'SELECT 1') return rows([{}]);
    if (sql.startsWith('INSERT INTO public.maps (id,anon_id,input_description,data,current_revision)')) {
      this.checkpoint('local-fixture-map');
      if (this.map(tx, args[0])) return rows([]);
      tx.maps.set(args[0], { id: args[0], anon_id: args[1], input_description: args[2], data: JSON.parse(args[3]),
        current_revision: 1, created_at: this.clock, updated_at: this.clock }); return rows([{ id: args[0] }]);
    }
    if (sql.startsWith('INSERT INTO public.map_versions (map_id,version,data,patch,summary)')) {
      this.checkpoint('local-fixture-snapshot');
      tx.history.push({ map_id: args[0], version: 1, data: copy(this.map(tx, args[0]).data), patch: null, summary: 'Synthetic local browser fixture (no AI)', created_at: this.clock });
      return { rows: [], rowCount: 1 };
    }
    if (sql === 'SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2') return rows(this.maps.get(args[0])?.anon_id === args[1] ? [{}] : []);
    if (sql.startsWith('/* changes:lock-map */')) {
      await this.lock(tx, args[0]); const row = this.map(tx, args[0]);
      return rows(row ? [{ id: row.id, anon_id: row.anon_id, canonical_text: JSON.stringify(row.data) }] : []);
    }
    if (sql.startsWith('SELECT m.id, m.anon_id')) {
      if (!this.schemaReady) throw Object.assign(new Error('Private missing column'), { code: '42703' });
      return rows(this.rowsFor(tx, args[0]));
    }
    if (sql.startsWith('/* changes:clock */')) return rows([{ now: this.clock }]);
    if (sql.startsWith('/* changes:key */')) {
      assert.ok(tx.locks.has(args[1]), 'Always lock map before proposals');
      const values = new Map([...this.proposals, ...tx.proposals]);
      return rows([...values.values()].filter(p => p.actor_id === args[0] && p.map_id === args[1] && p.preview_key === args[2]));
    }
    if (sql.startsWith('/* changes:proposal */')) {
      assert.ok(tx.locks.has(args[1]), 'Always lock map before proposal');
      const p = this.proposal(tx, args[0]); return rows(p && p.map_id === args[1] && p.actor_id === args[2] ? [p] : []);
    }
    if (sql.startsWith('/* changes:reserve */')) {
      this.checkpoint('reserve'); const [id, map_id, actor_id, preview_key, request_digest, request_payload, base_revision,
        base_fingerprint, admitted_at, lease_expires_at, validation_policy, generator_id] = args;
      assert.equal([...this.proposals.values()].some(p => p.actor_id === actor_id && p.map_id === map_id && p.preview_key === preview_key), false);
      tx.proposals.set(id, { id, map_id, actor_id, preview_key, request_digest, request_payload: JSON.parse(request_payload),
        base_revision, base_fingerprint, admitted_at, lease_expires_at, validation_policy: JSON.parse(validation_policy), generator_id,
        state: 'generating', preview_response: null, candidate_fingerprint: null, terminal_error: null, expires_at: null, apply_receipt: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* changes:project */')) {
      const candidate = copy(this.map(tx, args[0]).data);
      if(sql.includes("'{architecture}'"))graphProjection(candidate,args[1]);
      else if(sql.includes("'{techStack}'"))stackProjection(candidate,args[1]);
      else if(sql.includes("'{dataModel}'"))modelProjection(candidate,args[1]);else candidate.product.summary = args[1];
      if (this.tamperProjection) candidate.meta.oneLineSummary = 'Tampered';
      return rows([{ candidate, candidate_text: JSON.stringify(candidate) }]);
    }
    if (sql.startsWith('/* changes:artifacts */')) return rows(['api_contract','critique','requirements','traceability',
      'relational_schema','document_schema','readme','adrs','env_vars','deployment'].map(kind => ({ kind, present: Boolean(this.artifacts[kind]) })));
    if (sql.startsWith('/* artifacts:inputs:')) {
      const data = args[1] ? JSON.parse(args[1]) : this.map(tx, args[0]).data;
      return rows([{ input_text: JSON.stringify(data) }]);
    }
    if (sql.startsWith('/* artifacts:rows:')) {
      const kind = args[1];
      return rows(this.artifacts[kind] ? [{ record: { id: 'fixture-' + kind, map_id: args[0] }, payload_text: '{}', provenance: null, generation_id: null }] : []);
    }
    if (sql.startsWith('/* changes:ready */')) {
      this.checkpoint('ready'); const p = this.proposal(tx, args[0]); assert.equal(p.state, 'generating');
      assert.match(sql, /lease_expires_at>clock_timestamp\(\)/);
      if (this.expireAtReady) this.clock = new Date(p.admitted_at.getTime() + 181000);
      if (this.clock >= p.lease_expires_at || this.clock.getTime() >= p.admitted_at.getTime() + 120000) return { rows: [], rowCount: 0 };
      tx.proposals.set(p.id, { ...copy(p), state: 'ready', ready_at: args[1], expires_at: args[2],
        candidate_fingerprint: args[3], preview_response: JSON.parse(args[4]) }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* changes:fail */')) {
      const p = this.proposal(tx, args[0]); assert.equal(p.state, 'generating');
      tx.proposals.set(p.id, { ...copy(p), state: args[1], terminal_error: JSON.parse(args[2]) }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* changes:expire */')) {
      const p = this.proposal(tx, args[0]); tx.proposals.set(p.id, { ...copy(p), state: 'expired' }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* changes:conflict */')) {
      const p = this.proposal(tx, args[0]); tx.proposals.set(p.id, { ...copy(p), state: 'conflicted', terminal_error: JSON.parse(args[1]) });
      return { rows: [], rowCount: 1 };
    }
    if(sql.startsWith('/* changes:reject */')){
      this.checkpoint('reject');const p=this.proposal(tx,args[0]);assert.equal(p.state,'ready');
      tx.proposals.set(p.id,{...copy(p),state:'failed',terminal_error:JSON.parse(args[1])});return {rows:[],rowCount:1};
    }
    if (sql.startsWith('/* changes:update-map */')) {
      this.checkpoint('update-map'); const row = copy(this.map(tx, args[0]));
      if(sql.includes("'{architecture}'"))graphProjection(row.data,args[1]);
      else if(sql.includes("'{techStack}'"))stackProjection(row.data,args[1]);
      else if(sql.includes("'{dataModel}'"))modelProjection(row.data,args[1]);else row.data.product.summary = args[1];
      row.current_revision = args[2]; row.updated_at = this.clock; tx.maps.set(row.id, row);
      return rows([{ data: row.data, canonical_text: JSON.stringify(row.data), updated_at: row.updated_at }]);
    }
    if (sql.startsWith('/* changes:snapshot */')) {
      this.checkpoint('snapshot'); assert.equal(this.history.some(row => row.proposal_id === args[3]), false);
      tx.history.push({ map_id: args[0], version: args[1], data: copy(this.map(tx, args[0]).data), patch: null,
        summary: args[2], proposal_id: args[3], change_metadata: JSON.parse(args[4]), created_at: this.clock }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* changes:applied */')) {
      this.checkpoint('applied'); const p = this.proposal(tx, args[0]); assert.equal(p.state, 'ready');
      tx.proposals.set(p.id, { ...copy(p), state: 'applied', applied_revision: args[1], applied_at: args[2],
        apply_receipt: JSON.parse(args[3]) }); return { rows: [], rowCount: 1 };
    }
    // Actual existing S3 commit helper participates in the same lock simulator.
    if (sql.includes('FROM maps WHERE id = $1 FOR UPDATE')) {
      await this.lock(tx, args[0]); const row = this.map(tx, args[0]);
      return rows(row ? [{ id: row.id, anon_id: row.anon_id, current_revision: row.current_revision,
        base_matches: isDeepStrictEqual(row.data, JSON.parse(args[1])) }] : []);
    }
    if (sql.startsWith('INSERT INTO map_versions ')) {
      tx.history.push({ map_id: args[0], version: args[1], data: JSON.parse(args[2]), patch: args[3] === null ? null : JSON.parse(args[3]),
        summary: args[4], created_at: this.clock, proposal_id: null }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE maps SET data = $1, current_revision = $2')) {
      const row = copy(this.map(tx, args[2])); row.data = JSON.parse(args[0]); row.current_revision = args[1];
      tx.maps.set(row.id, row); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO generations ')) { tx.usage.push({ actorId: args[0], mapId: args[1] }); return { rows: [], rowCount: 1 }; }
    if (sql === '/* fixture:admission */') {
      const [stage, proposalId, reason] = args;
      if (this.admissionFail === stage) { this.admissionFail = null; throw new Error('private-sentinel admission SQL failure'); }
      assert.ok(this.proposal(tx, proposalId), 'Reservation is atomic with a durable proposal');
      tx.admissionEvents.push({ stage, proposalId, reason }); return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL in isolated S4A mock');
  }
}
db = new Database();
mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real database construction forbidden'); } } } });
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: {
  pool: { query: (...args) => db.query(...args), connect: () => db.connect() },
} });
mock.module(new URL('../../src/services/aiClient.ts', import.meta.url).href, { namedExports: {
  AIGenerationError: class extends Error {}, generateStructured: async config => {
    if (!providerHook) throw new Error('Real AI forbidden'); return providerHook(config);
  },
} });
mock.module(new URL('../../src/services/rateLimit.ts', import.meta.url).href, { namedExports: { FREE_DAILY_LIMIT: 2, GLOBAL_DAILY_CEILING: 200,
  checkRateLimits: async () => { throw new Error('No S4A billing policy may be invented'); },
} });
const { ChangeEngine } = await import('../../src/services/changes/engine.ts');
const { overviewCandidate, buildOverviewPrompt } = await import('../../src/services/changes/overview.ts');
const { assertChangesAvailable, proposalTtlSeconds } = await import('../../src/services/changes/availability.ts');
const { commitArchitectureRevision, readCanonicalBase, RevisionConflictError } = await import('../../src/services/canonicalRevision.ts');
const { createChangesRouter } = await import('../../src/routes/changes.ts');
const { createApp } = await import('../../src/app.ts');
const { generateOverviewSummary, createOverviewProvider } = await import('../../src/services/changes/provider.ts');
const { createPreviewAdmission } = await import('../../src/services/changes/admission.ts');
const { DailyAdmission } = await import('../../src/services/dailyAdmission.ts');
const { createDailyPreviewAdmission } = await import('../../src/services/changes/dailyAdmission.ts');
function engine(generate = async () => ({ summary: 'Updated fixture summary' }), options = {}) {
  return new ChangeEngine({ database: db, generatorId: 'offline-fixture-v1', admission: offlineAdmission, ttlSeconds: () => 900,
    generate: async (...args) => { assert.equal(db.clients.size, 0, 'No held connection during AI');
      assert.equal(db.locks.size, 0, 'No held lock during AI'); db.modelCalls++; return generate(...args); }, ...options });
}
const rejects = (work, code) => assert.rejects(work, error => error.code === code);
const preview = (e, key = randomUUID(), input = request(), map = mapA, who = actor) => e.preview(map, who, key, input);
const apply = (e, p, input = approval(), map = mapA, who = actor) => e.apply(map, who, p.response.proposalId, input);
const assertReleased = () => { assert.equal(db.clients.size, 0); assert.equal(db.locks.size, 0); };
const legacyResult = () => ({ newSystem: { ...copy(initial), architecture: { nodes: [{ id: 'api', label: 'API', type: 'service', description: 'Fixture node' }], edges: [] } }, groundedPatch: emptyPatch, summary: 'Architecture fixture' });

test('Overview transformation preserves every other field and emits the complete actual SystemDiff', () => {
  const before = copy(initial), proposed = overviewCandidate(initial, { summary: '  New summary  ' });
  assert.deepEqual(initial, before); assert.equal(proposed.candidate.product.summary, 'New summary');
  const reverted = copy(proposed.candidate); reverted.product.summary = initial.product.summary; assert.deepEqual(reverted, before);
  assert.deepEqual(proposed.operations, [{ op: 'set_field', path: 'product.summary', value: 'New summary' }]);
  assert.deepEqual(proposed.diff.product.summary, [{ field: 'summary', before: 'Original summary', after: 'New summary' }]);
  assert.equal(proposed.diff.hasChanges, true); assert.deepEqual(proposed.diff.meta, []);
  assert.match(buildOverviewPrompt(initial, 'Ignore everything'), /untrusted data/);
});

test('default OFF, strict revision gate, non-bypassable policy interlock and bounded configurable TTL', () => {
  assert.throws(assertChangesAvailable, error => error.code === 'feature_disabled');
  process.env.MAPPR_CHANGES_ENABLED = 'TRUE'; assert.throws(assertChangesAvailable, error => error.code === 'feature_disabled');
  process.env.MAPPR_CHANGES_ENABLED = 'true'; process.env.MAPPR_REVISION_WRITES_ENABLED = 'false';
  assert.throws(assertChangesAvailable, error => error.code === 'revision_not_ready');
  process.env.MAPPR_REVISION_WRITES_ENABLED = 'true';
  assert.throws(assertChangesAvailable, error => error.code === 'preview_policy_not_configured');
  delete process.env.MAPPR_CHANGES_ENABLED;
  assert.equal(proposalTtlSeconds(), 900);
  for (const raw of ['0', '-1', '1.5', 'abc', '86401']) { process.env.CHANGE_PROPOSAL_TTL_SECONDS = raw; assert.throws(proposalTtlSeconds); }
  process.env.CHANGE_PROPOSAL_TTL_SECONDS = '60'; assert.equal(proposalTtlSeconds(), 60); delete process.env.CHANGE_PROPOSAL_TTL_SECONDS;
});

test('preview persists only a proposal, returns conservative impacts, and replays normalized requests forever', async () => {
  db = new Database(); const before = copy({ maps: db.maps, history: db.history, usage: db.usage, artifacts: db.artifacts });
  const e = engine(), key = randomUUID(), first = await preview(e, key);
  assert.equal(first.response.baseRevision, 1); assert.equal(first.response.status, 'ready'); assert.equal(db.proposals.size, 1);
  assert.equal(first.response.expiresAt, '2026-11-10T12:15:00.000Z');
  assert.equal(first.response.artifactImpacts.find(a => a.artifactType === 'readme').action, 'invalidate');
  assert.equal(first.response.artifactImpacts.find(a => a.artifactType === 'api_contract').action, 'none');
  const again = await preview(e, key, { ...request(), instruction: '  Clarify the product summary.  ' });
  assert.deepEqual(again.response, first.response); assert.equal(again.replayed, true); assert.equal(db.modelCalls, 1);
  db.clock = new Date('2026-11-11T12:00:00Z'); const expiredReplay = await preview(e, key);
  assert.deepEqual(expiredReplay.response, first.response); assert.equal(db.modelCalls, 1);
  assert.deepEqual({ maps: db.maps, history: db.history, usage: db.usage, artifacts: db.artifacts }, before); assertReleased();
});

test('invalid input/context, stale intent, owner denial and not-ready history never admit generation', async t => {
  for (const [name, edit, code] of [
    ['blank', r => r.instruction = ' ', 'invalid_request'], ['oversized', r => r.instruction = 'x'.repeat(2001), 'invalid_request'],
    ['extra field', r => r.data = initial, 'invalid_request'], ['bad revision', r => r.expectedBaseRevision = 0, 'invalid_request'],
    ['view', r => r.context.activeView = 'tech_stack', 'unsupported_scope'],
    ['target', r => r.context.selectedTarget = { kind: 'feature', id: 'selected' }, 'unsupported_scope'],
    ['context field', r => r.context.unsafe = true, 'invalid_request'], ['stale', r => r.expectedBaseRevision = 2, 'revision_conflict'],
  ]) await t.test(name, async () => { db = new Database(); const input = request(); edit(input);
    await rejects(() => preview(engine(), randomUUID(), input), code); assert.equal(db.proposals.size, 0); assert.equal(db.modelCalls, 0); assertReleased(); });
  for (const variant of ['owner', 'history gap', 'snapshot mismatch', 'missing column']) await t.test(variant, async () => {
    db = new Database(); if (variant === 'owner') db.maps.get(mapA).anon_id = stranger;
    if (variant === 'history gap') db.history[0].version = 3;
    if (variant === 'snapshot mismatch') db.maps.get(mapA).data.product.summary = 'Unsnapshotted';
    if (variant === 'missing column') db.schemaReady = false;
    await rejects(() => preview(engine()), variant === 'owner' ? 'not_found' : 'revision_not_ready'); assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0); assertReleased();
  });
});

test('schema-invalid, out-of-scope, no-op and failed model results become saved terminal failures', async t => {
  for (const [name, output, code] of [['blank', { summary: ' ' }, 'change_not_valid'], ['nonstring', { summary: 4 }, 'change_not_valid'],
    ['extra operation', { summary: 'New', operations: [] }, 'change_not_valid'], ['replacement', initial, 'change_not_valid'],
    ['too long', { summary: 'a'.repeat(4001) }, 'change_not_valid'], ['no-op', { summary: initial.product.summary }, 'no_changes'],
    ['provider', null, 'change_generation_failed']]) await t.test(name, async () => {
    db = new Database(); const e = engine(async () => { if (!output) throw new Error('private-sentinel provider prompt'); return output; }), key = randomUUID();
    await rejects(() => preview(e, key), code); await rejects(() => preview(e, key), code);
    assert.equal(db.modelCalls, 1); assert.equal([...db.proposals.values()][0].state, 'failed');
    assert.equal(db.history.length, 2); assert.deepEqual(db.maps.get(mapA).data, initial); assert.equal(db.usage.length, 0); assertReleased();
  });
});

test('same key collision and concurrent preview requests never duplicate generation', async () => {
  db = new Database(); const entered = deferred(), release = deferred(), e = engine(async () => { entered.resolve(); await release.promise; return { summary: 'One preview' }; });
  const key = randomUUID(), pending = preview(e, key); await entered.promise;
  await rejects(() => preview(e, key), 'preview_in_progress');
  await rejects(() => preview(e, key, { ...request(), instruction: 'Different instruction' }), 'idempotency_key_reused');
  release.resolve(); const result = await pending; assert.equal(db.modelCalls, 1); assert.equal((await preview(e, key)).response.proposalId, result.response.proposalId); assertReleased();
});

test('stale base during AI conflicts against the real legacy S3 commit helper', async () => {
  db = new Database(); const entered = deferred(), release = deferred(); const e = engine(async () => { entered.resolve(); await release.promise; return { summary: 'Late summary' }; });
  const key = randomUUID(), pending = preview(e, key); await entered.promise;
  const base = await readCanonicalBase(mapA, actor); await commitArchitectureRevision({ mapId: mapA, anonId: actor, base, result: legacyResult() });
  release.resolve(); await rejects(() => pending, 'revision_conflict'); await rejects(() => preview(e, key), 'revision_conflict');
  assert.equal([...db.proposals.values()][0].state, 'conflicted'); assert.equal(db.maps.get(mapA).current_revision, 2);
  assert.equal(db.maps.get(mapA).data.product.summary, initial.product.summary); assert.equal(db.usage.length, 1); assertReleased();
});

test('different preview keys can generate concurrently without retaining database leases', async () => {
  db = new Database(); const both = deferred(), release = deferred(); let calls = 0;
  const e = new ChangeEngine({ database: db, generatorId: 'offline-concurrent-fixture', admission: offlineAdmission, generate: async () => {
    const number = ++calls; if (calls === 2) both.resolve(); await release.promise; return { summary: 'Concurrent summary ' + number };
  } });
  const a = preview(e), b = preview(e); await both.promise; assertReleased(); release.resolve();
  const results = await Promise.all([a, b]); assert.equal(calls, 2); assert.equal(db.proposals.size, 2);
  assert.notEqual(results[0].response.proposalId, results[1].response.proposalId); assert.equal(db.history.length, 2);
  assert.equal(db.maps.get(mapA).current_revision, 1); assertReleased();
});

test('lease expiry at the guarded ready UPDATE prevents publication after earlier checks passed', async () => {
  db = new Database(); db.expireAtReady = true; const e = engine(), key = randomUUID();
  await rejects(() => preview(e, key), 'generation_timeout'); await rejects(() => preview(e, key), 'generation_timeout');
  assert.equal([...db.proposals.values()][0].state, 'failed'); assert.equal([...db.proposals.values()][0].preview_response, null);
  assert.equal(db.modelCalls, 1); assert.equal(db.history.length, 2); assertReleased();
});

test('expired processing leases and deadlines never restart generation or publish a late worker', async () => {
  db = new Database(); const entered = deferred(), release = deferred(); const e = engine(async () => { entered.resolve(); await release.promise; return { summary: 'Late result' }; });
  const key = randomUUID(), pending = preview(e, key); await entered.promise;
  const pendingFailure = rejects(() => pending, 'generation_timeout');
  db.clock = new Date(db.clock.getTime() + 181000); await rejects(() => preview(e, key), 'generation_timeout');
  release.resolve(); await pendingFailure; assert.equal(db.modelCalls, 1); assert.equal([...db.proposals.values()][0].state, 'failed'); assertReleased();
  db = new Database(); const late = deferred(); const timed = engine(() => late.promise, { generationTimeoutMs: 5 });
  await rejects(() => preview(timed), 'generation_timeout'); late.resolve({ summary: 'Too late' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(db.proposals.size, 1); assert.equal([...db.proposals.values()][0].state, 'failed'); assert.equal(db.history.length, 2); assertReleased();
});

test('owner change during generation and forged server projection cannot publish actionable proposals', async () => {
  db = new Database(); const e = engine(async base => { base.meta.oneLineSummary = 'Mutated generator input'; db.maps.get(mapA).anon_id = stranger; return { summary: 'Unapproved' }; });
  await rejects(() => preview(e), 'not_found'); assert.equal(db.maps.get(mapA).data.meta.oneLineSummary, initial.meta.oneLineSummary);
  assert.equal([...db.proposals.values()][0].state, 'generating'); assertReleased();
  db = new Database(); db.tamperProjection = true; await rejects(() => preview(engine()), 'change_not_valid');
  assert.equal([...db.proposals.values()][0].state, 'failed'); assert.deepEqual(db.maps.get(mapA).data, initial); assertReleased();
});

test('explicit approval, proposal/map/actor binding, policy, hash and diff are validated before canonical writes', async t => {
  for (const [name, code] of [['false approval','invalid_request'], ['missing approval','invalid_request'], ['replacement','invalid_request'],
    ['wrong base','proposal_mismatch'], ['wrong map','not_found'], ['other actor','not_found'], ['new owner','not_found'],
    ['policy','proposal_obsolete'], ['hash','proposal_obsolete'], ['diff','proposal_obsolete'], ['operation','proposal_obsolete'], ['not ready','proposal_not_ready']]) {
    await t.test(name, async () => {
      db = new Database(); const e = engine(), p = await preview(e), proposal = db.proposals.get(p.response.proposalId);
      let body = approval(), map = mapA, who = actor;
      if (name === 'false approval') body.approved = false;
      if (name === 'missing approval') delete body.approved;
      if (name === 'replacement') body.data = initial;
      if (name === 'wrong base') body.expectedBaseRevision = 2;
      if (name === 'wrong map') map = mapB;
      if (name === 'other actor') who = stranger;
      if (name === 'new owner') { who = stranger; db.maps.get(mapA).anon_id = stranger; }
      if (name === 'policy') proposal.validation_policy.contract = 99;
      if (name === 'hash') proposal.candidate_fingerprint = 'a'.repeat(64);
      if (name === 'diff') proposal.preview_response.diff.meta.push({ field: 'productName', before: 'x', after: 'y' });
      if (name === 'operation') proposal.preview_response.operations[0].path = 'meta.oneLineSummary';
      if (name === 'not ready') { proposal.state = 'generating'; proposal.preview_response = null; }
      await rejects(() => apply(e, p, body, map, who), code); assert.equal(db.maps.get(mapA).current_revision, 1);
      assert.equal(db.history.length, 2); assert.equal(db.modelCalls, 1); assert.equal(db.usage.length, 0); assertReleased();
    });
  }
});

test('expiry is decided after waiting for the map lock; preview is retained without renewal', async () => {
  db = new Database(); const e = engine(), key = randomUUID(), p = await preview(e, key);
  const holding = await db.connect(); await holding.query('BEGIN'); await holding.query('/* changes:lock-map */', [mapA]);
  const waiting = deferred(); db.onWait = waiting.resolve;
  const pending = apply(e, p); await waiting.promise; db.clock = new Date(p.response.expiresAt);
  await holding.query('COMMIT'); holding.release(); await rejects(() => pending, 'proposal_expired');
  await rejects(() => apply(e, p), 'proposal_expired'); const replay = await preview(e, key);
  assert.deepEqual(replay.response, p.response); assert.equal(db.modelCalls, 1); assert.equal(db.maps.get(mapA).current_revision, 1);
  assert.equal(db.proposals.get(p.response.proposalId).state, 'expired'); assertReleased();
});

test('apply commits one revision/snapshot/receipt, preserves all other canonical fields, metadata and artifacts', async () => {
  db = new Database(); const before = copy({ map: db.maps.get(mapA), history: db.history, other: db.maps.get(mapB), artifacts: db.artifacts });
  const e = engine(), p = await preview(e), applied = await apply(e, p);
  assert.equal(applied.response.revision, 2); assert.equal(applied.response.version, 2); assert.equal(applied.response.previousRevision, 1);
  assert.deepEqual(applied.response.diff, p.response.diff); assert.equal(db.history.length, 3); assert.equal(db.usage.length, 0);
  assert.deepEqual(db.history.slice(0, 2), before.history); assert.deepEqual(db.history[2].data, db.maps.get(mapA).data);
  assert.equal(db.history[2].proposal_id, p.response.proposalId); assert.equal(db.history[2].patch, null);
  const restored = copy(applied.response.data); restored.product.summary = initial.product.summary; assert.deepEqual(restored, initial);
  assert.equal(db.maps.get(mapA).anon_id, before.map.anon_id); assert.equal(db.maps.get(mapA).input_description, before.map.input_description);
  assert.deepEqual(db.maps.get(mapA).created_at, before.map.created_at); assert.deepEqual(db.maps.get(mapB), before.other);
  assert.deepEqual(db.artifacts, before.artifacts); assert.equal(applied.response.artifactFreshness.readme.status, 'stale');
  assert.equal(applied.response.artifactFreshness.readme.sourceRevision, null); assert.equal(applied.response.artifactFreshness.api_contract.status, 'missing');
  assert.ok(db.queries.some(sql => sql.includes("jsonb_set(data,'{product,summary}'")));
  assert.ok(db.queries.some(sql => sql.includes('SELECT id,$2,data,NULL,$3,$4,$5 FROM public.maps'))); assertReleased();
});

test('same proposal concurrent applies commit once; later replay remains the original receipt after expiry/new revisions', async () => {
  db = new Database(); const e = engine(), p = await preview(e);
  const results = await Promise.all([apply(e, p), apply(e, p)]);
  assert.deepEqual(results[0].response, results[1].response); assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(db.history.length, 3); assert.equal(db.modelCalls, 1);
  db.clock = new Date('2026-11-11T12:00:00Z');
  const base = await readCanonicalBase(mapA, actor); const result = legacyResult(); result.newSystem = copy(db.maps.get(mapA).data);
  result.newSystem.architecture.nodes = legacyResult().newSystem.architecture.nodes;
  await commitArchitectureRevision({ mapId: mapA, anonId: actor, base, result });
  const replay = await apply(e, p); assert.deepEqual(replay.response, results[0].response); assert.equal(replay.response.revision, 2);
  assert.equal(db.maps.get(mapA).current_revision, 3); await rejects(() => apply(e, p, approval(3)), 'proposal_mismatch'); assertReleased();
});

test('competing same-base proposals and legacy iteration share one winner with no silent rebase', async () => {
  db = new Database(); let n = 0; const e = engine(async () => ({ summary: 'Candidate ' + ++n }));
  const a = await preview(e), b = await preview(e);
  const results = await Promise.allSettled([apply(e, a), apply(e, b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'revision_conflict'); assert.equal(db.history.length, 3); assert.equal(db.usage.length, 0); assertReleased();
  db = new Database(); const e2 = engine(), p = await preview(e2), base = await readCanonicalBase(mapA, actor);
  const mixed = await Promise.allSettled([apply(e2, p), commitArchitectureRevision({ mapId: mapA, anonId: actor, base, result: legacyResult() })]);
  assert.equal(mixed.filter(r => r.status === 'fulfilled').length, 1);
  const loser = mixed.find(r => r.status === 'rejected').reason;
  assert.ok(loser.code === 'revision_conflict' || loser instanceof RevisionConflictError);
  assert.equal(db.maps.get(mapA).current_revision, 2); assert.equal(db.history.length, 3); assertReleased();
});

test('forced update/snapshot/receipt/commit failures roll back all canonical and proposal changes', async t => {
  for (const stage of ['update-map','snapshot','applied','commit']) await t.test(stage, async () => {
    db = new Database(); const e = engine(), p = await preview(e), before = copy({ maps: db.maps, history: db.history, proposals: db.proposals });
    db.failAt = stage; await assert.rejects(() => apply(e, p));
    assert.deepEqual({ maps: db.maps, history: db.history, proposals: db.proposals }, before); assert.equal(db.usage.length, 0); assertReleased();
    const retry = await apply(e, p); assert.equal(retry.response.revision, 2); assert.equal(db.history.length, 3); assertReleased();
  });
});

test('lost apply COMMIT acknowledgement is recovered from the saved receipt without a duplicate write', async () => {
  db = new Database(); const e = engine(), p = await preview(e); db.uncertainCommit = true;
  await assert.rejects(() => apply(e, p)); assert.equal(db.maps.get(mapA).current_revision, 2); assert.equal(db.history.length, 3);
  const replay = await apply(e, p); assert.equal(replay.replayed, true); assert.equal(replay.response.revision, 2);
  assert.equal(db.history.length, 3); assert.equal(db.modelCalls, 1); assertReleased();
});

test('uncertain preview reservation/publication never authorizes a duplicate generation', async () => {
  db = new Database(); const e = engine(), key = randomUUID(); db.uncertainCommit = true;
  await assert.rejects(() => preview(e, key)); assert.equal(db.modelCalls, 0); await rejects(() => preview(e, key), 'preview_in_progress');
  db.clock = new Date(db.clock.getTime() + 181000); await rejects(() => preview(e, key), 'generation_timeout'); assert.equal(db.modelCalls, 0); assertReleased();
  db = new Database(); const key2 = randomUUID(), e2 = engine(async () => { db.uncertainCommit = true; return { summary: 'Saved preview' }; });
  await assert.rejects(() => preview(e2, key2)); const replay = await preview(e2, key2);
  assert.equal(replay.replayed, true); assert.equal(db.modelCalls, 1); assert.equal(db.proposals.size, 1); assertReleased();
});

test('HTTP routes preserve owner/origin guards, envelope, replay headers, parser limits and production interlock', async t => {
  db = new Database(); const e = engine();
  const app = createApp({ changesRouter: createChangesRouter({ engine: e, assertAvailable: () => {} }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const cookie = who => `mappr_anon=${who}.${createHmac('sha256', process.env.COOKIE_SECRET).update(who).digest('hex')}`;
  async function httpRequest(path, body, { who = actor, origin = process.env.FRONTEND_ORIGIN, key = randomUUID(), raw } = {}) {
    const text = raw ?? JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'Idempotency-Key': key,
        ...(who ? { Cookie: cookie(who) } : {}), ...(origin ? { Origin: origin } : {}),
      } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
      req.setTimeout(5000, () => req.destroy(new Error('Offline HTTP timeout'))); req.on('error', reject); req.end(text);
    });
  }
  const path = `/maps/${mapA}/changes/preview`;
  for (const suffix of ['preview', `${randomUUID()}/apply`, `${randomUUID()}/reject`]) {
    const target = `/maps/${mapA}/changes/${suffix}`;
    for (const [options, code, status] of [[{ who: null }, 'session_required', 401], [{ who: stranger }, 'not_found', 404],
      [{ origin: 'https://untrusted.mappr.test' }, 'origin_not_allowed', 403]]) {
      const r = await httpRequest(target, request(), options); assert.equal(r.status, status); assert.equal(r.body.error, code);
      assert.ok(r.body.requestId); assert.equal(r.headers['cache-control'], 'no-store');
    }
  }
  assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0);
  for (const [options, code, status] of [[{ key: 'bad' }, 'invalid_request', 400], [{ raw: '{invalid' }, 'invalid_request', 400],
    [{ raw: 'x'.repeat(103000) }, 'request_too_large', 413]]) {
    const r = await httpRequest(path, request(), options); assert.equal(r.status, status); assert.equal(r.body.error, code); assert.ok(r.body.requestId);
  }
  const key = randomUUID(), first = await httpRequest(path, request(), { key }); assert.equal(first.status, 201);
  const replay = await httpRequest(path, request(), { key }); assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.deepEqual(replay.body, first.body);
  assert.match(replay.headers['access-control-expose-headers'], /Date/);
  const applyPath = `/maps/${mapA}/changes/${first.body.proposalId}/apply`;
  db.failAt = 'commit'; const failedApply = await httpRequest(applyPath, approval());
  assert.equal(failedApply.status, 500); assert.equal(failedApply.body.error, 'internal_error');
  assert.equal(failedApply.body.retry, 'same_request'); assert.equal(JSON.stringify(failedApply.body).includes('private-sentinel'), false);
  assert.equal(db.maps.get(mapA).current_revision, 1);
  const applied = await httpRequest(applyPath, approval()), again = await httpRequest(applyPath, approval());
  assert.equal(applied.status, 200); assert.equal(again.headers['idempotency-replayed'], 'true'); assert.deepEqual(again.body, applied.body);
  const disabledServer = createApp().listen(0, '127.0.0.1'); await once(disabledServer, 'listening');
  t.after(async () => { disabledServer.closeAllConnections(); await new Promise(resolve => disabledServer.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${disabledServer.address().port}/maps/${mapA}/changes/preview`, {
    method: 'POST', headers: { Cookie: cookie(actor), Origin: process.env.FRONTEND_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(request()),
  });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'feature_disabled'); assert.equal(db.modelCalls, 1); assertReleased();
  process.env.MAPPR_CHANGES_ENABLED = 'true';
  try {
    const blocked = await fetch(`http://127.0.0.1:${disabledServer.address().port}/maps/${mapA}/changes/preview`, {
      method: 'POST', headers: { Cookie: cookie(actor), Origin: process.env.FRONTEND_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(request()),
    });
    assert.equal(blocked.status, 503); assert.equal((await blocked.json()).error, 'preview_policy_not_configured');
    assert.equal(db.proposals.size, 1); assert.equal(db.modelCalls, 1);
  } finally { delete process.env.MAPPR_CHANGES_ENABLED; }
});

test('prepared additive migration has durable binding, lifecycle and unique history association; never executed', () => {
  const sql = readFileSync(new URL('../../src/db/migrations/014_change_proposals.sql', import.meta.url), 'utf8').replace(/--[^\r\n]*/g, '');
  assert.match(sql, /CREATE TABLE public\.map_change_proposals/); assert.match(sql, /UNIQUE \(actor_id,map_id,preview_key\)/);
  assert.match(sql, /FOREIGN KEY \(map_id,base_revision\)/); assert.match(sql, /UNIQUE \(proposal_id\)/);
  assert.match(sql, /apply_receipt jsonb/); assert.match(sql, /lease_expires_at timestamptz NOT NULL/);
  assert.match(sql, /ALTER TABLE public\.map_change_proposals ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.map_change_proposals FROM PUBLIC/);
  assert.match(sql, /ARRAY\['anon','authenticated'\]/); assert.match(sql, /pg_catalog\.has_table_privilege/);
  assert.doesNotMatch(sql, /CREATE POLICY|FORCE ROW LEVEL SECURITY|ALTER DEFAULT PRIVILEGES|GRANT\b/);
  assert.doesNotMatch(sql, /(?:^|;)\s*(?:UPDATE|DELETE|TRUNCATE|DROP|INSERT)\b/im); assert.doesNotMatch(sql, /ALTER TABLE public\.maps/);
});

function fixtureAdmission(quota = async () => ({ allowed: true })) {
  return createPreviewAdmission({ checkQuota: quota, ledger: {
    assertConfigured() {},
    reserve: (client, intent) => client.query('/* fixture:admission */', ['reserve', intent.proposalId]),
    ready: (client, intent) => client.query('/* fixture:admission */', ['ready', intent.proposalId]),
    failed: (client, intent, reason) => client.query('/* fixture:admission */', ['failed', intent.proposalId, reason]),
  } });
}
test('S4C actual provider adapter through the engine preserves concurrent same-key identity, ready replay and free apply', async () => {
  db = new Database(); const entered = deferred(), release = deferred(); let quotaChecks = 0, calls = 0;
  providerHook = async config => {
    calls++; assert.equal(config.groqSchemaName, 'overview_summary'); assert.equal(config.redactErrors, true);
    assert.match(config.buildPrompt(), /replacement product.summary/); assert.equal(config.signal.aborted, false);
    entered.resolve(); await release.promise; return { summary: 'Shared infrastructure summary' };
  };
  try {
    const e = engine(generateOverviewSummary, { admission: fixtureAdmission(async () => { quotaChecks++; return { allowed: true }; }) }), key = randomUUID();
    const first = preview(e, key); await entered.promise;
    await rejects(() => preview(e, key), 'preview_in_progress'); release.resolve(); const p = await first;
    assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','ready']);
    assert.equal((await preview(e, key)).replayed, true); const applied = await apply(e, p); assert.equal(applied.response.revision, 2);
    assert.equal((await apply(e, p)).replayed, true); assert.equal(calls, 1); assert.equal(quotaChecks, 1);
    assert.equal(db.usage.length, 0, 'No approved billing policy exists'); assertReleased();
  } finally { providerHook = undefined; }
});

test('S4C adapter failures, no-op and cancellation settle once with no duplicate provider work or usage', async t => {
  for (const [kind, code] of [['provider','change_generation_failed'],['invalid','change_not_valid'],['no-op','no_changes'],['timeout','generation_timeout']]) {
    await t.test(kind, async () => {
      db = new Database(); let calls = 0; const never = deferred();
      const generate = createOverviewProvider({ timeoutMs: 10, structured: async () => {
        calls++; if (kind === 'provider') throw new Error('private-sentinel');
        if (kind === 'invalid') return { summary: 'Text', arbitraryPatch: {} };
        if (kind === 'no-op') return { summary: initial.product.summary };
        return never.promise;
      } });
      const e = engine(generate, { admission: fixtureAdmission() }), key = randomUUID();
      await rejects(() => preview(e, key), code); await rejects(() => preview(e, key), code);
      assert.equal(calls, 1); assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','failed']);
      assert.equal(db.admissionEvents[1].reason, code); assert.equal(db.usage.length, 0); assert.equal(db.history.length, 2);
      never.resolve({ summary: 'Late output' }); await new Promise(resolve => setImmediate(resolve));
      assert.equal([...db.proposals.values()][0].state, 'failed'); assertReleased();
    });
  }
});

test('S4C unconfigured admission and exhausted existing ceilings fail before provider calls', async () => {
  db = new Database(); const blocked = engine(undefined, { admission: undefined });
  await rejects(() => preview(blocked), 'preview_policy_not_configured'); assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0);
  for (const [reason, code] of [['user_limit','daily_limit_exceeded'],['global_limit','capacity_exceeded']]) {
    const e = engine(undefined, { admission: fixtureAdmission(async () => ({ allowed: false, reason })) });
    await rejects(() => preview(e), code); assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0); assert.equal(db.admissionEvents.length, 0);
  }
  assertReleased();
});

test('S4C admission/ready/failure notifications are atomic and uncertain commits do not duplicate settlement', async () => {
  db = new Database(); let e = engine(undefined, { admission: fixtureAdmission() });
  db.admissionFail = 'reserve'; await assert.rejects(() => preview(e)); assert.equal(db.proposals.size, 0); assert.equal(db.admissionEvents.length, 0); assert.equal(db.modelCalls, 0);
  db = new Database(); e = engine(undefined, { admission: fixtureAdmission() }); db.admissionFail = 'ready'; const key = randomUUID();
  await assert.rejects(() => preview(e, key)); assert.equal([...db.proposals.values()][0].state, 'generating');
  assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve']);
  await rejects(() => preview(e, key), 'preview_in_progress'); db.clock = new Date(db.clock.getTime() + 181000);
  await rejects(() => preview(e, key), 'generation_timeout'); assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','failed']);
  db = new Database(); e = engine(async () => { throw new Error('private-sentinel provider failure'); }, { admission: fixtureAdmission() });
  db.admissionFail = 'failed'; const failedKey = randomUUID();
  await rejects(() => preview(e, failedKey), 'internal_error');
  assert.equal([...db.proposals.values()][0].state, 'generating', 'Failed settlement rolls back its terminal proposal transition');
  assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve']);
  await rejects(() => preview(e, failedKey), 'preview_in_progress'); db.clock = new Date(db.clock.getTime() + 181000);
  await rejects(() => preview(e, failedKey), 'generation_timeout');
  assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','failed']); assert.equal(db.modelCalls, 1);
  db = new Database(); e = engine(undefined, { admission: fixtureAdmission() }); db.uncertainCommit = true;
  const admittedKey = randomUUID(); await assert.rejects(() => preview(e, admittedKey));
  assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve']); assert.equal(db.modelCalls, 0);
  await rejects(() => preview(e, admittedKey), 'preview_in_progress'); db.clock = new Date(db.clock.getTime() + 181000);
  await rejects(() => preview(e, admittedKey), 'generation_timeout');
  assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','failed']); assert.equal(db.modelCalls, 0);
  db = new Database(); e = engine(async () => { db.uncertainCommit = true; return { summary: 'Saved ready response' }; }, { admission: fixtureAdmission() });
  const otherKey = randomUUID(); await assert.rejects(() => preview(e, otherKey)); const replay = await preview(e, otherKey);
  assert.equal(replay.replayed, true); assert.deepEqual(db.admissionEvents.map(e => e.stage), ['reserve','ready']); assert.equal(db.modelCalls, 1); assertReleased();
});

function allowance(t, generate, options = {}) {
  process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true';
  t.after(() => { delete process.env.MAPPR_DAILY_ADMISSION_ENABLED; delete process.env.CHANGE_PROPOSAL_TTL_SECONDS; });
  const service = new DailyAdmission(db);
  return { service, e: engine(generate, { admission: createDailyPreviewAdmission(service), ...options }) };
}
test('S4D ready preview consumes exactly one allowance unit; concurrent replay and Apply remain free', async t => {
  db = new Database(); const entered = deferred(), release = deferred();
  const { e } = allowance(t, async () => { entered.resolve(); await release.promise; return { summary: 'Approved allowance preview' }; });
  const key = randomUUID(), first = preview(e,key); await entered.promise;
  await rejects(() => preview(e,key),'preview_in_progress'); release.resolve(); const p = await first;
  assert.equal(db.usage.length,1); assert.equal([...db.daily.attempts.values()][0].state,'succeeded');
  assert.equal((await preview(e,key)).replayed,true); assert.equal(p.response.expiresAt,'2026-11-10T12:15:00.000Z');
  await apply(e,p); await apply(e,p); assert.equal(db.usage.length,1); assert.equal(db.modelCalls,1); assertReleased();
});
test('S4D invalid/no-op/provider/timeout failures release durable holds exactly once', async t => {
  for (const [kind,code] of [['invalid','change_not_valid'],['no-op','no_changes'],['provider','change_generation_failed'],['timeout','generation_timeout']]) {
    await t.test(kind,async t=>{
      db = new Database(); const late=deferred();
      const {e}=allowance(t,async()=>{if(kind==='provider')throw new Error('private fixture');if(kind==='timeout')return late.promise;
        return kind==='invalid'?{summary:'Text',patch:{}}:{summary:initial.product.summary};},{generationTimeoutMs:10});
      const key=randomUUID(); await rejects(()=>preview(e,key),code); await rejects(()=>preview(e,key),code);
      assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');assert.equal(db.modelCalls,1);
      late.resolve({summary:'Too late'});await new Promise(done=>setImmediate(done));assertReleased();
    });
  }
});
test('S4D stale preview releases capacity after a real shared-ledger Architecture revision',async t=>{
  db=new Database();const entered=deferred(),release=deferred();
  const {e,service}=allowance(t,async()=>{entered.resolve();await release.promise;return {summary:'Stale'};});
  const pending=preview(e);await entered.promise;const base=await readCanonicalBase(mapA,actor);
  const attempt=await service.reserve({actorId:actor,mapId:mapA,operation:'iterate'});
  await commitArchitectureRevision({mapId:mapA,anonId:actor,base,result:legacyResult(),attempt});release.resolve();
  await rejects(()=>pending,'revision_conflict');assert.equal(db.usage.length,1);
  assert.deepEqual([...db.daily.attempts.values()].map(a=>a.state).sort(),['failed','succeeded']);assertReleased();
});
test('S4D lost preview admission and ready COMMIT acknowledgements preserve one identity and one unit',async t=>{
  db=new Database();let {e,service}=allowance(t);db.onDailyReserve=()=>{db.uncertainCommit=true;};const key=randomUUID();
  await assert.rejects(()=>preview(e,key));db.onDailyReserve=null;assert.equal(db.modelCalls,0);
  await rejects(()=>preview(e,key),'preview_in_progress');db.clock=new Date(+db.clock+181000);await service.recoverExpired();
  await rejects(()=>preview(e,key),'generation_timeout');assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');
  db=new Database();({e}=allowance(t,async()=>{db.uncertainCommit=true;return {summary:'Saved once'};}));const readyKey=randomUUID();
  await rejects(()=>preview(e,readyKey),'internal_error');const p=await preview(e,readyKey);assert.equal(p.replayed,true);
  assert.equal(db.usage.length,1);await apply(e,p);assert.equal(db.usage.length,1);assert.equal(db.modelCalls,1);assertReleased();
});
test('S4D failed ready usage publication rolls back preview/usage and expiry recovery rejects a late worker',async t=>{
  db=new Database();const {e,service}=allowance(t);db.daily.failAt='usage';const key=randomUUID();
  await rejects(()=>preview(e,key),'internal_error');assert.equal(db.usage.length,0);assert.equal([...db.proposals.values()][0].state,'generating');
  db.clock=new Date(+db.clock+181000);await service.recoverExpired();await rejects(()=>preview(e,key),'generation_timeout');
  assert.equal([...db.daily.attempts.values()][0].state,'failed');assert.equal(db.modelCalls,1);assertReleased();
});
test('S4D expired ready previews keep successful usage; owner changes allow only internal orphan recovery',async t=>{
  db=new Database();let {e}=allowance(t);const key=randomUUID(),p=await preview(e,key);db.clock=new Date(+db.clock+901000);
  await rejects(()=>apply(e,p),'proposal_expired');assert.equal((await preview(e,key)).replayed,true);assert.equal(db.usage.length,1);
  db=new Database();const entered=deferred(),release=deferred();const setup=allowance(t,async()=>{entered.resolve();await release.promise;return {summary:'Lost owner'};});e=setup.e;
  const pending=preview(e);await entered.promise;db.maps.get(mapA).anon_id=stranger;release.resolve();await rejects(()=>pending,'not_found');
  db.clock=new Date(+db.clock+181000);await setup.service.recoverExpired();assert.equal([...db.daily.attempts.values()][0].state,'failed');
  assert.equal(db.maps.get(mapA).anon_id,stranger);assert.equal(db.usage.length,0);assertReleased();
});
test('S4D default factory policy cannot override approved 900-second expiry or the release interlock',async t=>{
  db=new Database();const {e}=allowance(t);process.env.CHANGE_PROPOSAL_TTL_SECONDS='60';
  await rejects(()=>preview(e),'preview_policy_not_configured');assert.equal(db.modelCalls,0);assert.equal(db.daily.attempts.size,0);
  process.env.MAPPR_CHANGES_ENABLED='true';t.after(()=>delete process.env.MAPPR_CHANGES_ENABLED);
  assert.throws(assertChangesAvailable,error=>error.code==='preview_policy_not_configured');assertReleased();
});

const graphNode=(id,label=id)=>({id,label,type:'service',description:'Fixture '+id});
const graphUpsert=value=>({op:'upsert_item',collection:'architecture.nodes',value});
const graphRemove=key=>({op:'remove_item',collection:'architecture.nodes',key});
const archRequest=(revision=1,target=null)=>({instruction:'Describe the requested graph change.',context:{activeView:'architecture',selectedTarget:target},expectedBaseRevision:revision});
function architectureFixture(){
  db=new Database();const architecture={nodes:[{...graphNode('api'),extension:{keep:17}},graphNode('db')],edges:[{from:'api',to:'db',label:null}],extension:{keep:true}};
  for(const map of db.maps.values())map.data.architecture=copy(architecture);
  for(const row of db.history)row.data.architecture=copy(architecture);
}
test('S4F Architecture Preview/Apply reuses proposal/revision/admission and exposes actual cascades without mutating other views',async t=>{
 architectureFixture();const before=copy(db.maps.get(mapA)),artifacts=copy(db.artifacts);
 const {e}=allowance(t,async()=>({operations:[graphRemove('api'),graphUpsert(graphNode('cache'))]}));
 const key=randomUUID(),p=await preview(e,key,archRequest());
 assert.deepEqual(db.maps.get(mapA),before);assert.equal(db.usage.length,1);assert.equal(db.history.length,2);
 assert.equal(p.response.context.activeView,'architecture');assert.deepEqual(p.response.affectedSections,['architecture']);
 assert.deepEqual(p.response.operations.at(-1),{op:'replace_list',path:'architecture.edges',value:[]});
 assert.equal(p.response.diff.architecture.edges.removed.length,1);assert.match(p.response.summary,/1 node added, 1 node removed, 1 edge removed/);
 assert.equal(p.response.warnings.some(w=>w.code==='summary_only'),false);
 const replay=await preview(e,key,archRequest());assert.deepEqual(replay.response,p.response);assert.equal(db.modelCalls,1);
 const result=await apply(e,p);assert.equal(result.response.revision,2);assert.equal(result.response.status,'applied');
 const reverted=copy(result.response.data);reverted.architecture=before.data.architecture;assert.deepEqual(reverted,before.data);
 assert.deepEqual(db.artifacts,artifacts);assert.equal(db.usage.length,1);assert.equal(db.history.length,3);
 assert.deepEqual(db.history.at(-1).data,result.response.data);assert.deepEqual(db.history.at(-1).change_metadata.operations,p.response.operations);
 assert.equal(db.history.at(-1).change_metadata.validationPolicy.scope,'architecture');assert.equal((await apply(e,p)).replayed,true);
 assert.ok(db.queries.some(q=>q.startsWith('/* changes:update-map */')&&q.includes("'{architecture}'")));
 assertReleased();
});
test('S4F malformed Architecture base and selected targets fail before admission or AI; invalid output settles without usage',async t=>{
 for(const variant of ['missing target','wrong target kind','duplicate nodes','dangling base'])await t.test(variant,async()=>{
  architectureFixture();let input=archRequest();
  if(variant==='missing target')input=archRequest(1,{kind:'architecture_node',id:'absent'});
  if(variant==='wrong target kind')input=archRequest(1,{kind:'entity',id:'api'});
  if(variant==='duplicate nodes')db.maps.get(mapA).data.architecture.nodes.push(graphNode('api'));
  if(variant==='dangling base')db.maps.get(mapA).data.architecture.edges.push({from:'missing',to:'db'});
  db.history[0].data=copy(db.maps.get(mapA).data);
  await assert.rejects(()=>preview(engine(),randomUUID(),input));assert.equal(db.proposals.size,0);assert.equal(db.modelCalls,0);assertReleased();
 });
 architectureFixture();const {e}=allowance(t,async()=>({operations:[graphRemove('absent')]}));const key=randomUUID();
 await rejects(()=>preview(e,key,archRequest()),'change_not_valid');await rejects(()=>preview(e,key,archRequest()),'change_not_valid');
 assert.equal(db.modelCalls,1);assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');assertReleased();
});
test('S4F Architecture, Overview and legacy iteration share revision conflicts, expiry and saved validation',async t=>{
 architectureFixture();const e=engine(async()=>({operations:[graphUpsert(graphNode('api','Renamed API'))]}));
 const arch=await preview(e,randomUUID(),archRequest());const overview=await preview(engine(),randomUUID());
 await apply(engine(),overview);await rejects(()=>apply(e,arch),'revision_conflict');
 architectureFixture();const entered=deferred(),release=deferred();const slow=engine(async()=>{entered.resolve();await release.promise;return{operations:[graphRemove('api')]}});
 const pending=preview(slow,randomUUID(),archRequest());await entered.promise;
 const base=await readCanonicalBase(mapA,actor);await commitArchitectureRevision({mapId:mapA,anonId:actor,base,result:legacyResult()});release.resolve();
 await rejects(()=>pending,'revision_conflict');assert.equal(db.maps.get(mapA).current_revision,2);
 architectureFixture();const expiryEngine=engine(async()=>({operations:[graphRemove('api')]}));const expired=await preview(expiryEngine,randomUUID(),archRequest());db.clock=new Date(+db.clock+901000);await rejects(()=>apply(expiryEngine,expired),'proposal_expired');
 for(const mutate of [p=>p.validation_policy.scope='tampered',p=>p.preview_response.operations[0].value.label='tampered',p=>p.preview_response.context.selectedTarget={kind:'architecture_node',id:'api'}])await t.test('saved tamper',async()=>{
  architectureFixture();const tamperEngine=engine(async()=>({operations:[graphUpsert(graphNode('api','Renamed API'))]}));const p=await preview(tamperEngine,randomUUID(),archRequest());mutate(db.proposals.get(p.response.proposalId));
  await rejects(()=>apply(tamperEngine,p),'proposal_obsolete');assert.equal(db.maps.get(mapA).current_revision,1);assertReleased();
 });
});
test('S4F Architecture Apply rolls back atomic map/history/receipt failures and recovers a lost acknowledgement',async t=>{
 for(const stage of ['update-map','snapshot','applied','commit'])await t.test(stage,async()=>{
  architectureFixture();const e=engine(async()=>({operations:[graphRemove('api')]})),p=await preview(e,randomUUID(),archRequest());const before=copy(db.maps.get(mapA));db.failAt=stage;
  await assert.rejects(()=>apply(e,p));assert.deepEqual(db.maps.get(mapA),before);assert.equal(db.history.length,2);assert.equal(db.proposals.get(p.response.proposalId).state,'ready');assertReleased();
 });
 architectureFixture();const e=engine(async()=>({operations:[graphRemove('api')]})),p=await preview(e,randomUUID(),archRequest());db.uncertainCommit=true;
 await assert.rejects(()=>apply(e,p));const replay=await apply(e,p);assert.equal(replay.replayed,true);assert.equal(replay.response.revision,2);assert.equal(db.history.length,3);assert.equal(db.modelCalls,1);assertReleased();
});
test('S4F explicit rejection is owner-bound, idempotent, free and serializes with Apply',async t=>{
 architectureFixture();const {e}=allowance(t,async()=>({operations:[graphRemove('api')]})),p=await preview(e,randomUUID(),archRequest());const id=p.response.proposalId,body={rejected:true,expectedBaseRevision:1};
 await rejects(()=>e.reject(mapA,stranger,id,body),'not_found');await rejects(()=>e.reject(mapA,actor,id,{rejected:false,expectedBaseRevision:1}),'invalid_request');
 await rejects(()=>e.reject(mapA,actor,id,{...body,expectedBaseRevision:2}),'proposal_mismatch');
 db.failAt='reject';await assert.rejects(()=>e.reject(mapA,actor,id,body));assert.equal(db.proposals.get(id).state,'ready');
 const before=copy(db.maps.get(mapA)),results=await Promise.all([e.reject(mapA,actor,id,body),e.reject(mapA,actor,id,body)]);
 assert.equal(results[0].response.status,'rejected');assert.deepEqual(results[0].response,results[1].response);assert.equal(results[1].replayed,true);
 assert.deepEqual(db.maps.get(mapA),before);assert.equal(db.history.length,2);assert.equal(db.usage.length,1);await rejects(()=>apply(e,p),'proposal_rejected');
 const second=await preview(e,randomUUID(),archRequest());assert.equal(second.response.status,'ready');assert.equal(db.usage.length,2);
 db.uncertainCommit=true;await assert.rejects(()=>e.reject(mapA,actor,second.response.proposalId,body));
 assert.equal((await e.reject(mapA,actor,second.response.proposalId,body)).replayed,true);assert.equal(db.usage.length,2);
 architectureFixture();const e2=engine(async()=>({operations:[graphRemove('api')]})),p2=await preview(e2,randomUUID(),archRequest());
 const outcomes=await Promise.allSettled([apply(e2,p2),e2.reject(mapA,actor,p2.response.proposalId,body)]);
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(db.maps.get(mapA).current_revision,2);assertReleased();
});
test('S4F Architecture and Overview contend for the same last daily allowance unit before AI',async t=>{
 architectureFixture();db.usage.push({actorId:actor,mapId:mapA,createdAt:db.clock});const entered=deferred(),release=deferred();
 const {e}=allowance(t,async()=>{entered.resolve();await release.promise;return{operations:[graphRemove('api')]}});
 const pending=preview(e,randomUUID(),archRequest());await entered.promise;
 await rejects(()=>preview(e,randomUUID(),request()),'daily_limit_exceeded');assert.equal(db.modelCalls,1);
 release.resolve();await pending;assert.equal(db.usage.length,2);assertReleased();
});
test('S4F HTTP Architecture previews and explicit rejection use existing owner/origin guards and immutable replay',async t=>{
 architectureFixture();const e=engine(async()=>({operations:[graphRemove('api')]}));
 const server=createApp({changesRouter:createChangesRouter({engine:e,assertAvailable:()=>{}})}).listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
 async function send(path,body,who=actor){const text=JSON.stringify(body),cookie=`mappr_anon=${who}.${createHmac('sha256',process.env.COOKIE_SECRET).update(who).digest('hex')}`;
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{Origin:process.env.FRONTEND_ORIGIN,Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(parts).toString())}))});req.on('error',reject);req.end(text)});
 }
 const p=await send(`/maps/${mapA}/changes/preview`,archRequest());assert.equal(p.status,201);assert.deepEqual(p.body.affectedSections,['architecture']);
 const rejectPath=`/maps/${mapA}/changes/${p.body.proposalId}/reject`,body={rejected:true,expectedBaseRevision:1};
 assert.equal((await send(rejectPath,body,stranger)).status,404);assert.equal((await send(rejectPath,{...body,rejected:false})).status,400);
 const rejected=await send(rejectPath,body),replay=await send(rejectPath,body);assert.equal(rejected.status,200);assert.equal(rejected.body.status,'rejected');
 assert.deepEqual(replay.body,rejected.body);assert.equal(replay.headers['idempotency-replayed'],'true');assert.equal(replay.headers['cache-control'],'no-store');
 const applied=await send(`/maps/${mapA}/changes/${p.body.proposalId}/apply`,approval());assert.equal(applied.status,410);assert.equal(applied.body.error,'proposal_rejected');
 assert.equal(db.maps.get(mapA).current_revision,1);assert.equal(db.modelCalls,1);assertReleased();
});
test('S4F default factory selects Architecture provider context and records its generator without changing allowance operation',async t=>{
 architectureFixture();process.env.MAPPR_DAILY_ADMISSION_ENABLED='true';t.after(()=>delete process.env.MAPPR_DAILY_ADMISSION_ENABLED);
 const {createChangeEngine}=await import('../../src/services/changes/engine.ts');const e=createChangeEngine({connect:()=>db.connect()});
 providerHook=async config=>{assert.equal(config.groqSchemaName,'architecture_change');assert.match(config.buildPrompt(),/architecture_node/);return{operations:[graphUpsert(graphNode('api','Default factory API'))]}};
 try{const p=await preview(e,randomUUID(),archRequest(1,{kind:'architecture_node',id:'api'}));const row=db.proposals.get(p.response.proposalId);
  assert.equal(row.generator_id,'architecture-operations:shared-ai-v1');assert.equal(row.request_payload.context.activeView,'architecture');
  assert.equal([...db.daily.attempts.values()][0].operation,'overview_preview');assert.equal(db.usage.length,1);
 }finally{providerHook=undefined;}assertReleased();
});

const technology = (category, choice = category) => ({ category, choice, rationale: 'Reason for ' + choice });
const stackUp = value => ({ op: 'upsert_item', collection: 'techStack', value });
const stackRemove = key => ({ op: 'remove_item', collection: 'techStack', key });
const stackRequest = (revision = 1) => ({ instruction: 'Replace the database with SQLite, remove the frontend and add Redis.',
  context: { activeView: 'tech-stack', selectedTarget: null }, expectedBaseRevision: revision });
function techStackFixture() {
  architectureFixture();
  const stack = [{ ...technology('Database', 'PostgreSQL'), extension: { keep: 17 } }, technology('Frontend', 'React')];
  for (const row of db.maps.values()) row.data.techStack = copy(stack);
  for (const row of db.history) row.data.techStack = copy(stack);
}
const stackOutput = () => ({ operations: [stackUp(technology('Database', 'SQLite')), stackRemove('Frontend'), stackUp(technology('Cache', 'Redis'))] });

test('S4G Tech Stack Preview/Apply uses the shared lifecycle, exact diff, one daily unit and scoped atomic storage', async t => {
  techStackFixture(); const before = copy(db.maps), artifacts = copy(db.artifacts), { e } = allowance(t, async () => stackOutput());
  const key = randomUUID(), p = await preview(e, key, stackRequest());
  assert.deepEqual(db.maps, before); assert.equal(db.history.length, 2); assert.equal(db.usage.length, 1);
  assert.deepEqual(p.response.context, stackRequest().context); assert.deepEqual(p.response.affectedSections, ['techStack']);
  assert.deepEqual(p.response.operations, stackOutput().operations); assert.equal(p.response.diff.techStack.changed[0].before.choice, 'PostgreSQL');
  assert.equal(p.response.diff.techStack.changed[0].after.choice, 'SQLite'); assert.equal(p.response.diff.techStack.removed[0].category, 'Frontend');
  assert.equal(p.response.diff.techStack.added[0].category, 'Cache'); assert.equal(p.response.warnings[0].code, 'tech_stack_only');
  await rejects(() => preview(e, key, { ...stackRequest(), instruction: 'Different instruction' }), 'idempotency_key_reused');
  assert.deepEqual((await preview(e, key, stackRequest())).response, p.response);
  const result = await apply(e, p); assert.equal(result.response.revision, 2); assert.equal(result.response.version, 2);
  const restored = copy(result.response.data); restored.techStack = before.get(mapA).data.techStack; assert.deepEqual(restored, before.get(mapA).data);
  assert.deepEqual(result.response.data.techStack[0].extension, { keep: 17 }); assert.deepEqual(db.maps.get(mapB), before.get(mapB));
  assert.equal(db.maps.get(mapA).anon_id, before.get(mapA).anon_id); assert.equal(db.maps.get(mapA).input_description, before.get(mapA).input_description);
  assert.deepEqual(db.maps.get(mapA).created_at, before.get(mapA).created_at); assert.deepEqual(db.artifacts, artifacts);
  assert.equal(db.history.length, 3); assert.deepEqual(db.history.at(-1).data, result.response.data);
  assert.equal(db.history.at(-1).change_metadata.validationPolicy.scope, 'tech-stack'); assert.equal(db.history.at(-1).patch, null);
  assert.equal((await apply(e, p)).replayed, true); assert.equal(db.modelCalls, 1); assert.equal(db.usage.length, 1);
  assert.ok(db.queries.some(sql => sql.startsWith('/* changes:update-map */') && sql.includes("'{techStack}'"))); assertReleased();
});

test('S4G Tech Stack ambiguous bases and unsupported context fail before generation/admission', async t => {
  for (const variant of ['duplicate category', 'blank category', 'selected target', 'wrong view identifier', 'non-owner', 'stale revision']) await t.test(variant, async () => {
    techStackFixture(); let input = stackRequest(), who = actor, code = 'change_not_valid';
    if (variant === 'duplicate category') db.maps.get(mapA).data.techStack.push(technology('Database'));
    if (variant === 'blank category') db.maps.get(mapA).data.techStack[0].category = ' ';
    if (variant === 'selected target') { input.context.selectedTarget = { kind: 'architecture_node', id: 'api' }; code = 'unsupported_scope'; }
    if (variant === 'wrong view identifier') { input.context.activeView = 'tech_stack'; code = 'unsupported_scope'; }
    if (variant === 'non-owner') { who = stranger; code = 'not_found'; }
    if (variant === 'stale revision') { input.expectedBaseRevision = 2; code = 'revision_conflict'; }
    db.history[0].data = copy(db.maps.get(mapA).data); const { e } = allowance(t, async () => stackOutput());
    await rejects(() => preview(e, randomUUID(), input, mapA, who), code);
    assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0); assert.equal(db.daily.attempts.size, 0); assert.equal(db.usage.length, 0); assertReleased();
  });
});

test('S4G Tech Stack invalid/no-op/provider failures settle once, preserve canonical state and never consume successful usage', async t => {
  for (const [name, code] of [['invalid', 'change_not_valid'], ['no-op', 'no_changes'], ['provider', 'change_generation_failed']]) await t.test(name, async () => {
    techStackFixture(); const before = copy(db.maps.get(mapA)); const { e } = allowance(t, async () => {
      if (name === 'provider') throw new Error('Private provider sentinel');
      return { operations: name === 'no-op' ? [stackUp(technology('Database', 'PostgreSQL'))] : [stackRemove('Absent')] };
    });
    const key = randomUUID(); await rejects(() => preview(e, key, stackRequest()), code); await rejects(() => preview(e, key, stackRequest()), code);
    assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.modelCalls, 1); assert.equal(db.history.length, 2); assert.equal(db.usage.length, 0);
    assert.equal([...db.daily.attempts.values()][0].state, 'failed'); assertReleased();
  });
});

test('S4G Tech Stack conflicts with Overview, Architecture and legacy iteration through the same revision lock', async t => {
  for (const competing of ['overview', 'architecture', 'iterate']) await t.test(competing, async () => {
    techStackFixture(); const stackEngine = engine(async () => stackOutput()), p = await preview(stackEngine, randomUUID(), stackRequest());
    if (competing === 'iterate') {
      const base = await readCanonicalBase(mapA, actor), result = legacyResult(); result.newSystem.techStack = copy(base.system.techStack);
      await commitArchitectureRevision({ mapId: mapA, anonId: actor, base, result });
    } else {
      const e = competing === 'overview' ? engine() : engine(async () => ({ operations: [graphRemove('api')] }));
      const other = await preview(e, randomUUID(), competing === 'overview' ? request() : archRequest()); await apply(e, other);
    }
    const current = copy(db.maps.get(mapA)); await rejects(() => apply(stackEngine, p), 'revision_conflict');
    assert.deepEqual(db.maps.get(mapA), current); assert.equal(db.maps.get(mapA).current_revision, 2); assert.equal(db.history.length, 3); assertReleased();
  });
  techStackFixture(); const entered = deferred(), release = deferred(), e = engine(async () => { entered.resolve(); await release.promise; return stackOutput(); });
  const pending = preview(e, randomUUID(), stackRequest()); await entered.promise;
  const otherEngine = engine(), other = await preview(otherEngine); await apply(otherEngine, other); release.resolve();
  await rejects(() => pending, 'revision_conflict'); assert.equal(db.history.length, 3); assertReleased();
});

test('S4G Tech Stack expiry and tampered saved operations, diff, policy and context cannot be applied', async t => {
  for (const variant of ['expiry', 'operation', 'diff', 'summary', 'scope', 'context']) await t.test(variant, async () => {
    techStackFixture(); const e = engine(async () => stackOutput()), p = await preview(e, randomUUID(), stackRequest()), saved = db.proposals.get(p.response.proposalId);
    if (variant === 'expiry') db.clock = new Date(+db.clock + 901000);
    if (variant === 'operation') saved.preview_response.operations[0].value.choice = 'Tampered';
    if (variant === 'diff') saved.preview_response.diff.techStack.removed = [];
    if (variant === 'summary') saved.preview_response.summary = 'Tampered';
    if (variant === 'scope') saved.validation_policy.scope = 'overview';
    if (variant === 'context') saved.preview_response.context.activeView = 'architecture';
    const before = copy(db.maps.get(mapA)); await rejects(() => apply(e, p), variant === 'expiry' ? 'proposal_expired' : 'proposal_obsolete');
    assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2); assertReleased();
  });
});

test('S4G Tech Stack atomic Apply rollback and uncertain acknowledgement recovery preserve one revision and history entry', async t => {
  for (const stage of ['update-map', 'snapshot', 'applied', 'commit']) await t.test(stage, async () => {
    techStackFixture(); const { e } = allowance(t, async () => stackOutput()), p = await preview(e, randomUUID(), stackRequest()), before = copy(db.maps.get(mapA));
    db.failAt = stage; await assert.rejects(() => apply(e, p)); assert.deepEqual(db.maps.get(mapA), before);
    assert.equal(db.history.length, 2); assert.equal(db.proposals.get(p.response.proposalId).state, 'ready'); assert.equal(db.usage.length, 1); assertReleased();
  });
  techStackFixture(); const e = engine(async () => stackOutput()), p = await preview(e, randomUUID(), stackRequest()); db.uncertainCommit = true;
  await assert.rejects(() => apply(e, p)); const replay = await apply(e, p);
  assert.equal(replay.replayed, true); assert.equal(replay.response.revision, 2); assert.equal(db.history.length, 3); assert.equal(db.modelCalls, 1); assertReleased();
});

test('S4G Tech Stack concurrent Apply, rejection and ready-key replay retain the shared terminal contract', async t => {
  techStackFixture(); const { e } = allowance(t, async () => stackOutput()), key = randomUUID(), p = await preview(e, key, stackRequest());
  const body = { rejected: true, expectedBaseRevision: 1 }, before = copy(db.maps.get(mapA));
  const rejected = await e.reject(mapA, actor, p.response.proposalId, body); assert.equal(rejected.response.status, 'rejected');
  assert.deepEqual((await e.reject(mapA, actor, p.response.proposalId, body)).response, rejected.response);
  await rejects(() => apply(e, p), 'proposal_rejected'); assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2);
  assert.equal(db.usage.length, 1); assert.deepEqual((await preview(e, key, stackRequest())).response, p.response, 'Immutable preview does not revive rejection');
  techStackFixture(); const raceEngine = engine(async () => stackOutput()), race = await preview(raceEngine, randomUUID(), stackRequest());
  const outcome = await Promise.allSettled([apply(raceEngine, race), raceEngine.reject(mapA, actor, race.response.proposalId, body)]);
  assert.equal(outcome.filter(r => r.status === 'fulfilled').length, 1); assert.equal(db.history.length, 3);
  techStackFixture(); const sameEngine = engine(async () => stackOutput()), same = await preview(sameEngine, randomUUID(), stackRequest());
  const both = await Promise.all([apply(sameEngine, same), apply(sameEngine, same)]);
  assert.equal(both.filter(r => r.replayed).length, 1); assert.equal(db.maps.get(mapA).current_revision, 2); assert.equal(db.history.length, 3); assertReleased();
});

test('S4G Tech Stack generation shares the last daily unit and same-key generation never runs twice', async t => {
  techStackFixture(); db.usage.push({ actorId: actor, mapId: mapA, createdAt: db.clock }); const entered = deferred(), release = deferred();
  const { e } = allowance(t, async () => { entered.resolve(); await release.promise; return stackOutput(); });
  const key = randomUUID(), pending = preview(e, key, stackRequest()); await entered.promise;
  await rejects(() => preview(e, key, stackRequest()), 'preview_in_progress');
  await rejects(() => preview(e, randomUUID(), archRequest()), 'daily_limit_exceeded');
  release.resolve(); await pending; assert.equal(db.modelCalls, 1); assert.equal(db.usage.length, 2); assertReleased();
});

test('S4G default factory routes Tech Stack to existing providers and daily ledger without changing the release interlock', async t => {
  techStackFixture(); process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true'; t.after(() => delete process.env.MAPPR_DAILY_ADMISSION_ENABLED);
  const { createChangeEngine } = await import('../../src/services/changes/engine.ts'), e = createChangeEngine({ connect: () => db.connect() });
  providerHook = async config => { assert.equal(config.groqSchemaName, 'tech_stack_change'); assert.match(config.buildPrompt(), /exact case-sensitive identity/); return stackOutput(); };
  try {
    const p = await preview(e, randomUUID(), stackRequest()), row = db.proposals.get(p.response.proposalId);
    assert.equal(row.generator_id, 'tech-stack-operations:shared-ai-v1'); assert.equal(row.request_payload.context.activeView, 'tech-stack');
    assert.equal([...db.daily.attempts.values()][0].operation, 'overview_preview'); assert.equal(db.usage.length, 1);
  } finally { providerHook = undefined; }
  process.env.MAPPR_CHANGES_ENABLED = 'true'; t.after(() => delete process.env.MAPPR_CHANGES_ENABLED);
  assert.throws(assertChangesAvailable, error => error.code === 'preview_policy_not_configured'); assertReleased();
});

test('S4G HTTP Tech Stack preview, Apply and rejection retain ownership, strict requests and response metadata', async t => {
  techStackFixture(); const e = engine(async () => stackOutput());
  const server = createApp({ changesRouter: createChangesRouter({ engine: e, assertAvailable: () => {} }) }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  async function send(suffix, body, who = actor) {
    const text = JSON.stringify(body), cookie = `mappr_anon=${who}.${createHmac('sha256', process.env.COOKIE_SECRET).update(who).digest('hex')}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/maps/${mapA}/changes/${suffix}`, method: 'POST',
        headers: { Origin: process.env.FRONTEND_ORIGIN, Cookie: cookie, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => {
        const parts = []; res.on('data', part => parts.push(part)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString()) }));
      }); req.setTimeout(5000, () => req.destroy(new Error('Local fixture HTTP timeout'))); req.on('error', reject); req.end(text);
    });
  }
  assert.equal((await send('preview', stackRequest(), stranger)).status, 404); assert.equal(db.modelCalls, 0);
  const p = await send('preview', stackRequest()); assert.equal(p.status, 201); assert.deepEqual(p.body.affectedSections, ['techStack']);
  assert.equal(p.headers['cache-control'], 'no-store');
  assert.equal((await send(`${p.body.proposalId}/apply`, { ...approval(), operations: [] })).status, 400);
  const applied = await send(`${p.body.proposalId}/apply`, approval()); assert.equal(applied.status, 200); assert.equal(applied.body.data.techStack[0].choice, 'SQLite');
  assert.equal((await send(`${p.body.proposalId}/apply`, approval())).headers['idempotency-replayed'], 'true');
  const next = { ...stackRequest(2), instruction: 'Remove Cache.' }; const nextEngine = engine(async () => ({ operations: [stackRemove('Cache')] }));
  // Rejection consumes the persisted proposal; it does not call either provider.
  const second = await preview(nextEngine, randomUUID(), next);
  const rejected = await send(`${second.response.proposalId}/reject`, { rejected: true, expectedBaseRevision: 2 });
  assert.equal(rejected.status, 200); assert.equal(rejected.body.status, 'rejected'); assert.equal(db.maps.get(mapA).current_revision, 2); assertReleased();
});

const modelEntity = (id, name = id, fields = [{ name: 'id', type: 'uuid' }]) => ({ id, name, fields });
const modelUp = value => ({ op: 'upsert_item', collection: 'dataModel.entities', value });
const modelRemove = key => ({ op: 'remove_item', collection: 'dataModel.entities', key });
const modelRelations = value => ({ op: 'replace_list', path: 'dataModel.relations', value });
const databaseRequest = (revision = 1, target = null) => ({ instruction: 'Add email to User, remove Post and add Comment.',
  context: { activeView: 'database', selectedTarget: target }, expectedBaseRevision: revision });
function databaseFixture() {
  techStackFixture();
  const dataModel = { entities: [{ ...modelEntity('user'), extension: 17, fields: [{ name: 'id', type: 'uuid', extension: 17 }] },
    modelEntity('post'), modelEntity('tag')], relations: [{ from: 'user', to: 'post', type: 'one-to-many', label: null, extension: 17 },
    { from: 'post', to: 'tag', type: 'many-to-many' }], extension: 17 };
  for (const row of db.maps.values()) row.data.dataModel = copy(dataModel);
  for (const row of db.history) row.data.dataModel = copy(dataModel);
}
const databaseOutput = () => ({ operations: [modelUp(modelEntity('user', 'User', [{ name: 'id', type: 'string' }, { name: 'email', type: 'string' }])),
  modelRemove('post'), modelUp(modelEntity('comment'))] });

test('S4H Database Preview/Apply provides complete field/cascade differences and updates only dataModel in one shared revision', async t => {
  databaseFixture(); const before = copy(db.maps), artifacts = copy(db.artifacts), { e } = allowance(t, async () => databaseOutput());
  const key = randomUUID(), p = await preview(e, key, databaseRequest());
  assert.deepEqual(db.maps, before); assert.equal(db.history.length, 2); assert.equal(db.usage.length, 1);
  assert.deepEqual(p.response.context, databaseRequest().context); assert.deepEqual(p.response.affectedSections, ['dataModel']);
  assert.deepEqual(p.response.operations.at(-1), modelRelations([])); assert.equal(p.response.diff.dataModel.relations.removed.length, 2);
  const changed = p.response.diff.dataModel.entities.changed[0]; assert.deepEqual(changed.changedFields, ['name', 'fields']);
  assert.deepEqual(changed.before.fields, [{ name: 'id', type: 'uuid', extension: 17 }]);
  assert.deepEqual(changed.after.fields, [{ name: 'id', type: 'string', extension: 17 }, { name: 'email', type: 'string' }]);
  assert.equal(p.response.warnings[0].code, 'database_model_only');
  await rejects(() => preview(e, key, { ...databaseRequest(), instruction: 'Different' }), 'idempotency_key_reused');
  assert.deepEqual((await preview(e, key, databaseRequest())).response, p.response);
  const result = await apply(e, p); assert.equal(result.response.revision, 2); assert.equal(result.response.version, 2);
  const restored = copy(result.response.data); restored.dataModel = before.get(mapA).data.dataModel; assert.deepEqual(restored, before.get(mapA).data);
  assert.equal(result.response.data.dataModel.entities[0].extension, 17); assert.equal(result.response.data.dataModel.extension, 17);
  assert.deepEqual(db.maps.get(mapB), before.get(mapB)); assert.deepEqual(db.artifacts, artifacts);
  assert.equal(db.maps.get(mapA).anon_id, before.get(mapA).anon_id); assert.equal(db.maps.get(mapA).input_description, before.get(mapA).input_description);
  assert.deepEqual(db.maps.get(mapA).created_at, before.get(mapA).created_at); assert.equal(db.history.length, 3);
  assert.deepEqual(db.history.at(-1).data, result.response.data); assert.equal(db.history.at(-1).change_metadata.validationPolicy.scope, 'database');
  assert.equal(db.history.at(-1).patch, null); assert.equal((await apply(e, p)).replayed, true); assert.equal(db.modelCalls, 1); assert.equal(db.usage.length, 1);
  assert.ok(db.queries.some(sql => sql.startsWith('/* changes:update-map */') && sql.includes("'{dataModel}'"))); assertReleased();
});

test('S4H Database relationship-only edits and selected entity field edits revalidate and apply through the same handler', async () => {
  databaseFixture(); const e = engine(async () => ({ operations: [modelRelations([
    { from: 'user', to: 'post', type: 'one-to-one' }, { from: 'post', to: 'tag', type: 'many-to-many' }])] }));
  const p = await preview(e, randomUUID(), databaseRequest()); assert.equal(p.response.diff.dataModel.entities.changed.length, 0);
  assert.equal(p.response.diff.dataModel.relations.added[0].type, 'one-to-one');
  const applied = await apply(e, p); assert.deepEqual(applied.response.data.dataModel.relations[0], { from: 'user', to: 'post', type: 'one-to-one', label: null, extension: 17 });
  const next = engine(async () => ({ operations: [modelUp(modelEntity('user', 'Account', []))] }));
  const selected = await preview(next, randomUUID(), databaseRequest(2, { kind: 'entity', id: 'user' }));
  assert.equal((await apply(next, selected, approval(2))).response.revision, 3); assert.equal(db.history.length, 4); assertReleased();
});

test('S4H Database ambiguous identities/references and invalid scope fail before admission or provider work', async t => {
  for (const kind of ['duplicate entity', 'duplicate field', 'dangling relation', 'conflicting relation', 'missing target', 'wrong target', 'owner', 'revision']) await t.test(kind, async () => {
    databaseFixture(); const input = databaseRequest(); let who = actor, code = 'change_not_valid';
    if (kind === 'duplicate entity') db.maps.get(mapA).data.dataModel.entities.push(modelEntity('user'));
    if (kind === 'duplicate field') db.maps.get(mapA).data.dataModel.entities[0].fields.push({ name: 'id', type: 'string' });
    if (kind === 'dangling relation') db.maps.get(mapA).data.dataModel.relations.push({ from: 'absent', to: 'user', type: 'one-to-many' });
    if (kind === 'conflicting relation') db.maps.get(mapA).data.dataModel.relations.push({ from: 'user', to: 'post', type: 'one-to-one' });
    if (kind === 'missing target') { input.context.selectedTarget = { kind: 'entity', id: 'absent' }; code = 'invalid_request'; }
    if (kind === 'wrong target') { input.context.selectedTarget = { kind: 'architecture_node', id: 'api' }; code = 'unsupported_scope'; }
    if (kind === 'owner') { who = stranger; code = 'not_found'; }
    if (kind === 'revision') { input.expectedBaseRevision = 2; code = 'revision_conflict'; }
    db.history[0].data = copy(db.maps.get(mapA).data); const { e } = allowance(t, async () => databaseOutput());
    await rejects(() => preview(e, randomUUID(), input, mapA, who), code);
    assert.equal(db.modelCalls, 0); assert.equal(db.proposals.size, 0); assert.equal(db.daily.attempts.size, 0); assert.equal(db.usage.length, 0); assertReleased();
  });
});

test('S4H Database invalid/no-op/provider/selected-scope failures release daily holds exactly once', async t => {
  for (const kind of ['invalid relation', 'physical schema', 'no-op', 'provider', 'selected scope']) await t.test(kind, async () => {
    databaseFixture(); const before = copy(db.maps.get(mapA)), { e } = allowance(t, async () => {
      if (kind === 'provider') throw new Error('Private fixture failure');
      if (kind === 'physical schema') return { operations: [modelUp({ ...modelEntity('post'), indexes: [] })] };
      if (kind === 'no-op') return { operations: [modelUp(modelEntity('post'))] };
      if (kind === 'selected scope') return { operations: [modelRemove('post')] };
      return { operations: [modelRelations([{ from: 'missing', to: 'user', type: 'one-to-many' }])] };
    });
    const input = databaseRequest(1, kind === 'selected scope' ? { kind: 'entity', id: 'user' } : null), key = randomUUID();
    const code = kind === 'provider' ? 'change_generation_failed' : kind === 'no-op' ? 'no_changes' : 'change_not_valid';
    await rejects(() => preview(e, key, input), code); await rejects(() => preview(e, key, input), code);
    assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2); assert.equal(db.usage.length, 0); assert.equal(db.modelCalls, 1);
    assert.equal([...db.daily.attempts.values()][0].state, 'failed'); assertReleased();
  });
});

test('S4H Database conflicts with every supported view and legacy iteration without overwriting newer canonical data', async t => {
  for (const scope of ['overview', 'architecture', 'tech-stack', 'iterate']) await t.test(scope, async () => {
    databaseFixture(); const e = engine(async () => databaseOutput()), p = await preview(e, randomUUID(), databaseRequest());
    if (scope === 'iterate') {
      const base = await readCanonicalBase(mapA, actor), result = legacyResult(); result.newSystem.techStack = copy(base.system.techStack); result.newSystem.dataModel = copy(base.system.dataModel);
      await commitArchitectureRevision({ mapId: mapA, anonId: actor, base, result });
    } else {
      const other = scope === 'overview' ? engine() : scope === 'architecture' ? engine(async () => ({ operations: [graphRemove('api')] })) : engine(async () => stackOutput());
      const q = await preview(other, randomUUID(), scope === 'overview' ? request() : scope === 'architecture' ? archRequest() : stackRequest()); await apply(other, q);
    }
    const before = copy(db.maps.get(mapA)); await rejects(() => apply(e, p), 'revision_conflict'); assert.deepEqual(db.maps.get(mapA), before);
    assert.equal(db.maps.get(mapA).current_revision, 2); assert.equal(db.history.length, 3); assertReleased();
  });
  databaseFixture(); const entered = deferred(), release = deferred(), e = engine(async () => { entered.resolve(); await release.promise; return databaseOutput(); });
  const pending = preview(e, randomUUID(), databaseRequest()); await entered.promise;
  const other = engine(), q = await preview(other); await apply(other, q); release.resolve(); await rejects(() => pending, 'revision_conflict'); assertReleased();
});

test('S4H Database expiry and saved proposal tampering cannot write canonical data', async t => {
  for (const kind of ['expiry', 'operation', 'diff', 'summary', 'policy', 'context']) await t.test(kind, async () => {
    databaseFixture(); const e = engine(async () => databaseOutput()), p = await preview(e, randomUUID(), databaseRequest()), saved = db.proposals.get(p.response.proposalId);
    if (kind === 'expiry') db.clock = new Date(+db.clock + 901000);
    if (kind === 'operation') saved.preview_response.operations[0].value.fields = [];
    if (kind === 'diff') saved.preview_response.diff.dataModel.relations.removed = [];
    if (kind === 'summary') saved.preview_response.summary = 'Wrong';
    if (kind === 'policy') saved.validation_policy.scope = 'tech-stack';
    if (kind === 'context') saved.preview_response.context.selectedTarget = { kind: 'entity', id: 'user' };
    const before = copy(db.maps.get(mapA)); await rejects(() => apply(e, p), kind === 'expiry' ? 'proposal_expired' : 'proposal_obsolete');
    assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2); assertReleased();
  });
});

test('S4H Database Apply failures roll back map/history/receipt atomically; lost acknowledgement replays once', async t => {
  for (const stage of ['update-map', 'snapshot', 'applied', 'commit']) await t.test(stage, async () => {
    databaseFixture(); const { e } = allowance(t, async () => databaseOutput()), p = await preview(e, randomUUID(), databaseRequest()), before = copy(db.maps.get(mapA));
    db.failAt = stage; await assert.rejects(() => apply(e, p)); assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2);
    assert.equal(db.proposals.get(p.response.proposalId).state, 'ready'); assert.equal(db.usage.length, 1); assertReleased();
  });
  databaseFixture(); const e = engine(async () => databaseOutput()), p = await preview(e, randomUUID(), databaseRequest()); db.uncertainCommit = true;
  await assert.rejects(() => apply(e, p)); const replay = await apply(e, p); assert.equal(replay.replayed, true); assert.equal(replay.response.revision, 2);
  assert.equal(db.history.length, 3); assert.equal(db.modelCalls, 1); assertReleased();
});

test('S4H Database rejection and concurrent Apply preserve shared terminal state and immutable receipts', async t => {
  databaseFixture(); const { e } = allowance(t, async () => databaseOutput()), key = randomUUID(), p = await preview(e, key, databaseRequest());
  const before = copy(db.maps.get(mapA)), body = { rejected: true, expectedBaseRevision: 1 };
  const rejected = await e.reject(mapA, actor, p.response.proposalId, body); assert.equal(rejected.response.status, 'rejected');
  assert.deepEqual((await e.reject(mapA, actor, p.response.proposalId, body)).response, rejected.response);
  await rejects(() => apply(e, p), 'proposal_rejected'); assert.deepEqual(db.maps.get(mapA), before); assert.equal(db.history.length, 2); assert.equal(db.usage.length, 1);
  assert.deepEqual((await preview(e, key, databaseRequest())).response, p.response);
  databaseFixture(); const race = engine(async () => databaseOutput()), q = await preview(race, randomUUID(), databaseRequest());
  const results = await Promise.all([apply(race, q), apply(race, q)]); assert.equal(results.filter(value => value.replayed).length, 1); assert.equal(db.history.length, 3);
  databaseFixture(); const opposite = engine(async () => databaseOutput()), r = await preview(opposite, randomUUID(), databaseRequest());
  const outcome = await Promise.allSettled([apply(opposite, r), opposite.reject(mapA, actor, r.response.proposalId, body)]);
  assert.equal(outcome.filter(value => value.status === 'fulfilled').length, 1); assert.equal(db.history.length, 3); assertReleased();
});

test('S4H Database shares the last daily unit with Tech Stack and never duplicates same-key generation', async t => {
  databaseFixture(); db.usage.push({ actorId: actor, mapId: mapA, createdAt: db.clock }); const entered = deferred(), release = deferred();
  const { e } = allowance(t, async () => { entered.resolve(); await release.promise; return databaseOutput(); });
  const key = randomUUID(), pending = preview(e, key, databaseRequest()); await entered.promise;
  await rejects(() => preview(e, key, databaseRequest()), 'preview_in_progress'); await rejects(() => preview(e, randomUUID(), stackRequest()), 'daily_limit_exceeded');
  release.resolve(); await pending; assert.equal(db.modelCalls, 1); assert.equal(db.usage.length, 2); assertReleased();
});

test('S4H Database default factory selects structured provider and existing accounting without enabling the feature', async t => {
  databaseFixture(); process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true'; t.after(() => delete process.env.MAPPR_DAILY_ADMISSION_ENABLED);
  const { createChangeEngine } = await import('../../src/services/changes/engine.ts'), e = createChangeEngine({ connect: () => db.connect() });
  providerHook = async config => { assert.equal(config.groqSchemaName, 'database_change'); assert.match(config.buildPrompt(), /canonical database model/);
    return { operations: [modelUp(modelEntity('user', 'Account', []))] }; };
  try {
    const p = await preview(e, randomUUID(), databaseRequest(1, { kind: 'entity', id: 'user' })), saved = db.proposals.get(p.response.proposalId);
    assert.equal(saved.generator_id, 'database-operations:shared-ai-v1'); assert.equal(saved.request_payload.context.activeView, 'database');
    assert.equal([...db.daily.attempts.values()][0].operation, 'overview_preview'); assert.equal(db.usage.length, 1);
  } finally { providerHook = undefined; }
  process.env.MAPPR_CHANGES_ENABLED = 'true'; t.after(() => delete process.env.MAPPR_CHANGES_ENABLED);
  assert.throws(assertChangesAvailable, error => error.code === 'preview_policy_not_configured'); assertReleased();
});

test('S4H Database HTTP preview/Apply/rejection keep exact requests, owner guards and replay metadata', async t => {
  databaseFixture(); const e = engine(async () => databaseOutput());
  const server = createApp({ changesRouter: createChangesRouter({ engine: e, assertAvailable: () => {} }) }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  async function send(suffix, body, who = actor) {
    const text = JSON.stringify(body), cookie = `mappr_anon=${who}.${createHmac('sha256', process.env.COOKIE_SECRET).update(who).digest('hex')}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/maps/${mapA}/changes/${suffix}`, method: 'POST',
        headers: { Origin: process.env.FRONTEND_ORIGIN, Cookie: cookie, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => {
        const parts = []; res.on('data', part => parts.push(part)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString()) }));
      }); req.setTimeout(5000, () => req.destroy(new Error('Local fixture HTTP timeout'))); req.on('error', reject); req.end(text);
    });
  }
  assert.equal((await send('preview', databaseRequest(), stranger)).status, 404); assert.equal(db.modelCalls, 0);
  const p = await send('preview', databaseRequest()); assert.equal(p.status, 201); assert.deepEqual(p.body.affectedSections, ['dataModel']); assert.equal(p.headers['cache-control'], 'no-store');
  assert.equal((await send(`${p.body.proposalId}/apply`, { ...approval(), dataModel: {} })).status, 400);
  const applied = await send(`${p.body.proposalId}/apply`, approval()); assert.equal(applied.status, 200); assert.equal(applied.body.data.dataModel.entities[0].name, 'User');
  assert.equal((await send(`${p.body.proposalId}/apply`, approval())).headers['idempotency-replayed'], 'true');
  const rejectEngine = engine(async () => ({ operations: [modelRemove('comment')] }));
  const q = await preview(rejectEngine, randomUUID(), databaseRequest(2));
  const rejected = await send(`${q.response.proposalId}/reject`, { rejected: true, expectedBaseRevision: 2 });
  assert.equal(rejected.status, 200); assert.equal(rejected.body.status, 'rejected'); assert.equal(db.maps.get(mapA).current_revision, 2); assertReleased();
});

test('local browser mode uses real cookie/owner/origin, revision and quota paths and creates only explicit synthetic fixtures', async t => {
  db = new Database(); const originalMaps = copy(db.maps), savedEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key]; Object.assign(process.env, savedEnv); });
  Object.assign(process.env, { NODE_ENV: 'development', PORT: '4000', FRONTEND_ORIGIN: 'http://localhost:3000',
    MAPPR_LOCAL_CHANGES_TESTING: 'true', MAPPR_CHANGES_ENABLED: 'true', MAPPR_DAILY_ADMISSION_ENABLED: 'true', MAPPR_REVISION_WRITES_ENABLED: 'true' });
  const { e } = allowance(t, async (_base, _instruction, _signal, context) => context.activeView === 'overview'
    ? { summary: 'Updated synthetic browser fixture.' } : { operations: [graphUpsert(graphNode('api', 'Updated API'))] });
  const server = createApp({ changesRouter: createChangesRouter({ engine: e }) }).listen(4000, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  async function send(method, path, body, cookie, extra = {}) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: 4000, method, path, headers: { Host: 'localhost:4000', Origin: process.env.FRONTEND_ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}), ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}), ...extra } }, res => {
        const parts = []; res.on('data', data => parts.push(data)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString()) }));
      }); req.setTimeout(5000, () => req.destroy(new Error('Local fixture HTTP timeout'))); req.on('error', reject); req.end(text);
    });
  }
  const health = await send('GET', '/health'); assert.equal(health.status, 200); const setCookie = health.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.doesNotMatch(setCookie, /; Secure/);
  const cookie = setCookie.split(';')[0]; assert.deepEqual(db.maps, originalMaps); assert.equal(db.usage.length, 0);
  const key = randomUUID(), headers = { 'Idempotency-Key': key };
  assert.equal((await send('POST', '/dev/local-test-map', { create: true }, undefined, headers)).status, 401);
  assert.equal((await send('POST', '/dev/local-test-map', { create: true }, cookie, { ...headers, Origin: 'http://untrusted.test' })).status, 403);
  assert.equal((await send('POST', '/dev/local-test-map', { create: true }, cookie, { ...headers, 'X-Forwarded-For': '127.0.0.1' })).status, 503);
  assert.equal((await send('POST', '/dev/local-test-map', { create: true, data: {} }, cookie, headers)).status, 400);
  db.failAt = 'local-fixture-snapshot'; assert.equal((await send('POST', '/dev/local-test-map', { create: true }, cookie, headers)).status, 503);
  assert.deepEqual(db.maps, originalMaps); assert.equal(db.history.length, 2);
  const created = await send('POST', '/dev/local-test-map', { create: true }, cookie, headers);
  assert.equal(created.status, 201); assert.equal(created.body.revision, 1); assert.equal(created.body.disposable, true); assert.equal(db.usage.length, 0);
  assert.equal(created.headers['access-control-allow-origin'], 'http://localhost:3000'); assert.equal(created.headers['access-control-allow-credentials'], 'true');
  const replay = await send('POST', '/dev/local-test-map', { create: true }, cookie, headers);
  assert.equal(replay.status, 200); assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.equal(db.maps.size, 3); assert.equal(db.history.length, 3);
  assert.equal((await send('POST', '/dev/local-test-map', { create: true }, cookie, { 'Idempotency-Key': mapA })).status, 404);
  const mapId = created.body.mapId, path = `/maps/${mapId}/changes`;
  assert.equal((await send('POST', `${path}/preview`, request(), undefined, { 'Idempotency-Key': randomUUID() })).status, 401);
  process.env.NODE_ENV = 'production'; const blocked = await send('POST', `${path}/preview`, request(), cookie, { 'Idempotency-Key': randomUUID() });
  assert.equal(blocked.status, 503); assert.equal(blocked.body.error, 'preview_policy_not_configured'); assert.equal(db.modelCalls, 0); process.env.NODE_ENV = 'development';
  const p = await send('POST', `${path}/preview`, request(), cookie, { 'Idempotency-Key': randomUUID() }); assert.equal(p.status, 201); assert.equal(db.usage.length, 1);
  const result = await send('POST', `${path}/${p.body.proposalId}/apply`, approval(), cookie); assert.equal(result.status, 200); assert.equal(result.body.revision, 2);
  const architecture = await send('POST', `${path}/preview`, archRequest(2), cookie, { 'Idempotency-Key': randomUUID() }); assert.equal(architecture.status, 201);
  const denied = await send('POST', `${path}/preview`, stackRequest(2), cookie, { 'Idempotency-Key': randomUUID() });
  assert.equal(denied.status, 429); assert.equal(denied.body.error, 'daily_limit_exceeded'); assert.equal(db.modelCalls, 2);
  assert.equal((await send('POST', `${path}/${architecture.body.proposalId}/reject`, { rejected: true, expectedBaseRevision: 2 }, cookie)).status, 200);
  assert.equal(db.usage.length, 2); for (const [id, map] of originalMaps) assert.deepEqual(db.maps.get(id), map); assertReleased();
});
