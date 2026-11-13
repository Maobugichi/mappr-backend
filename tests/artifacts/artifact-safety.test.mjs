import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import test, { mock } from 'node:test';
import { DailyFixture } from '../fixtures/daily-admission.mjs';

process.env.DATABASE_URL = 'mock-only-never-connect';
process.env.COOKIE_SECRET = 's5a-offline-fixture-secret';
process.env.FRONTEND_ORIGIN = 'https://frontend.mappr.test';
process.env.NODE_ENV = 'test';
process.env.MAPPR_REVISION_WRITES_ENABLED = 'true';
delete process.env.MAPPR_CHANGES_ENABLED; delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
delete process.env.MAPPR_DAILY_ADMISSION_ENABLED;
const copy = x => structuredClone(x);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const owner = randomUUID(), other = randomUUID(), mapId = randomUUID();
const system = { meta: { productName: 'Original fixture', oneLineSummary: 'Fixture tagline' }, product: { summary: 'Original summary', concepts: [] },
  users: [], features: [], techStack: [], architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [] };
let db;
const jsonFields = new Set(['endpoints','tables','collections','adrs','vars','findings','links','getting_started','components','environments','cicd_steps']);
const tables = { api_contract: 'api_contracts', relational_schema: 'relational_schemas', document_schema: 'document_schemas',
  readme: 'readmes', adrs: 'adrs', env_vars: 'env_vars', deployment: 'deployments', critique: 'architecture_reviews', requirements: 'missing_requirement_reviews', traceability: 'traceability_reviews' };
const kindFor = table => Object.keys(tables).find(kind => tables[kind] === table);

