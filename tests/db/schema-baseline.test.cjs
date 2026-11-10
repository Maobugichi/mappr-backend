'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const sql = fs.readFileSync(path.join(root, 'src/db/baseline/001_existing_schema.sql'), 'utf8');
const executable = sql.replace(/--[^\r\n]*/g, '').replace(/\r\n/g, '\n').trim();
const envelope = executable.match(/^BEGIN;\s*([\s\S]*?)\s*COMMIT;$/);
const transactionBody = envelope?.[1];
const normalize = value => value.replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim();

// Independent expected inventory from BACKEND_S1_SCHEMA_BASELINE.md and the
// retained 2026-11-06 catalog; never derive expected live results from the SQL.
const column = (name, type, nullable = false, defaultExpression = null) => ({ name, type, nullable, defaultExpression });
const id = column('id', 'uuid', false, 'gen_random_uuid()');
const mapId = column('map_id', 'uuid');
const created = column('created_at', 'timestamptz', false, 'now()');
const updated = column('updated_at', 'timestamptz', false, 'now()');
const review = payload => [id, mapId, column(payload, 'jsonb'), created, updated];
const versioned = payload => [id, mapId, column('version', 'integer'), column(payload, 'jsonb'), created, updated];
const hashed = payload => [id, mapId, column('tech_arch_hash', 'text'), column(payload, 'jsonb'), created, updated];
const tables = {
  maps: [id, column('anon_id', 'uuid'), column('input_description', 'text'), column('data', 'jsonb'), created, updated],
  generations: [id, column('anon_id', 'uuid'), column('map_id', 'uuid', true), created],
  map_versions: [id, mapId, column('version', 'integer'), column('data', 'jsonb'), column('patch', 'jsonb', true), column('summary', 'text'), created],
  architecture_reviews: review('findings'),
  missing_requirement_reviews: review('findings'),
  traceability_reviews: review('links'),
  api_contracts: versioned('endpoints'),
  relational_schemas: versioned('tables'),
  document_schemas: versioned('collections'),
  adrs: hashed('adrs'),
  readmes: [id, mapId, column('version', 'integer'), column('overview', 'text'), column('getting_started', 'jsonb'), created, updated],
  env_vars: hashed('vars'),
  deployments: [id, mapId, column('tech_arch_hash', 'text'), column('components', 'jsonb'), column('environments', 'jsonb'), column('cicd_steps', 'jsonb'), column('migrations', 'text', true), created, updated],
};
const tableNames = Object.keys(tables);
const constraints = tableNames.flatMap(name => {
  const rows = [{ table: name, name: `${name}_pkey`, type: 'p', definition: 'PRIMARY KEY (id)' }];
  if (name !== 'maps') {
    rows.push({ table: name, name: `${name}_map_id_fkey`, type: 'f', definition: `FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE ${name === 'generations' ? 'SET NULL' : 'CASCADE'}` });
  }
  if (['architecture_reviews', 'missing_requirement_reviews', 'traceability_reviews'].includes(name)) {
    rows.push({ table: name, name: `${name}_map_id_key`, type: 'u', definition: 'UNIQUE (map_id)' });
  } else if (['map_versions', 'api_contracts', 'relational_schemas', 'document_schemas', 'readmes'].includes(name)) {
    rows.push({ table: name, name: `${name}_map_id_version_key`, type: 'u', definition: 'UNIQUE (map_id, version)' });
  } else if (['adrs', 'env_vars', 'deployments'].includes(name)) {
    rows.push({ table: name, name: `${name}_map_id_tech_arch_hash_key`, type: 'u', definition: 'UNIQUE (map_id, tech_arch_hash)' });
  }
  return rows;
});
const standaloneIndexes = [
  { table: 'maps', name: 'idx_maps_anon_id', columns: 'anon_id' },
  { table: 'generations', name: 'idx_generations_anon_id_created_at', columns: 'anon_id, created_at' },
  { table: 'generations', name: 'idx_generations_created_at', columns: 'created_at' },
  { table: 'map_versions', name: 'map_versions_map_id_version_idx', columns: 'map_id, version DESC' },
];
const expectedIndexes = [
  ...constraints.filter(item => item.type !== 'f').map(item => ({
    table: item.table, name: item.name, unique: true, primary: item.type === 'p',
    definition: `CREATE UNIQUE INDEX ${item.name} ON ${item.table} USING btree (${item.definition.match(/\(([^)]+)\)/)[1]})`,
  })),
  ...standaloneIndexes.map(item => ({ ...item, unique: false, primary: false, definition: `CREATE INDEX ${item.name} ON ${item.table} USING btree (${item.columns})` })),
];
const sortNamed = items => [...items].sort((a, b) => a.name.localeCompare(b.name));

