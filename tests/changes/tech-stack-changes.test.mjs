import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { techStackCandidate, validateSavedTechStack, buildTechStackChangePrompt, techStackStorageValue, TECH_STACK_SQL } from '../../src/services/changes/techStack.ts';

const entry = (category, choice = category, rationale = 'Reason for ' + choice) => ({ category, choice, rationale });
const base = { meta: { productName: 'Fixture', oneLineSummary: 'Keep' }, product: { summary: 'Keep', concepts: [] },
  users: [], features: [], techStack: [{ ...entry('Database', 'PostgreSQL'), extension: { keep: 17 } }, entry('Frontend', 'React')],
  architecture: { nodes: [{ id: 'db', label: 'PostgreSQL', type: 'database', description: 'Keep graph' }], edges: [] },
  dataModel: { entities: [], relations: [] }, designSystem: { colors: [], typography: [], spacing: [], components: [] },
  developmentPlan: [], extension: { keep: true } };
const context = { activeView: 'tech-stack', selectedTarget: null };
const up = value => ({ op: 'upsert_item', collection: 'techStack', value });
const remove = key => ({ op: 'remove_item', collection: 'techStack', key });
const propose = (ops, system = base, ctx = context) => techStackCandidate(system, { operations: ops }, ctx);
const denied = (work, code = 'change_not_valid') => assert.throws(work, error => error.code === code);

test('Tech Stack addition, removal and technology replacement produce exact before/after previews and preserve other sections', () => {
  const before = structuredClone(base), next = entry('Database', 'SQLite', 'Local embedded storage');
  const p = propose([up(next), remove('Frontend'), up(entry('Cache', 'Redis'))]);
  assert.deepEqual(base, before);
  assert.deepEqual(p.diff.techStack.changed, [{ before: base.techStack[0], after: { ...base.techStack[0], ...next }, changedFields: ['choice', 'rationale'] }]);
  assert.deepEqual(p.diff.techStack.added, [entry('Cache', 'Redis')]);
  assert.deepEqual(p.diff.techStack.removed, [entry('Frontend', 'React')]);
  assert.equal(p.summary, 'Updated tech stack: 1 technology added, 1 technology removed, 1 technology updated.');
  assert.deepEqual(p.candidate.techStack[0].extension, { keep: 17 });
  const restored = structuredClone(p.candidate); restored.techStack = base.techStack; assert.deepEqual(restored, base);
});

test('Tech Stack categories are exact natural keys, not invented IDs; renames are explicit removal/addition', () => {
  const p = propose([up(entry('Storage', 'PostgreSQL')), remove('Database')]);
  assert.deepEqual(p.candidate.techStack.map(item => item.category), ['Frontend', 'Storage']);
  assert.equal(p.diff.techStack.changed.length, 0); assert.equal(p.diff.techStack.removed[0].category, 'Database');
  assert.equal(p.diff.techStack.added[0].category, 'Storage');
  assert.equal(p.candidate.techStack[1].extension, undefined, 'A renamed category does not inherit hidden fields from a different key');
  assert.equal(propose([up(entry('database', 'Other'))]).candidate.techStack.length, 3, 'Keys remain case-sensitive, matching existing diff and grounding');
  assert.equal(propose([remove('Database'), remove('Frontend')]).candidate.techStack.length, 0);
  assert.equal(propose([up(entry('__proto__', 'Fixture'))]).diff.techStack.added.length, 1);
});

test('Tech Stack surviving order is stable, redundant upserts disappear, and no-op proposals fail', () => {
  const p = propose([up(entry('Frontend', 'Svelte')), up(entry('Cache', 'Redis')), up(entry('Database', 'PostgreSQL'))]);
  assert.deepEqual(p.candidate.techStack.map(item => item.category), ['Database', 'Frontend', 'Cache']);
  assert.equal(p.operations.length, 2);
  assert.deepEqual(p.diff.techStack.changed[0].changedFields, ['choice', 'rationale']);
  const rationale = propose([up(entry('Frontend', 'React', 'Revised justification'))]);
  assert.deepEqual(rationale.diff.techStack.changed[0].changedFields, ['rationale']);
  denied(() => propose([up(entry('Database', 'PostgreSQL'))]), 'no_changes');
  assert.equal(propose([up(entry('Cache', 'Redis'))], { ...base, techStack: [] }).diff.techStack.added.length, 1);
});

