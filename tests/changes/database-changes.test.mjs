import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { databaseCandidate, validateSavedDatabase, buildDatabaseChangePrompt, databaseStorageValue, DATABASE_SQL } from '../../src/services/changes/database.ts';

const entity = (id, name = id, fields = [{ name: 'id', type: 'uuid' }]) => ({ id, name, fields });
const relation = (from, to, type = 'one-to-many', label) => ({ from, to, type, ...(label === undefined ? {} : { label }) });
const base = { meta: { productName: 'Fixture', oneLineSummary: 'Keep' }, product: { summary: 'Keep', concepts: [] }, users: [], features: [],
  techStack: [{ category: 'Database', choice: 'PostgreSQL', rationale: 'Keep' }], architecture: { nodes: [], edges: [] },
  dataModel: { entities: [{ ...entity('user'), extension: 17, fields: [{ name: 'id', type: 'uuid', extension: 17 }, { name: 'email', type: 'string' }] },
    entity('post'), entity('tag')], relations: [{ ...relation('user', 'post', 'one-to-many', null), extension: 17 }, relation('post', 'tag', 'many-to-many')], extension: 17 },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [], extension: 17 };
const context = { activeView: 'database', selectedTarget: null };
const up = value => ({ op: 'upsert_item', collection: 'dataModel.entities', value });
const remove = key => ({ op: 'remove_item', collection: 'dataModel.entities', key });
const relations = value => ({ op: 'replace_list', path: 'dataModel.relations', value });
const propose = (ops, system = base, ctx = context) => databaseCandidate(system, { operations: ops }, ctx);
const denied = (work, code = 'change_not_valid') => assert.throws(work, error => error.code === code);
const known = value => ({ from: value.from, to: value.to, type: value.type, ...('label' in value ? { label: value.label } : {}) });

test('Database entity/field edits show complete before/after values and preserve unrelated data and nested extensions', () => {
  const before = structuredClone(base), changed = entity('user', 'Account', [{ name: 'id', type: 'string' }, { name: 'displayName', type: 'string' }]);
  const p = propose([up(changed), up(entity('comment'))]);
  assert.deepEqual(base, before); assert.deepEqual(p.diff.dataModel.entities.changed[0].changedFields, ['name', 'fields']);
  assert.deepEqual(p.diff.dataModel.entities.changed[0].before, base.dataModel.entities[0]);
  assert.deepEqual(p.diff.dataModel.entities.changed[0].after.fields, [{ name: 'id', type: 'string', extension: 17 }, { name: 'displayName', type: 'string' }]);
  assert.deepEqual(p.diff.dataModel.entities.added, [entity('comment')]); assert.equal(p.candidate.dataModel.entities[0].extension, 17);
  assert.equal(p.candidate.dataModel.extension, 17); assert.deepEqual(p.candidate.dataModel.relations, base.dataModel.relations);
  const restored = structuredClone(p.candidate); restored.dataModel = base.dataModel; assert.deepEqual(restored, base);
  assert.equal(p.summary, 'Updated database model: 1 entity added, 1 entity updated.');
});

test('Database entity removal explicitly previews cascading relationships; field/entity renames keep their actual identities', () => {
  const p = propose([remove('post')]); assert.deepEqual(p.operations, [remove('post'), relations([])]);
  assert.equal(p.diff.dataModel.relations.removed.length, 2); assert.equal(p.diff.dataModel.entities.removed[0].id, 'post');
  assert.equal(p.summary, 'Updated database model: 1 entity removed, 2 relationships removed.');
  const renamed = propose([up(entity('post', 'Article'))]); assert.equal(renamed.candidate.dataModel.entities[1].id, 'post');
  assert.deepEqual(renamed.diff.dataModel.entities.changed[0].changedFields, ['name']); assert.deepEqual(renamed.candidate.dataModel.relations, base.dataModel.relations);
  const renamedField = propose([up(entity('post', 'post', [{ name: 'postId', type: 'uuid' }]))]);
  assert.deepEqual(renamedField.diff.dataModel.entities.changed[0].after.fields, [{ name: 'postId', type: 'uuid' }]);
  const all = propose([remove('user'), remove('post'), remove('tag')]); assert.deepEqual(all.candidate.dataModel.entities, []); assert.deepEqual(all.candidate.dataModel.relations, []);
});