function splitDefinitions(body) {
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    if (body[i] === ')') depth--;
    if (body[i] === ',' && depth === 0) { parts.push(body.slice(start, i).trim()); start = i + 1; }
  }
  assert.equal(depth, 0, 'Unbalanced table definition');
  parts.push(body.slice(start).trim());
  return parts;
}

const parsedTables = [...executable.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)];

test('offline inventory: all 13 tables and 78 ordered columns match S1', () => {
  assert.equal(tableNames.length, 13);
  assert.equal(Object.values(tables).flat().length, 78);
  assert.deepEqual(parsedTables.map(match => match[1]).sort(), [...tableNames].sort());
  for (const [, name, body] of parsedTables) {
    const actual = splitDefinitions(body).filter(part => !part.startsWith('CONSTRAINT ')).map(part => {
      const match = part.match(/^(\w+) (uuid|integer|text|jsonb|timestamptz)( NOT NULL)?(?: DEFAULT ((?:gen_random_uuid|now)\(\)))?$/);
      assert.ok(match, `Unsupported column definition in ${name}`);
      return column(match[1], match[2], !match[3], match[4] ?? null);
    });
    assert.deepEqual(actual, tables[name], `Columns differ for ${name}`);
  }
});

test('offline constraints: exact 36 named keys, nullability, and delete actions', () => {
  const actual = parsedTables.flatMap(([, table, body]) => splitDefinitions(body).filter(part => part.startsWith('CONSTRAINT ')).map(part => {
    const match = part.match(/^CONSTRAINT (\w+) (PRIMARY KEY|UNIQUE|FOREIGN KEY)([\s\S]*)$/);
    assert.ok(match, `Unsupported constraint in ${table}`);
    return { table, name: match[1], type: { 'PRIMARY KEY': 'p', UNIQUE: 'u', 'FOREIGN KEY': 'f' }[match[2]], definition: normalize(match[2] + match[3]) };
  }));
  assert.equal(constraints.length, 36);
  assert.deepEqual(sortNamed(actual), sortNamed(constraints));
});

test('offline indexes: all 24 key-backed and four standalone indexes are represented', () => {
  const actual = [...executable.matchAll(/CREATE INDEX (\w+) ON public\.(\w+) USING btree \(([^;]+)\);/g)].map(match => ({ name: match[1], table: match[2], columns: match[3] }));
  assert.deepEqual(sortNamed(actual), sortNamed(standaloneIndexes));
  assert.equal(expectedIndexes.length, 28);
});

test('offline SQL scope: transactional, guarded, application-only, no speculative schema', () => {
  assert.ok(envelope, 'Baseline must have one outer BEGIN/COMMIT boundary');
  const guard = transactionBody.match(/DO \$baseline\$[\s\S]*?\$baseline\$;/);
  assert.ok(guard, 'Missing pre-DDL safety guard');
  assert.ok(transactionBody.indexOf(guard[0]) < transactionBody.indexOf('CREATE TABLE'));
  assert.match(guard[0], /namespace\.nspname = 'public'/);
  assert.match(guard[0], /RAISE EXCEPTION 'Baseline requires an empty disposable public schema'/);
  assert.match(guard[0], /pg_catalog\.gen_random_uuid\(\)/);
  assert.match(guard[0], /END;\s*\$baseline\$;/);
  assert.doesNotMatch(executable, /IF NOT EXISTS|\b(?:auth|storage|realtime|vault)\./i);
  assert.doesNotMatch(executable, /\b(?:current_revision|map_change_proposals|input_fingerprint|source_revision|generator_version|schema_migrations)\b/i);
  let remaining = transactionBody.replace(guard[0], '').replace('SET LOCAL search_path = pg_catalog, public;', '');
  remaining = remaining.replace(/CREATE TABLE public\.\w+ \([\s\S]*?\n\);/g, '');
  remaining = remaining.replace(/CREATE INDEX \w+ ON public\.\w+ USING btree \([^;]+\);/g, '');
  assert.equal(remaining.trim(), '', 'Unexpected executable SQL outside the baseline grammar');
});