test('Tech Stack rejects malformed, out-of-scope and ambiguous operations without silently repairing data', async t => {
  const cases = [
    ['root replacement', () => techStackCandidate(base, base, context)],
    ['invented summary', () => techStackCandidate(base, { operations: [remove('Frontend')], summary: 'AI summary' }, context)],
    ['wrong collection', () => propose([{ op: 'remove_item', collection: 'architecture.nodes', key: 'Frontend' }])],
    ['arbitrary path', () => propose([{ op: 'set_field', path: 'product.summary', value: 'Wrong' }])],
    ['list replacement', () => propose([{ op: 'replace_list', path: 'techStack', value: [] }])],
    ['missing removal', () => propose([remove('Absent')])],
    ['duplicate writes', () => propose([remove('Frontend'), up(entry('Frontend', 'Vue'))])],
    ['duplicate additions', () => propose([up(entry('Cache')), up(entry('Cache', 'Different'))])],
    ['extra item fields', () => propose([up({ ...entry('Cache'), id: 'invented' })])],
    ['extra operation fields', () => propose([{ ...remove('Frontend'), value: 'Wrong' }])],
    ['missing rationale', () => propose([up({ category: 'Cache', choice: 'Redis' })])],
    ['blank category', () => propose([up(entry('  ', 'Redis'))])],
    ['blank choice', () => propose([up(entry('Cache', '  '))])],
    ['blank rationale', () => propose([up(entry('Cache', 'Redis', '\n'))])],
    ['oversized key', () => propose([up(entry('x'.repeat(129)))])],
    ['empty operations', () => propose([])],
    ['too many operations', () => propose(Array.from({ length: 51 }, (_, i) => up(entry('item-' + i))))],
    ['duplicate base category', () => propose([remove('Frontend')], { ...base, techStack: [...base.techStack, entry('Database')] })],
    ['blank base category', () => propose([remove('Frontend')], { ...base, techStack: [...base.techStack, entry(' ')] })],
  ];
  for (const [name, work] of cases) await t.test(name, () => denied(work));
  denied(() => propose([remove('Frontend')], { ...base, techStack: [{ category: 'Broken' }] }), 'revision_not_ready');
  denied(() => propose([remove('Frontend')], base, { activeView: 'tech_stack', selectedTarget: null }), 'unsupported_scope');
  denied(() => propose([remove('Frontend')], base, { activeView: 'tech-stack', selectedTarget: { kind: 'architecture_node', id: 'db' } }), 'unsupported_scope');
});

test('Tech Stack saved proposals revalidate operations, diff, summary, context and affected sections', () => {
  const p = propose([remove('Database')]), saved = { ...p, context, affectedSections: ['techStack'] };
  assert.deepEqual(validateSavedTechStack(base, saved).candidate, p.candidate);
  for (const mutate of [s => s.operations[0].key = 'Absent', s => s.diff.techStack.removed = [], s => s.summary = 'Invented',
    s => s.affectedSections = ['architecture'], s => s.context.activeView = 'overview']) {
    const altered = structuredClone(saved); mutate(altered); denied(() => validateSavedTechStack(base, altered), 'proposal_obsolete');
  }
  const prompt = buildTechStackChangePrompt(base, 'Untrusted instruction to change everything', context);
  assert.match(prompt, /untrusted data/); assert.match(prompt, /case-sensitive/); assert.match(prompt, /category,choice,rationale/);
  assert.ok(prompt.includes(JSON.stringify(context))); assert.ok(prompt.includes('Untrusted instruction to change everything'));
  assert.deepEqual(JSON.parse(techStackStorageValue(p.candidate)), [entry('Frontend', 'React')]);
  const changed = propose([up(entry('Database', 'SQLite'))]);
  assert.equal(JSON.parse(techStackStorageValue(changed.candidate))[0].extension, undefined, 'Storage payload contains only known fields; SQL preserves raw extensions');
});

test('Tech Stack scoped JSONB projection preserves exact extensions on isolated PostgreSQL 17', {
  skip: !process.env.MAPPR_S4G_PG_TEST_CONFIG && 'No explicit isolated local PG17 target; SQL expression integration not run.',
}, async () => {
  assert.equal(process.env.MAPPR_S4G_PG_READONLY, 'I_ACCEPT_ISOLATED_READONLY_SQL_ONLY');
  const cfg = JSON.parse(readFileSync(process.env.MAPPR_S4G_PG_TEST_CONFIG, 'utf8'));
  assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.ssl, false); assert.ok(Number.isInteger(cfg.port) && cfg.port !== 5432);
  assert.ok(cfg.expectedSystemIdentifier && path.isAbsolute(cfg.dataDirectory));
  const { Client } = await import('pg');
  const client = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, ssl: false,
    connectionTimeoutMillis: 10000, query_timeout: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000' });
  client.on('error', () => {});
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const identity = (await client.query("SELECT current_database() database,(SELECT system_identifier::text FROM pg_control_system()) pin,current_setting('data_directory') dir,current_setting('server_version_num')::integer version,host(inet_server_addr()) host,inet_server_port() port")).rows[0];
    assert.equal(identity.database, cfg.database); assert.equal(identity.pin, cfg.expectedSystemIdentifier);
    assert.equal(path.resolve(identity.dir).toLowerCase(), path.resolve(cfg.dataDirectory).toLowerCase());
    assert.equal(Math.floor(identity.version / 10000), 17); assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, cfg.port);
    const raw = JSON.stringify(base).replace('"keep":17', '"keep":9007199254740993').replace('"keep":true', '"keep":true,"precise":9007199254740993');
    for (const ops of [[up(entry('Database', 'SQLite')), remove('Frontend'), up(entry('Cache', 'Redis'))], [remove('Database'), remove('Frontend')]]) {
      const expected = propose(ops, JSON.parse(raw));
      const row = (await client.query(`SELECT candidate,candidate::text candidate_text,(candidate-'techStack')=(data-'techStack') unrelated_equal
        FROM (SELECT data,${TECH_STACK_SQL} candidate FROM (VALUES($1::jsonb)) source(data)) projected`, [raw, techStackStorageValue(expected.candidate)])).rows[0];
      assert.deepEqual(row.candidate, expected.candidate); assert.equal(row.unrelated_equal, true);
      assert.equal((row.candidate_text.match(/9007199254740993/g) || []).length, ops[0].op === 'upsert_item' ? 2 : 1);
    }
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