test('Database relationships support cardinality/label edits, self-relations and distinct named relations without losing extensions', () => {
  const p = propose([relations([relation('user', 'post', 'one-to-one'), relation('post', 'tag', 'many-to-many'), relation('user', 'user', 'many-to-many', 'follows')])]);
  assert.equal(p.diff.dataModel.relations.added.length, 2); assert.equal(p.diff.dataModel.relations.removed.length, 1);
  assert.deepEqual(p.candidate.dataModel.relations[0], { ...base.dataModel.relations[0], type: 'one-to-one' });
  assert.equal(p.candidate.dataModel.relations[0].label, null); assert.equal(p.candidate.dataModel.relations[0].extension, 17);
  const distinct = propose([relations([...base.dataModel.relations.map(known), relation('user', 'post', 'one-to-one', ''), relation('user', 'post', 'one-to-one', 'owns')])]);
  assert.equal(distinct.diff.dataModel.relations.added.length, 2, 'Empty and nonempty labels are separate identities');
  const label = propose([relations([relation('user', 'post', 'one-to-many', 'writes'), relation('post', 'tag', 'many-to-many')])]);
  assert.equal(label.diff.dataModel.relations.added[0].label, 'writes'); assert.equal(label.diff.dataModel.relations.removed[0].label, null);
});

test('Database selected entity permits only that entity and its incident relationship edits', () => {
  const selected = { activeView: 'database', selectedTarget: { kind: 'entity', id: 'user' } };
  assert.equal(propose([remove('user')], base, selected).diff.dataModel.relations.removed.length, 1);
  assert.equal(propose([up(entity('user', 'Account', []))], base, selected).diff.dataModel.entities.changed.length, 1);
  denied(() => propose([up(entity('post', 'Article'))], base, selected));
  denied(() => propose([up(entity('comment'))], base, selected));
  denied(() => propose([relations([known(base.dataModel.relations[0])])], base, selected));
  denied(() => propose([remove('post')], base, { activeView: 'database', selectedTarget: { kind: 'entity', id: 'absent' } }), 'invalid_request');
  denied(() => propose([remove('post')], base, { activeView: 'database', selectedTarget: { kind: 'architecture_node', id: 'user' } }), 'unsupported_scope');
  denied(() => propose([remove('post')], base, { activeView: 'data_model', selectedTarget: null }), 'unsupported_scope');
});

test('Database invalid operations, ambiguous fields/entities and dangling/conflicting relationships are rejected', async t => {
  const cases = [
    ['root replacement', () => databaseCandidate(base, base, context)],
    ['invented summary', () => databaseCandidate(base, { operations: [remove('post')], summary: 'AI claim' }, context)],
    ['wrong collection', () => propose([{ op: 'remove_item', collection: 'techStack', key: 'post' }])],
    ['arbitrary path', () => propose([{ op: 'set_field', path: 'dataModel.entities', value: [] }])],
    ['physical entity fields', () => propose([up({ ...entity('post'), tableName: 'posts' })])],
    ['physical field fields', () => propose([up(entity('post', 'Post', [{ name: 'id', type: 'uuid', primaryKey: true }]))])],
    ['physical relationship fields', () => propose([relations([{ ...relation('user', 'post'), references: 'id' }])])],
    ['duplicate writes', () => propose([remove('post'), up(entity('post'))])],
    ['missing removal', () => propose([remove('missing')])],
    ['empty id', () => propose([up(entity(' '))])],
    ['empty name', () => propose([up(entity('post', ' '))])],
    ['empty field name', () => propose([up(entity('post', 'Post', [{ name: ' ', type: 'string' }]))])],
    ['empty field type', () => propose([up(entity('post', 'Post', [{ name: 'id', type: ' ' }]))])],
    ['duplicate fields', () => propose([up(entity('post', 'Post', [{ name: 'id', type: 'uuid' }, { name: 'id', type: 'string' }]))])],
    ['field reordering', () => propose([up(entity('user', 'user', [{ name: 'email', type: 'string' }, { name: 'id', type: 'uuid' }]))])],
    ['dangling entity', () => propose([relations([relation('missing', 'post')])])],
    ['removed endpoint', () => propose([remove('post'), relations([relation('user', 'post')])])],
    ['duplicate relationships', () => propose([relations([relation('user', 'post'), relation('user', 'post', 'one-to-many', null)])])],
    ['conflicting cardinalities', () => propose([relations([relation('user', 'post'), relation('user', 'post', 'one-to-one')])])],
    ['unsupported cardinality', () => propose([relations([relation('user', 'post', 'many-to-one')])])],
    ['duplicate replacements', () => propose([relations([]), relations([])])],
    ['relationship reordering', () => propose([relations([...base.dataModel.relations].reverse().map(known))])],
    ['too many operations', () => propose(Array.from({ length: 51 }, (_, i) => up(entity('e' + i))))],
    ['too many fields', () => propose([up(entity('post', 'Post', Array.from({ length: 501 }, (_, i) => ({ name: 'f' + i, type: 'string' }))))])],
    ['too many relationships', () => propose([relations(Array.from({ length: 501 }, (_, i) => relation('user', 'post', 'one-to-many', 'r' + i)))])],
    ['duplicate base id', () => propose([remove('post')], { ...base, dataModel: { ...base.dataModel, entities: [...base.dataModel.entities, entity('user')] } })],
    ['duplicate base field', () => propose([remove('post')], { ...base, dataModel: { ...base.dataModel, entities: [entity('post', 'Post', [{ name: 'id', type: 'uuid' }, { name: 'id', type: 'uuid' }])] } })],
    ['dangling base relationship', () => propose([up(entity('new'))], { ...base, dataModel: { ...base.dataModel, relations: [relation('absent', 'post')] } })],
  ];
  for (const [name, work] of cases) await t.test(name, () => denied(work));
  denied(() => propose([remove('post')], { ...base, dataModel: { entities: [{ id: 'bad' }], relations: [] } }), 'revision_not_ready');
  denied(() => propose([])); denied(() => propose([up(entity('post'))]), 'no_changes');
});