// SQL-boundary simulator with transaction-local writes, map locks and frozen
// repeatable-read snapshots. No PostgreSQL connection or provider is possible.
class Database {
  constructor() {
    this.time = Date.parse('2026-11-10T15:00:00Z');
    this.map = { id: mapId, anon_id: owner, data: copy(system), current_revision: 1,
      input_description: 'Keep input', created_at: new Date(this.time), updated_at: new Date(this.time) };
    this.history = [{ version: 1, data: copy(system) }]; this.records = new Map(); this.generations = new Map(); this.usage = [];
    this.clients = new Set(); this.lockOwner = null; this.waiters = []; this.queries = []; this.modelCalls = []; this.quotaCalls = 0;
    this.failAt = null; this.uncertainCommit = false; this.provenanceSchema = true; this.onRows = null;
    this.daily = new DailyFixture(this);
  }
  now() { return new Date(++this.time); }
  state() { return copy({ map: this.map, history: this.history, records: this.records, generations: this.generations, usage: this.usage }); }
  change(edit) { edit(this.map.data); this.map.current_revision++; this.map.updated_at = this.now(); this.history.push({ version: this.map.current_revision, data: copy(this.map.data) }); }
  async connect() {
    const tx = { rows: new Map(), generations: new Map(), usage: [], locked: false, snapshot: null, open: false };
    this.clients.add(tx); return { query: (sql, args) => this.query(sql, args, tx), release: () => this.clients.delete(tx) };
  }
  async lock(tx) { while (this.lockOwner && this.lockOwner !== tx) await new Promise(resolve => this.waiters.push(resolve)); this.lockOwner = tx; tx.locked = true; }
  unlock(tx) { if (tx.locked) { tx.locked = false; this.lockOwner = null; this.waiters.splice(0).forEach(done => done()); } }
  checkpoint(stage) { if (this.failAt === stage) { this.failAt = null; throw new Error('private-sentinel simulated SQL failure'); } }
  rows(tx) { return new Map([...(tx?.snapshot?.records ?? this.records), ...(tx?.rows ?? [])]); }
  generationsFor(tx) { return new Map([...(tx?.snapshot?.generations ?? this.generations), ...(tx?.generations ?? [])]); }
  seed(kind, payload = {}) {
    const row = { id: randomUUID(), map_id: mapId, created_at: this.now().toISOString(), updated_at: this.now().toISOString(), generation_id: null, ...copy(payload) };
    const key = ['api_contract','relational_schema','document_schema','readme'].includes(kind) ? { version: this.map.current_revision }
      : ['adrs','env_vars','deployment'].includes(kind) ? { tech_arch_hash: legacyTechArchHash(this.map.data) } : {};
    Object.assign(row, key); this.records.set(row.id, { kind, row }); return row;
  }
  async query(text, args = [], tx) {
    const sql = text.replace(/\s+/g, ' ').trim(); this.queries.push(sql);
    const result = rows => ({ rows: copy(rows), rowCount: rows.length });
    if (sql.startsWith('BEGIN')) { tx.open = true; this.daily.begin(tx); if (sql.includes('REPEATABLE READ')) tx.snapshot = this.state(); return result([]); }
    if (sql.startsWith('SET ')) return result([]);
    if (sql === 'ROLLBACK') { tx.open = false; this.daily.rollback(tx); this.unlock(tx); return result([]); }
    if (sql === 'COMMIT') {
      this.checkpoint('commit'); this.daily.commit(tx); for (const [id, row] of tx.rows) this.records.set(id, copy(row));
      for (const [id, generation] of tx.generations) this.generations.set(id, copy(generation)); this.usage.push(...copy(tx.usage));
      tx.open = false; this.unlock(tx); if (this.uncertainCommit) { this.uncertainCommit = false; throw new Error('private-sentinel lost acknowledgement'); } return result([]);
    }
    const daily = await this.daily.query(sql, args, tx); if (daily) return daily;
    if (sql === 'SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2') return result(this.map.id === args[0] && this.map.anon_id === args[1] ? [{}] : []);
    if (sql.startsWith('/* artifacts:lock */')) { await this.lock(tx); return result(args[0] === mapId ? [{ id: mapId, anon_id: this.map.anon_id }] : []); }
    if (sql.startsWith('SELECT m.id, m.anon_id')) {
      const state = tx?.snapshot ?? this; if (args[0] !== mapId) return result([]);
      return result([{ ...state.map, minimum_revision: state.history[0].version, maximum_revision: state.history.at(-1).version,
        snapshot_count: state.history.length, snapshot_matches: isDeepStrictEqual(state.history.at(-1).data, state.map.data) }]);
    }
    if (sql.startsWith('/* artifacts:inputs:')) {
      const kind = sql.match(/inputs:(\w+)/)[1], data = args.length > 1 ? JSON.parse(args[1]) : (tx?.snapshot?.map ?? this.map).data;
      const inputs = ['relational_schema','document_schema'].includes(kind) ? data.dataModel
        : ['adrs','env_vars','deployment'].includes(kind) ? { techStack: data.techStack, architecture: data.architecture } : data;
      return result([{ input_text: JSON.stringify(inputs) }]);
    }
    if (sql.startsWith('/* artifacts:rows:')) {
      if (!this.provenanceSchema) throw Object.assign(new Error('private-sentinel missing provenance'), { code: '42703' });
      const kind = args[1]; if (this.onRows) await this.onRows(kind, tx);
      const generations = this.generationsFor(tx);
      return result([...this.rows(tx).values()].filter(entry => entry.kind === kind && entry.row.map_id === args[0]).map(({ row }) => {
        const { generation_id, ...record } = row; return { record, payload_text: JSON.stringify(record), generation_id,
          provenance: generations.get(generation_id) ?? null };
      }).sort((a, b) => String(b.provenance?.published_at ?? b.record.updated_at).localeCompare(String(a.provenance?.published_at ?? a.record.updated_at)) || b.record.id.localeCompare(a.record.id)));
    }
    if (sql.startsWith('/* artifacts:lock-rows:')) { assert.equal(tx.locked, true); return result([]); }
    if (sql.startsWith('/* artifacts:save:')) {
      assert.equal(tx.locked, true); this.checkpoint('provenance');
      const [id, artifact_type, storage_key, origin, source_revision, input_fingerprint, generator_version, dependency_policy, payload_fingerprint, parent_id, rowId] = args;
      const row = this.rows(tx).get(rowId).row; const { generation_id: unused, ...payload } = row;
      assert.equal(this.generationsFor(tx).has(id), false);
      tx.generations.set(id, { id, map_id: row.map_id, artifact_type, storage_key, origin, source_revision, input_fingerprint, generator_version,
        dependency_policy, payload_fingerprint, parent_id, payload: copy(payload), published_at: this.now().toISOString() }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('/* artifacts:attach:')) {
      this.checkpoint('attach'); const entry = copy(this.rows(tx).get(args[0])); entry.row.generation_id = args[1]; tx.rows.set(args[0], entry); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO generations ')) { this.checkpoint('usage'); tx.usage.push({ owner: args[0], map: args[1] }); return { rows: [], rowCount: 1 }; }
    const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES/);
    if (insert && kindFor(insert[1])) {
      this.checkpoint('artifact'); assert.equal(tx.locked, true);
      const kind = kindFor(insert[1]), columns = insert[2].split(',').map(s => s.trim()), values = Object.fromEntries(columns.map((c, i) => [c, jsonFields.has(c) ? JSON.parse(args[i]) : args[i]]));
      const old = [...this.rows(tx).values()].find(e => e.kind === kind && e.row.map_id === values.map_id &&
        (values.version !== undefined ? e.row.version === values.version : values.tech_arch_hash !== undefined ? e.row.tech_arch_hash === values.tech_arch_hash : true));
      const row = { ...(old?.row ?? { id: randomUUID(), created_at: this.now().toISOString(), generation_id: null }), ...values, updated_at: this.now().toISOString() };
      tx.rows.set(row.id, { kind, row }); return result([{ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) }]);
    }
    const edit = sql.match(/^UPDATE (architecture_reviews|missing_requirement_reviews)/);
    if (edit) {
      assert.equal(tx.locked, true); const entry = [...this.rows(tx).values()].find(e => e.kind === kindFor(edit[1]) && e.row.map_id === args[0]);
      if (!entry) return result([]); const row = copy(entry.row);
      row.findings = row.findings.map(f => f.id === args[2] ? { ...f, dismissed: args[1] } : f); row.updated_at = this.now().toISOString();
      tx.rows.set(row.id, { kind: entry.kind, row }); return result([{ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) }]);
    }
    throw new Error('Unexpected statement in isolated S5 mock');
  }
}
db = new Database();
mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real PostgreSQL forbidden'); } } } });
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: { pool: { query: (...a) => db.query(...a), connect: () => db.connect() } } });
let modelHook;
class AIGenerationError extends Error {}
mock.module(new URL('../../src/services/aiClient.ts', import.meta.url).href, { namedExports: { AIGenerationError, generateStructured: async config => {
  db.modelCalls.push(config.groqSchemaName); if (modelHook) await modelHook(config);
  const outputs = { api_contract: { endpoints: [] }, relational_schema: { tables: [] }, document_schema: { collections: [] }, adr_set: { adrs: [] },
    env_vars: { vars: [] }, deployment_runbook: { components: [], environments: [], cicdSteps: [], migrations: null },
    readme: { overview: 'Saved fixture overview', gettingStarted: [] }, architecture_review: { findings: [] }, requirements_review: { findings: [] }, traceability: { links: [] } };
  assert.ok(outputs[config.groqSchemaName]); return copy(outputs[config.groqSchemaName]);
} } });
mock.module(new URL('../../src/services/rateLimit.ts', import.meta.url).href, { namedExports: { FREE_DAILY_LIMIT: 2, GLOBAL_DAILY_CEILING: 200, checkRateLimits: async () => { db.quotaCalls++; return { allowed: true }; } } });
const { captureArtifactSource, publishArtifact, editReviewArtifact, withArtifactSnapshot, resolveArtifact, freshness, artifactInventory } = await import('../../src/services/artifacts/provenance.ts');
const { ARTIFACTS, ARTIFACT_POLICY, artifactTypes, legacyTechArchHash, digest, inputFingerprint } = await import('../../src/services/artifacts/registry.ts');
const { ARTIFACT_EXPORTS } = await import('../../src/middleware/artifactReads.ts');
const { conservativeArtifacts } = await import('../../src/services/changes/artifacts.ts');
const { assertChangesAvailable } = await import('../../src/services/changes/availability.ts');
const { createApp } = await import('../../src/app.ts');
const { DailyAdmission } = await import('../../src/services/dailyAdmission.ts');
const reset = () => { db = new Database(); modelHook = null; };
const clean = () => { assert.equal(db.clients.size, 0); assert.equal(db.lockOwner, null); };
const failure = (work, code) => assert.rejects(work, e => e.code === code);
const payload = kind => ({ api_contract: { endpoints: [] }, relational_schema: { tables: [] }, document_schema: { collections: [] }, readme: { overview: 'Overview', getting_started: [] },
  adrs: { adrs: [] }, env_vars: { vars: [] }, deployment: { components: [], environments: [], cicd_steps: [], migrations: null }, critique: { findings: [] }, requirements: { findings: [] }, traceability: { links: [] } })[kind];