const envKeys = ['MAPPR_SCHEMA_TEST_DATABASE_URL', 'MAPPR_SCHEMA_TEST_DATABASE_NAME', 'MAPPR_SCHEMA_TEST_DISPOSABLE'];
const confirmation = 'I_ACCEPT_DISPOSABLE_DATABASE_ONLY';

function parseUrl(value, message) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    return url;
  } catch { throw new Error(message); }
}

// Pure validation: no network, dotenv loading, or pg environment fallback.
function disposableConfiguration(env, applicationUrls = []) {
  if (envKeys.every(key => !env[key])) return null;
  if (envKeys.some(key => !env[key])) throw new Error('All three disposable test settings are required.');
  if (env.MAPPR_SCHEMA_TEST_DISPOSABLE !== confirmation) throw new Error('Explicit disposable confirmation is required.');
  const name = env.MAPPR_SCHEMA_TEST_DATABASE_NAME;
  if (!/^mappr_schema_test_[a-z0-9_]+$/.test(name)) throw new Error('Disposable database name must use the reserved test prefix.');
  const url = parseUrl(env.MAPPR_SCHEMA_TEST_DATABASE_URL, 'Invalid disposable test URL.');
  let database, user, password;
  try { database = decodeURIComponent(url.pathname.slice(1)); user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error('Invalid disposable URL encoding.'); }
  if (!url.hostname || database !== name || !user || !password || url.hash) throw new Error('Disposable URL must explicitly identify the expected database and credentials.');
  const mode = url.searchParams.get('sslmode');
  if ([...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length !== 1 || !['disable', 'require', 'verify-full'].includes(mode)) {
    throw new Error('Only one explicit sslmode parameter is supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (mode === 'disable' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Unencrypted tests require a loopback host.');
  for (const applicationUrl of applicationUrls.filter(Boolean)) {
    const application = parseUrl(applicationUrl, 'Cannot establish application database exclusion.');
    let applicationName;
    try { applicationName = decodeURIComponent(application.pathname.slice(1)); } catch { throw new Error('Cannot establish application database exclusion.'); }
    // Intentionally reject the same database name even across host aliases.
    if (database === applicationName) throw new Error('Disposable target overlaps the configured application database.');
  }
  return { host, port: Number(url.port || 5432), database, user, password, ssl: mode === 'disable' ? false : { rejectUnauthorized: true } };
}

test('offline isolation: absent dedicated configuration never falls back to DATABASE_URL', () => {
  assert.equal(disposableConfiguration({ DATABASE_URL: 'intentionally-not-a-connection' }), null);
  assert.throws(() => disposableConfiguration({ MAPPR_SCHEMA_TEST_DATABASE_NAME: 'mappr_schema_test_example' }), /All three/);
});

test('offline isolation: reject unconfirmed, misnamed, overridden, or application targets', () => {
  const safe = { MAPPR_SCHEMA_TEST_DATABASE_URL: 'postgresql://fixture:example@127.0.0.1/mappr_schema_test_example?sslmode=disable', MAPPR_SCHEMA_TEST_DATABASE_NAME: 'mappr_schema_test_example', MAPPR_SCHEMA_TEST_DISPOSABLE: confirmation };
  assert.equal(disposableConfiguration(safe).database, safe.MAPPR_SCHEMA_TEST_DATABASE_NAME);
  assert.throws(() => disposableConfiguration({ ...safe, MAPPR_SCHEMA_TEST_DISPOSABLE: 'no' }), /confirmation/);
  assert.throws(() => disposableConfiguration({ ...safe, MAPPR_SCHEMA_TEST_DATABASE_NAME: 'application' }), /reserved test prefix/);
  assert.throws(() => disposableConfiguration({ ...safe, MAPPR_SCHEMA_TEST_DATABASE_URL: safe.MAPPR_SCHEMA_TEST_DATABASE_URL.replace('mappr_schema_test_example', 'other') }), /explicitly identify/);
  assert.throws(() => disposableConfiguration({ ...safe, MAPPR_SCHEMA_TEST_DATABASE_URL: safe.MAPPR_SCHEMA_TEST_DATABASE_URL + '&options=unexpected' }), /sslmode/);
  assert.throws(() => disposableConfiguration(safe, [safe.MAPPR_SCHEMA_TEST_DATABASE_URL.replace('127.0.0.1', 'another-host')] ), /overlaps/);
});

function configuredApplicationUrls() {
  const values = [process.env.DATABASE_URL];
  const filename = path.join(root, '.env');
  if (fs.existsSync(filename)) {
    // Parse only for a deny-list; do not load .env into process.env or connect.
    values.push(require('dotenv').parse(fs.readFileSync(filename)).DATABASE_URL);
  }
  return values;
}

async function assertDisposableTarget(client, config) {
  const identity = await client.query(`SELECT current_database() = $1 AS name_matches,
    pg_catalog.shobj_description(oid, 'pg_database') = $2 AS marker_matches,
    current_setting('server_version_num')::integer / 10000 = 17 AS version_matches
    FROM pg_catalog.pg_database WHERE datname = current_database()`, [config.database, `mappr-a1-disposable:${config.database}`]);
  assert.deepEqual(identity.rows, [{ name_matches: true, marker_matches: true, version_matches: true }], 'Disposable server identity/marker/version was not verified');
  const existing = await client.query(`SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' LIMIT 1`);
  assert.equal(existing.rowCount, 0, 'Disposable public schema must have no relations');
}

const enabled = envKeys.some(key => Boolean(process.env[key]));
test('isolated PostgreSQL 17 reproduction and relationship semantics', {
  skip: !enabled && 'No dedicated disposable test configuration; SQL reproduction NOT verified.',
  timeout: 120000,
}, async () => {
  let client;
  let transaction = false;
  let connectionFailed = false;
  let stage = 'configuration';
  try {
    const config = disposableConfiguration(process.env, configuredApplicationUrls());
    assert.ok(config && envelope);
    const { Client } = require('pg');
    client = new Client({ ...config, connectionTimeoutMillis: 10000, query_timeout: 20000,
      options: '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=30000',
      application_name: 'mappr_a1_disposable_schema_test' });
    // Idle connection errors otherwise become unhandled events with raw details.
    client.on('error', () => { connectionFailed = true; });
    stage = 'read-only target verification';
    await client.connect();
    await client.query('BEGIN READ ONLY'); transaction = true;
    await assertDisposableTarget(client, config);
    await client.query('ROLLBACK'); transaction = false;

    stage = 'isolated transaction and second target verification';
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'); transaction = true;
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(57173, 1001) AS acquired');
    assert.equal(lock.rows[0].acquired, true, 'Another baseline test holds this disposable target');
    await assertDisposableTarget(client, config);
    stage = 'baseline transaction body';
    // Deliberately replace only the outer transaction boundary with our own:
    // no COMMIT is sent. All newly created objects/fixtures are rolled back.
    await client.query(transactionBody);

    stage = 'catalog tables and columns';
    const relations = await client.query(`SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls,
      c.relforcerowsecurity AS force_rls FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`);
    assert.deepEqual(relations.rows, [...tableNames].sort().map(name => ({ name, kind: 'r', rls: false, force_rls: false })));
    const result = await client.query(`SELECT c.relname AS table_name, a.attnum AS position, a.attname AS name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression, a.attidentity AS identity, a.attgenerated AS generated
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`);
    const expectedColumns = [...tableNames].sort().flatMap(name => tables[name].map((item, position) => ({
      table_name: name, position: position + 1, name: item.name,
      type: item.type === 'timestamptz' ? 'timestamp with time zone' : item.type,
      nullable: item.nullable, default_expression: item.defaultExpression, identity: '', generated: '',
    })));
    assert.deepEqual(result.rows, expectedColumns);

    stage = 'catalog constraints';
    const keys = await client.query(`SELECT c.relname AS "table", k.conname AS name, k.contype AS type,
      pg_catalog.pg_get_constraintdef(k.oid,true) AS definition, k.convalidated AS validated,
      k.condeferrable AS deferrable, k.condeferred AS initially_deferred
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
    assert.deepEqual(sortNamed(keys.rows.map(row => ({ ...row, definition: normalize(row.definition) }))),
      sortNamed(constraints.map(row => ({ ...row, validated: true, deferrable: false, initially_deferred: false }))));

    stage = 'catalog indexes and UUID dependency';
    const indexes = await client.query(`SELECT t.relname AS "table", i.relname AS name, x.indisunique AS "unique",
      x.indisprimary AS "primary", x.indisvalid AS valid, x.indisready AS ready, x.indnullsnotdistinct AS nulls_not_distinct,
      pg_catalog.pg_get_indexdef(x.indexrelid) AS definition FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'`);
    assert.deepEqual(sortNamed(indexes.rows.map(row => ({ ...row, definition: normalize(row.definition) }))),
      sortNamed(expectedIndexes.map(({ columns, ...row }) => ({ ...row, valid: true, ready: true, nulls_not_distinct: false }))));
    const extra = await client.query(`SELECT
      to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL AS uuid_available,
      (SELECT count(*)::integer FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS custom_triggers`);
    assert.deepEqual(extra.rows, [{ uuid_available: true, custom_triggers: 0 }]);

    stage = 'existing-object replay rejection';
    await client.query('SAVEPOINT replay_guard');
    await assert.rejects(client.query(transactionBody), error => error.code === 'P0001');
    await client.query('ROLLBACK TO SAVEPOINT replay_guard');

    stage = 'synthetic SET NULL and CASCADE semantics';
    const actor = randomUUID();
    const inserted = await client.query("INSERT INTO public.maps (anon_id,input_description,data) VALUES ($1,'A1 isolated fixture','{}'::jsonb) RETURNING id", [actor]);
    const fixtureMap = inserted.rows[0].id;
    await client.query('INSERT INTO public.generations (anon_id,map_id) VALUES ($1,$2)', [actor, fixtureMap]);
    await client.query("INSERT INTO public.map_versions (map_id,version,data,summary) VALUES ($1,1,'{}'::jsonb,'A1 fixture')", [fixtureMap]);
    for (const name of ['architecture_reviews', 'missing_requirement_reviews', 'traceability_reviews']) {
      const payload = name === 'traceability_reviews' ? 'links' : 'findings';
      await client.query(`INSERT INTO public.${name} (map_id,${payload}) VALUES ($1,'[]'::jsonb)`, [fixtureMap]);
    }
    for (const [name, payload] of [['api_contracts','endpoints'],['relational_schemas','tables'],['document_schemas','collections']]) {
      await client.query(`INSERT INTO public.${name} (map_id,version,${payload}) VALUES ($1,1,'[]'::jsonb)`, [fixtureMap]);
    }
    for (const [name, payload] of [['adrs','adrs'],['env_vars','vars']]) {
      await client.query(`INSERT INTO public.${name} (map_id,tech_arch_hash,${payload}) VALUES ($1,'a1-fixture','[]'::jsonb)`, [fixtureMap]);
    }
    await client.query("INSERT INTO public.readmes (map_id,version,overview,getting_started) VALUES ($1,1,'A1 fixture','[]'::jsonb)", [fixtureMap]);
    await client.query("INSERT INTO public.deployments (map_id,tech_arch_hash,components,environments,cicd_steps) VALUES ($1,'a1-fixture','[]'::jsonb,'[]'::jsonb,'[]'::jsonb)", [fixtureMap]);
    await client.query('DELETE FROM public.maps WHERE id=$1', [fixtureMap]);
    const usage = await client.query('SELECT count(*)::integer AS records, count(map_id)::integer AS "references" FROM public.generations');
    assert.deepEqual(usage.rows, [{ records: 1, references: 0 }]);
    for (const name of tableNames.filter(name => !['maps','generations'].includes(name))) {
      const remaining = await client.query(`SELECT count(*)::integer AS records FROM public.${name}`);
      assert.equal(remaining.rows[0].records, 0, 'Map deletion did not cascade');
    }
  } catch (error) {
    // pg errors can contain credentials, target names, SQL, or fixture IDs.
    const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'withheld';
    throw new Error(`Isolated schema test failed at ${stage}; error code ${code}. No raw connection or record details are logged.`);
  } finally {
    let cleanupFailed = false;
    try { if (transaction) await client.query('ROLLBACK'); } catch { cleanupFailed = true; }
    try { if (client) await client.end(); } catch { cleanupFailed = true; }
    if (cleanupFailed || connectionFailed) throw new Error('Disposable connection or cleanup failed; raw connection details withheld. No cleanup connection or destructive reset was attempted.');
  }
});