test('Database normalized proposals revalidate saved operations, complete diff, context, summary and affected section', () => {
  const p = propose([up(entity('post')), remove('user')]), saved = { ...p, context, affectedSections: ['dataModel'] };
  assert.deepEqual(p.operations, [remove('user'), relations([relation('post', 'tag', 'many-to-many')])]);
  assert.deepEqual(validateSavedDatabase(base, saved).candidate, p.candidate);
  for (const mutate of [s => s.operations[0].key = 'missing', s => s.diff.dataModel.relations.removed = [], s => s.summary = 'Invented',
    s => s.affectedSections = ['techStack'], s => s.context.activeView = 'architecture']) {
    const altered = structuredClone(saved); mutate(altered); denied(() => validateSavedDatabase(base, altered), 'proposal_obsolete');
  }
  const prompt = buildDatabaseChangePrompt(base, 'Untrusted user instruction', context);
  assert.match(prompt, /untrusted data/); assert.match(prompt, /not generated relational\/document schemas/); assert.ok(prompt.includes(JSON.stringify(context)));
  assert.deepEqual(Object.keys(JSON.parse(databaseStorageValue(p.candidate))), ['entities', 'relations']);
  assert.equal(JSON.parse(databaseStorageValue(p.candidate)).entities[0].extension, undefined);
});

test('Database scoped JSONB projection preserves nested exact extensions on isolated PostgreSQL 17', {
  skip: !process.env.MAPPR_S4H_PG_TEST_CONFIG && 'No explicit isolated local PG17 target; SQL expression integration not run.',
}, async () => {
  assert.equal(process.env.MAPPR_S4H_PG_READONLY, 'I_ACCEPT_ISOLATED_READONLY_SQL_ONLY');
  const cfg = JSON.parse(readFileSync(process.env.MAPPR_S4H_PG_TEST_CONFIG, 'utf8'));
  assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.ssl, false); assert.ok(Number.isInteger(cfg.port) && cfg.port !== 5432);
  assert.ok(cfg.expectedSystemIdentifier && path.isAbsolute(cfg.dataDirectory));
  const { Client } = await import('pg');
  const client = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, ssl: false,
    connectionTimeoutMillis: 10000, query_timeout: 15000, options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000' });
  client.on('error', () => {});
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const identity = (await client.query("SELECT current_database() database,(SELECT system_identifier::text FROM pg_control_system()) pin,current_setting('data_directory') dir,current_setting('server_version_num')::integer version,host(inet_server_addr()) host,inet_server_port() port")).rows[0];
    assert.equal(identity.database, cfg.database); assert.equal(identity.pin, cfg.expectedSystemIdentifier);
    assert.equal(path.resolve(identity.dir).toLowerCase(), path.resolve(cfg.dataDirectory).toLowerCase());
    assert.equal(Math.floor(identity.version / 10000), 17); assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, cfg.port);
    const raw = JSON.stringify(base).replaceAll('"extension":17', '"extension":9007199254740993');
    const scenarios = [
      [up(entity('user', 'Account', [{ name: 'id', type: 'string' }, { name: 'fullName', type: 'string' }])), up(entity('comment')),
        relations([relation('user', 'post', 'one-to-one'), relation('post', 'tag', 'many-to-many'), relation('comment', 'post')])],
      [remove('post')], [remove('user'), remove('post'), remove('tag')],
    ];
    for (let i = 0; i < scenarios.length; i++) {
      const expected = propose(scenarios[i], JSON.parse(raw));
      const row = (await client.query(`SELECT candidate,candidate::text candidate_text,(candidate-'dataModel')=(data-'dataModel') unrelated_equal
        FROM (SELECT data,${DATABASE_SQL} candidate FROM (VALUES($1::jsonb)) source(data)) projected`, [raw, databaseStorageValue(expected.candidate)])).rows[0];
      assert.deepEqual(row.candidate, expected.candidate); assert.equal(row.unrelated_equal, true);
      assert.equal((row.candidate_text.match(/9007199254740993/g) || []).length, [5, 4, 2][i]);
    }
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