function write(source, value = payload(source.kind)) {
  return async client => {
    const values = { map_id: mapId, ...(ARTIFACTS[source.kind].key === 'version' ? { version: source.revision }
      : ARTIFACTS[source.kind].key === 'hash' ? { tech_arch_hash: source.key } : {}), ...value };
    const columns = Object.keys(values), args = columns.map(c => jsonFields.has(c) ? JSON.stringify(values[c]) : values[c]);
    const result = await client.query(`INSERT INTO ${tables[source.kind]} (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, args);
    await client.query('INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)', [owner, mapId]); return result.rows[0];
  };
}
async function generate(kind, value) { const source = await captureArtifactSource(mapId, owner, kind); await publishArtifact(source, owner, write(source, value)); return source; }
const resolve = kind => withArtifactSnapshot(mapId, (client, ctx) => resolveArtifact(client, mapId, kind, ctx));

test('all ten types preserve legacy rows and gain explicit source/payload provenance on new publication', async t => {
  for (const kind of artifactTypes) await t.test(kind, async () => {
    reset(); const legacy = db.seed(kind, payload(kind)), original = copy(legacy), oldHistory = copy(db.history), oldMap = copy(db.map);
    const missingSource = await resolve(kind); assert.equal(missingSource.metadata.status, 'stale'); assert.equal(missingSource.metadata.reason, 'provenance_unknown');
    const source = await generate(kind); const fresh = await resolve(kind);
    assert.equal(fresh.metadata.status, 'fresh'); assert.equal(fresh.metadata.sourceRevision, 1); assert.equal(fresh.metadata.generationId, source.generationId);
    assert.equal(db.generations.size, 2); const archive = [...db.generations.values()].find(g => g.origin === 'legacy');
    const { generation_id: unused, ...oldPayload } = original; assert.deepEqual(archive.payload, oldPayload); assert.equal(archive.source_revision, null);
    assert.deepEqual(db.map, oldMap); assert.deepEqual(db.history, oldHistory); assert.equal(db.usage.length, 1); clean();
  });
});

test('source/dependency changes during pending generation reject unsafe publication, preserving old records/usage', async t => {
  for (const [kind, edit] of [['readme', data => data.product.summary = 'Changed'], ['api_contract', data => data.features.push({ id: 'x', name: 'x', description: 'x', relatedUsers: [], dependsOn: [] })],
    ['relational_schema', data => data.dataModel.entities.push({ id: 'e', name: 'Entity', fields: [] })], ['document_schema', data => data.dataModel.relations.push({ from: 'e', to: 'e', type: 'one-to-one' })],
    ['adrs', data => data.architecture.nodes.push({ id: 'api', label: 'API', type: 'service', description: 'API' })], ['env_vars', data => data.techStack.push({ category: 'DB', choice: 'PG', rationale: 'Fixture' })],
    ['deployment', data => data.architecture.edges.push({ from: 'a', to: 'b' })]]) await t.test(kind, async () => {
    reset(); db.seed(kind, payload(kind)); const source = await captureArtifactSource(mapId, owner, kind); clean();
    const original = copy(db.records); db.change(edit);
    await failure(() => publishArtifact(source, owner, write(source)), 'artifact_source_changed');
    assert.deepEqual(db.records, original); assert.equal(db.generations.size, 0); assert.equal(db.usage.length, 0); clean();
  });
  reset(); const captured = await captureArtifactSource(mapId, owner, 'adrs'); db.map.anon_id = other;
  await failure(() => publishArtifact(captured, owner, write(captured)), 'not_found');
  assert.equal(db.records.size, 0); assert.equal(db.usage.length, 0); clean();
});

test('selective artifacts survive unrelated revisions, but relevant changes and generator/payload drift are stale', async () => {
  reset(); const schema = await captureArtifactSource(mapId, owner, 'relational_schema'); db.change(data => data.product.summary = 'New summary');
  await publishArtifact(schema, owner, write(schema)); const kept = await resolve('relational_schema');
  assert.equal(kept.metadata.status, 'fresh'); assert.equal(kept.metadata.sourceRevision, 1); assert.equal(kept.metadata.currentRevision, 2);
  db.change(data => data.dataModel.entities.push({ id: 'entity', name: 'Entity', fields: [] })); assert.equal((await resolve('relational_schema')).metadata.reason, 'source_changed');
  reset(); const source = await generate('env_vars'); db.change(data => data.meta.productName = 'New title');
  assert.equal((await resolve('env_vars')).metadata.status, 'fresh');
  db.generations.get(source.generationId).generator_version = 'obsolete'; assert.equal((await resolve('env_vars')).metadata.reason, 'generator_changed');
  db.generations.get(source.generationId).generator_version = 'env_vars:s5a-1'; [...db.records.values()][0].row.vars.push({ unexpected: 'outside writer' });
  assert.equal((await resolve('env_vars')).metadata.reason, 'payload_changed'); clean();
});

test('simultaneous same-slot publications have one winner; same work replay never duplicates history or usage', async () => {
  reset(); const a = await captureArtifactSource(mapId, owner, 'readme'), b = await captureArtifactSource(mapId, owner, 'readme');
  const outcomes = await Promise.allSettled([publishArtifact(a, owner, write(a)), publishArtifact(b, owner, write(b))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'artifact_publication_conflict');
  const winner = (await resolve('readme')).metadata.generationId === a.generationId ? a : b;
  const count = db.generations.size; await publishArtifact(winner, owner, async () => { throw new Error('Replay cannot write'); });
  assert.equal(db.generations.size, count); assert.equal(db.usage.length, 1); clean();
});

test('publication rollback and uncertain acknowledgement preserve atomic provenance/projection/usage', async t => {
  for (const stage of ['artifact','usage','provenance','attach','commit']) await t.test(stage, async () => {
    reset(); const source = await captureArtifactSource(mapId, owner, 'readme'); db.failAt = stage;
    await assert.rejects(() => publishArtifact(source, owner, write(source))); assert.equal(db.records.size, 0); assert.equal(db.generations.size, 0); assert.equal(db.usage.length, 0); clean();
  });
  reset(); const source = await captureArtifactSource(mapId, owner, 'readme'); db.uncertainCommit = true;
  await assert.rejects(() => publishArtifact(source, owner, write(source))); assert.equal(db.usage.length, 1);
  await publishArtifact(source, owner, async () => { throw new Error('Must replay'); }); assert.equal(db.usage.length, 1); clean();
});

test('review edits preserve known source, never promote legacy/stale output, and conflict with pending regeneration', async () => {
  reset(); const finding = { id: 'finding', dismissed: false }; await generate('critique', { findings: [finding] });
  const pending = await captureArtifactSource(mapId, owner, 'critique'); db.change(data => data.product.summary = 'Changed source');
  await editReviewArtifact(mapId, owner, 'critique', async client => (await client.query('UPDATE architecture_reviews SET findings=fixture WHERE map_id=$1', [mapId, true, 'finding'])).rows[0]);
  assert.equal((await resolve('critique')).metadata.reason, 'source_changed'); assert.equal(db.usage.length, 1);
  const editGeneration = [...db.generations.values()].find(g => g.origin === 'review_edit'); assert.equal(editGeneration.source_revision, 1);
  await failure(() => publishArtifact(pending, owner, write(pending)), 'artifact_source_changed');
  reset(); db.seed('requirements', { findings: [finding] }); const capture = await captureArtifactSource(mapId, owner, 'requirements');
  await editReviewArtifact(mapId, owner, 'requirements', async client => (await client.query('UPDATE missing_requirement_reviews SET findings=fixture WHERE map_id=$1', [mapId, true, 'finding'])).rows[0]);
  assert.equal((await resolve('requirements')).metadata.reason, 'provenance_unknown'); assert.equal(db.usage.length, 0);
  await failure(() => publishArtifact(capture, owner, write(capture)), 'artifact_publication_conflict'); clean();
});

test('S4 resolver predicts selective impacts from the actual candidate and never rewrites provenance', async () => {
  reset(); await generate('readme'); await generate('relational_schema'); const before = copy(db.generations);
  const candidate = copy(system); candidate.product.summary = 'Proposed summary';
  const prediction = await withArtifactSnapshot(mapId, client => conservativeArtifacts(client, mapId, JSON.stringify(candidate), 2));
  assert.equal(prediction.artifactImpacts.find(x => x.artifactType === 'readme').action, 'invalidate');
  assert.equal(prediction.artifactImpacts.find(x => x.artifactType === 'relational_schema').action, 'retain');
  assert.equal(prediction.artifactFreshness.api_contract.status, 'missing'); assert.deepEqual(db.generations, before);
  assert.throws(assertChangesAvailable, e => e.code === 'feature_disabled'); clean();
});

test('S4F actual Architecture candidate invalidates full/tech-architecture artifacts and retains unchanged database schemas',async()=>{
 reset();for(const kind of Object.keys(tables))await generate(kind);
 const {architectureCandidate}=await import('../../src/services/changes/architecture.ts');
 const candidate=architectureCandidate(system,{operations:[{op:'upsert_item',collection:'architecture.nodes',value:{id:'api',label:'API',type:'service',description:'API service'}}]},
  {activeView:'architecture',selectedTarget:null}).candidate;
 const records=copy(db.records),generations=copy(db.generations),usage=copy(db.usage);
 const predicted=await withArtifactSnapshot(mapId,client=>conservativeArtifacts(client,mapId,JSON.stringify(candidate),2));
 for(const impact of predicted.artifactImpacts)assert.equal(impact.action,['relational_schema','document_schema'].includes(impact.artifactType)?'retain':'invalidate',impact.artifactType);
 db.change(data=>{data.architecture=candidate.architecture});
 for(const kind of Object.keys(tables))assert.equal((await resolve(kind)).metadata.status,['relational_schema','document_schema'].includes(kind)?'fresh':'stale',kind);
 assert.deepEqual(db.records,records);assert.deepEqual(db.generations,generations);assert.deepEqual(db.usage,usage);clean();
});

test('S4G Tech Stack replacement/removal invalidates dependent artifacts without rewriting references, payloads or provenance', async () => {
  reset(); db.change(data => { data.techStack = [
    { category: 'Database', choice: 'PostgreSQL', rationale: 'Relational persistence' },
    { category: 'Frontend', choice: 'React', rationale: 'UI components' },
  ]; });
  for (const kind of artifactTypes) await generate(kind);
  const { techStackCandidate } = await import('../../src/services/changes/techStack.ts');
  const candidate = techStackCandidate(db.map.data, { operations: [
    { op: 'upsert_item', collection: 'techStack', value: { category: 'Database', choice: 'SQLite', rationale: 'Embedded persistence' } },
    { op: 'remove_item', collection: 'techStack', key: 'Frontend' },
  ] }, { activeView: 'tech-stack', selectedTarget: null }).candidate;
  const records = copy(db.records), generations = copy(db.generations), usage = copy(db.usage);
  const predicted = await withArtifactSnapshot(mapId, client => conservativeArtifacts(client, mapId, JSON.stringify(candidate), 3));
  for (const impact of predicted.artifactImpacts) assert.equal(impact.action,
    ['relational_schema', 'document_schema'].includes(impact.artifactType) ? 'retain' : 'invalidate', impact.artifactType);
  db.change(data => { data.techStack = candidate.techStack; });
  for (const kind of artifactTypes) assert.equal((await resolve(kind)).metadata.status,
    ['relational_schema', 'document_schema'].includes(kind) ? 'fresh' : 'stale', kind);
  assert.deepEqual(db.records, records); assert.deepEqual(db.generations, generations); assert.deepEqual(db.usage, usage); clean();
});

test('S4H canonical Database edits invalidate generated schemas and full-system artifacts while preserving tech-architecture provenance', async () => {
  reset(); db.change(data => { data.dataModel = { entities: [{ id: 'user', name: 'User', fields: [{ name: 'id', type: 'uuid' }] }], relations: [] }; });
  for (const kind of artifactTypes) await generate(kind);
  const { databaseCandidate } = await import('../../src/services/changes/database.ts');
  const candidate = databaseCandidate(db.map.data, { operations: [{ op: 'upsert_item', collection: 'dataModel.entities', value: {
    id: 'user', name: 'User', fields: [{ name: 'id', type: 'uuid' }, { name: 'email', type: 'string' }] } }] }, { activeView: 'database', selectedTarget: null }).candidate;
  const records = copy(db.records), generations = copy(db.generations), usage = copy(db.usage), retained = ['adrs', 'env_vars', 'deployment'];
  const predicted = await withArtifactSnapshot(mapId, client => conservativeArtifacts(client, mapId, JSON.stringify(candidate), 3));
  for (const impact of predicted.artifactImpacts) assert.equal(impact.action, retained.includes(impact.artifactType) ? 'retain' : 'invalidate', impact.artifactType);
  db.change(data => { data.dataModel = candidate.dataModel; });
  for (const kind of artifactTypes) assert.equal((await resolve(kind)).metadata.status, retained.includes(kind) ? 'fresh' : 'stale', kind);
  assert.deepEqual(db.records, records); assert.deepEqual(db.generations, generations); assert.deepEqual(db.usage, usage); clean();
});

test('HTTP tracked/legacy reads, owner inspection, all six export protections and real route publication', async t => {
  reset(); const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const cookie = id => `mappr_anon=${id}.${createHmac('sha256', process.env.COOKIE_SECRET).update(id).digest('hex')}`;
  async function request(method, path, { actor, body } = {}) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Origin: process.env.FRONTEND_ORIGIN,
        ...(actor ? { Cookie: cookie(actor) } : {}), ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) } }, res => {
        const parts = []; res.on('data', x => parts.push(x)); res.on('error', reject); res.on('end', () => {
          const text = Buffer.concat(parts).toString(); resolve({ status: res.statusCode, headers: res.headers, text,
            data: res.headers['content-type']?.includes('application/json') && text ? JSON.parse(text) : null });
        });
      }); req.setTimeout(10000, () => req.destroy(new Error('Local-only HTTP timeout'))); req.on('error', reject); req.end(text);
    });
  }
  for (const kind of artifactTypes) {
    db.seed(kind, payload(kind)); const path = `/maps/${mapId}/${ARTIFACTS[kind].route}`;
    const legacy = await request('GET', path); assert.equal(legacy.status, 200); assert.equal(legacy.data.isCurrent, false); assert.equal(legacy.data.readMode, 'legacy');
    const tracked = await request('GET', path + '?freshness=tracked'); assert.equal(tracked.status, 409); assert.equal(tracked.data.error, 'artifact_stale');
    assert.equal(Object.keys(ARTIFACTS[kind].fields).some(f => Object.hasOwn(tracked.data, f)), false);
    assert.equal((await request('GET', path + '?freshness=tracked&includeStale=true')).status, 401);
    assert.equal((await request('GET', path + '?freshness=tracked&includeStale=true', { actor: other })).status, 404);
    const saved = await request('GET', path + '?freshness=tracked&includeStale=true', { actor: owner });
    assert.equal(saved.status, 200); assert.equal(saved.data.inspectionOnly, true); assert.equal(saved.data.sourceRevision, null);
    assert.equal(saved.headers['cache-control'], 'no-store');
    if (ARTIFACT_EXPORTS[kind]) {
      const exportPath = path + '/' + ARTIFACT_EXPORTS[kind] + (kind === 'relational_schema' ? '?dialect=postgres' : '');
      assert.equal((await request('GET', exportPath)).status, 409);
      const alternateCase = exportPath.split('?')[0].toUpperCase() + (kind === 'relational_schema' ? '?dialect=postgres' : '');
      assert.equal((await request('GET', alternateCase)).status, 409);
      assert.equal((await request('HEAD', alternateCase)).status, 409);
      assert.equal((await request('GET', exportPath + (exportPath.includes('?') ? '&' : '?') + 'includeStale=true')).status, 400);
    }
    for (const actor of [undefined, other]) {
      const refused = await request('POST', path, { actor, body: {} }); assert.equal(refused.status, actor ? 404 : 401);
    }
    const posted = await request('POST', path, { actor: owner, body: {} }); assert.equal(posted.status, 201, kind + ': ' + posted.text);
    const fresh = await request('GET', path + '?freshness=tracked'); assert.equal(fresh.status, 200); assert.equal(fresh.data.isCurrent, true);
    assert.equal(fresh.data.sourceRevision, 1); assert.ok(fresh.data.generationId); assert.equal(fresh.headers['x-mappr-current-revision'], '1');
    if (ARTIFACT_EXPORTS[kind]) {
      const exportPath = path + '/' + ARTIFACT_EXPORTS[kind] + (kind === 'relational_schema' ? '?dialect=postgres' : '');
      const exported = await request('GET', exportPath); assert.equal(exported.status, 200, kind + ': ' + exported.text);
      assert.ok(exported.headers['x-mappr-render-fingerprint']);
    }
  }
  assert.equal(db.modelCalls.length, 10); assert.equal(db.usage.length, 10);
  assert.equal(db.quotaCalls, 10);
  const entered = deferred(), release = deferred();
  modelHook = async config => { if (config.groqSchemaName === 'readme') { entered.resolve(); await release.promise; } };
  const pending = request('POST', `/maps/${mapId}/readme`, { actor: owner, body: {} });
  await entered.promise; clean(); // The HTTP generator holds no DB lease or map lock.
  const oldReadme = copy([...db.records.values()].find(e => e.kind === 'readme'));
  db.change(data => data.product.summary = 'New canonical summary'); release.resolve();
  const deniedPublication = await pending; assert.equal(deniedPublication.status, 409); assert.equal(deniedPublication.data.error, 'artifact_source_changed');
  assert.deepEqual([...db.records.values()].find(e => e.kind === 'readme'), oldReadme); assert.equal(db.usage.length, 10); modelHook = null;
  const stale = await request('GET', `/maps/${mapId}/readme?freshness=tracked`); assert.equal(stale.status, 409); assert.equal(stale.data.freshness.reason, 'source_changed');
  const inspected = await request('GET', `/maps/${mapId}/readme?freshness=tracked&includeStale=true`, { actor: owner });
  assert.equal(inspected.status, 200); assert.equal(inspected.data.isCurrent, false); assert.equal(inspected.data.currentRevision, 2);
  assert.equal((await request('GET', `/maps/${mapId}/relational-schema?freshness=tracked`)).data.sourceRevision, 1);
  assert.equal((await request('GET', `/maps/${mapId}/relational-schema`)).status, 404); // legacy version-key selection preserved
  assert.equal((await request('GET', `/maps/${mapId}/api-contract?includeStale=true`)).status, 400);
  db.provenanceSchema = false;
  assert.equal((await request('GET', `/maps/${mapId}/adrs/markdown`)).status, 503); clean();
});

test('composite exports omit stale dependencies and read one coherent snapshot even as dependencies regenerate', async () => {
  reset(); await generate('readme'); await generate('deployment'); db.seed('env_vars', { vars: [{ name: 'OLD_VALUE', description: 'Legacy', required: true, secret: false, placeholder: 'old', nodeId: null, techStackCategory: null }] });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/maps/${mapId}`;
    const beforeCalls = db.modelCalls.length;
    const deployment = await fetch(base + '/deployment/markdown'); const text = await deployment.text();
    assert.equal(deployment.status, 200); assert.match(text, /Optional generated artifacts omitted/); assert.doesNotMatch(text, /OLD_VALUE/);
    const readme = await fetch(base + '/readme/markdown'); const beforeFingerprint = readme.headers.get('x-mappr-render-fingerprint');
    assert.match(await readme.text(), /Optional generated artifacts omitted/);
    await generate('api_contract');
    const changed = await fetch(base + '/readme/markdown'); assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('x-mappr-render-fingerprint'), beforeFingerprint);
    let changedDuringRead = false;
    db.onRows = async (kind, tx) => { if (kind === 'env_vars' && tx.snapshot && !changedDuringRead) { changedDuringRead = true; db.change(data => data.meta.productName = 'After snapshot title'); } };
    const coherent = await fetch(base + '/deployment/markdown'); const coherentText = await coherent.text();
    assert.equal(coherent.status, 200); assert.match(coherentText, /Original fixture/); assert.doesNotMatch(coherentText, /After snapshot title/);
    assert.equal(coherent.headers.get('x-mappr-current-revision'), '1'); assert.equal(db.modelCalls.length, beforeCalls); clean();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('complete real export inventory is guarded and migration stays additive with no data backfill', () => {
  const routes = new URL('../../src/routes/', import.meta.url);
  const actual = readdirSync(routes).flatMap(name => [...readFileSync(new URL(name, routes), 'utf8').matchAll(/router\.get\('\/maps\/:id\/([^']+)'/g)]
    .map(m => m[1])).filter(path => /\/(?:sql|script|file|markdown)$/.test(path)).sort();
  assert.deepEqual(actual, Object.entries(ARTIFACT_EXPORTS).map(([kind, suffix]) => ARTIFACTS[kind].route + '/' + suffix).sort());
  for (const file of ['apiContract','relationalSchema','documentSchema','readme','adr','envVars','deployment','critique','requirements','traceability']) {
    const source = readFileSync(new URL(file + '.ts', routes), 'utf8');
    assert.match(source, /await captureArtifactSource/); assert.match(source, /await publishArtifact/);
    assert.doesNotMatch(source, /pool\.connect\(/);
  }
  const sql = readFileSync(new URL('../../src/db/migrations/015_artifact_provenance.sql', import.meta.url), 'utf8').replace(/--[^\r\n]*/g, '');
  assert.match(sql, /CREATE TABLE public\.artifact_generations/); assert.equal([...sql.matchAll(/ADD COLUMN generation_id uuid/g)].length, 10);
  assert.match(sql, /ALTER TABLE public\.artifact_generations ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.artifact_generations FROM PUBLIC/);
  assert.match(sql, /ARRAY\['anon','authenticated'\]/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.artifact_generations FROM %I/);
  assert.match(sql, /pg_catalog\.has_table_privilege/);
  assert.match(sql, /SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN/);
  assert.match(sql, /ERRCODE='42501'/);
  assert.doesNotMatch(sql, /CREATE POLICY|FORCE ROW LEVEL SECURITY|ALTER DEFAULT PRIVILEGES|GRANT\b/);
  assert.doesNotMatch(sql, /(?:^|;)\s*(?:UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/im);
  assert.doesNotMatch(sql, /ALTER TABLE public\.maps|ALTER TABLE public\.map_versions/);
});

async function allowanceHttp(t) {
  process.env.MAPPR_DAILY_ADMISSION_ENABLED='true';
  t.after(()=>{delete process.env.MAPPR_DAILY_ADMISSION_ENABLED;modelHook=null;});
  const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  return async(kind,actor=owner)=>{
    const cookie=`mappr_anon=${actor}.${createHmac('sha256',process.env.COOKIE_SECRET).update(actor).digest('hex')}`;
    const response=await fetch(`http://127.0.0.1:${server.address().port}/maps/${mapId}/${ARTIFACTS[kind].route}`,{
      method:'POST',headers:{Cookie:cookie,Origin:process.env.FRONTEND_ORIGIN,'Content-Type':'application/json'},body:'{}',
    });return {status:response.status,data:await response.json()};
  };
}
test('S4D all ten real artifact POSTs reserve and atomically settle shared daily units',async t=>{
  const post=await allowanceHttp(t);
  for(const kind of artifactTypes)await t.test(kind,async()=>{
    reset();modelHook=async()=>{clean();assert.equal(db.daily.locks.size,0,'No quota locks during provider');};
    const oldMap=copy(db.map),oldHistory=copy(db.history);
    assert.equal((await post(kind)).status,201);assert.equal(db.usage.length,1);assert.equal(db.daily.attempts.size,1);
    assert.equal([...db.daily.attempts.values()][0].state,'succeeded');assert.equal([...db.daily.attempts.values()][0].operation,kind);
    assert.equal(db.quotaCalls,0,'Serialized admission replaces the advisory precheck');assert.equal((await resolve(kind)).metadata.status,'fresh');
    assert.deepEqual(db.map,oldMap);assert.deepEqual(db.history,oldHistory);
    assert.equal((await post(kind)).status,201);const denied=await post(kind);
    assert.equal(denied.status,429);assert.equal(denied.data.error,'daily_limit_exceeded');assert.equal(db.modelCalls.length,2);assert.equal(db.usage.length,2);clean();
  });
});
test('S4D artifact source and same-slot conflicts release losing holds without successful usage',async t=>{
  reset();const post=await allowanceHttp(t);modelHook=async()=>db.change(data=>data.product.summary='Changed while generating');
  const changed=await post('readme');assert.equal(changed.status,409);assert.equal(changed.data.error,'artifact_source_changed');
  assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');
  reset();const both=deferred(),release=deferred();let entered=0;
  modelHook=async()=>{if(++entered===2)both.resolve();await release.promise;};
  const first=post('readme'),second=post('readme');await both.promise;clean();assert.equal(db.daily.locks.size,0);release.resolve();
  const results=await Promise.all([first,second]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(db.usage.length,1);assert.deepEqual([...db.daily.attempts.values()].map(a=>a.state).sort(),['failed','succeeded']);clean();
});
test('S4D artifact publication rollback and provider errors terminate holds; late workers cannot publish',async t=>{
  const post=await allowanceHttp(t),log=mock.method(console,'error',()=>{});t.after(()=>log.mock.restore());
  for(const stage of ['artifact','usage','provenance','attach','commit'])await t.test(stage,async()=>{
    reset();modelHook=async()=>{db.failAt=stage;};const response=await post('readme');assert.ok(response.status>=500);
    assert.equal(db.records.size,0);assert.equal(db.generations.size,0);assert.equal(db.usage.length,0);
    assert.equal([...db.daily.attempts.values()][0].state,'failed');clean();
  });
  reset();modelHook=async()=>{throw new Error('Private synthetic provider failure');};assert.equal((await post('readme')).status,500);
  assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');
  reset();modelHook=async()=>{db.time+=181000;};const late=await post('readme');assert.equal(late.status,409);assert.equal(late.data.error,'attempt_expired');
  assert.equal(db.records.size,0);assert.equal(db.usage.length,0);assert.equal([...db.daily.attempts.values()][0].state,'failed');clean();
});
test('S4D artifact lost COMMIT retains successful usage and subsequent failure cleanup never refunds it',async t=>{
  reset();const post=await allowanceHttp(t),log=mock.method(console,'error',()=>{});t.after(()=>log.mock.restore());
  modelHook=async()=>{db.uncertainCommit=true;};assert.equal((await post('readme')).status,500);
  assert.equal(db.usage.length,1);assert.equal([...db.daily.attempts.values()][0].state,'succeeded');
  assert.equal((await resolve('readme')).metadata.status,'fresh');await new DailyAdmission(db).recoverExpired();assert.equal(db.usage.length,1);clean();
});
