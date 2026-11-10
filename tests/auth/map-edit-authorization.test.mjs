import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import test, { mock } from 'node:test';

// Test-worker-only configuration. Never load .env, start index.ts, or use a
// database/provider connection. The pg fallback also throws before any I/O.
process.env.COOKIE_SECRET = 's2-fixture-signing-secret-not-a-deployment-secret';
process.env.FRONTEND_ORIGIN = 'https://frontend.mappr.test';
process.env.NODE_ENV = 'test';
process.env.MAPPR_REVISION_WRITES_ENABLED = 'false';
process.env.DATABASE_URL = 'mock-only-never-connect';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;

const origin = process.env.FRONTEND_ORIGIN;
const owner = randomUUID();
const other = randomUUID();
const mapId = randomUUID();
const absentMap = randomUUID();
const time = new Date('2026-11-07T10:00:00Z');
const system = {
  meta: { productName: 'S2 fixture', oneLineSummary: 'Test product' },
  product: { summary: 'An isolated authorization test.', concepts: [] },
  users: [], features: [], techStack: [], architecture: { nodes: [], edges: [] },
  dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] },
  developmentPlan: [],
};
const hash = createHash('sha256').update(JSON.stringify({ techStack: [], architecture: system.architecture })).digest('hex');
const patch = { addNodes: [], removeNodeIds: [], updateNodes: [], addEdges: [], removeEdges: [] };
let state;

function reset() {
  state = {
    maps: new Map([[mapId, { id: mapId, anon_id: owner, input_description: 'Original fixture description', data: structuredClone(system), created_at: time, updated_at: time }]]),
    records: new Map(), version: 2, queries: [], ownerChecks: 0, ai: [], quotaChecks: 0,
    usage: [], writes: 0, transactions: 0, commits: 0, failOwner: false,
  };
}

function stored(table) {
  return state.records.get(table) ?? { map_id: mapId, version: state.version, tech_arch_hash: hash,
    findings: [], links: [], endpoints: [], tables: [], collections: [], adrs: [], vars: [],
    overview: 'Mock overview', getting_started: [], components: [], environments: [], cicd_steps: [], migrations: null,
    created_at: time, updated_at: time };
}

async function query(text, values = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  state.queries.push({ sql, values });
  if (sql === 'SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2') {
    state.ownerChecks++;
    if (state.failOwner) throw new Error('Synthetic lookup failure');
    return { rows: state.maps.get(values[0])?.anon_id === values[1] ? [{}] : [] };
  }
  if (sql === 'BEGIN') { state.transactions++; return { rows: [] }; }
  if (sql === 'COMMIT') { state.commits++; return { rows: [] }; }
  if (sql === 'ROLLBACK') return { rows: [] };
  if (sql === 'SELECT 1') return { rows: [{}] };
  if (/^SELECT .* FROM maps WHERE id = \$1(?: FOR UPDATE)?$/.test(sql)) {
    const row = state.maps.get(values[0]);
    return { rows: row ? [row] : [] };
  }
  if (/^SELECT COALESCE\(MAX\(version\)/.test(sql)) return { rows: [{ version: state.version, max_version: state.version }] };
  if (sql.startsWith('SELECT version, data FROM map_versions')) return { rows: [1, 2].map(version => ({ version, data: system })) };
  if (sql.startsWith('SELECT version, summary, created_at FROM map_versions')) return { rows: [{ version: state.version, summary: 'Fixture version', created_at: time }] };
  if (sql.startsWith('INSERT INTO maps ')) {
    state.writes++;
    const id = randomUUID();
    const row = { id, anon_id: values[0], input_description: values[1], data: values[2], created_at: time, updated_at: time };
    state.maps.set(id, row);
    return { rows: [row] };
  }
  if (sql.startsWith('INSERT INTO generations ')) {
    state.writes++; state.usage.push({ anonId: values[0], mapId: values[1] }); return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO map_versions ')) {
    state.writes++; state.version = Number(values[1]); return { rows: [] };
  }
  if (sql.startsWith('UPDATE maps SET data')) {
    state.writes++; state.maps.get(values[1]).data = JSON.parse(values[0]); return { rows: [] };
  }
  const insert = sql.match(/^INSERT INTO (\w+)/);
  if (insert) {
    state.writes++;
    const table = insert[1];
    const row = { ...stored(table), map_id: values[0] };
    const payload = { architecture_reviews: 'findings', missing_requirement_reviews: 'findings', traceability_reviews: 'links' }[table];
    if (payload) row[payload] = JSON.parse(values[1]);
    else if (['api_contracts', 'relational_schemas', 'document_schemas'].includes(table)) {
      row.version = values[1]; row[{ api_contracts: 'endpoints', relational_schemas: 'tables', document_schemas: 'collections' }[table]] = JSON.parse(values[2]);
    } else if (table === 'readmes') {
      row.version = values[1]; row.overview = values[2]; row.getting_started = JSON.parse(values[3]);
    } else if (['adrs', 'env_vars'].includes(table)) {
      row.tech_arch_hash = values[1]; row[table === 'adrs' ? 'adrs' : 'vars'] = JSON.parse(values[2]);
    } else if (table === 'deployments') {
      row.tech_arch_hash = values[1]; row.components = JSON.parse(values[2]); row.environments = JSON.parse(values[3]); row.cicd_steps = JSON.parse(values[4]); row.migrations = values[5];
    } else throw new Error('Unsupported synthetic insert');
    state.records.set(table, row);
    return { rows: [row] };
  }
  const update = sql.match(/^UPDATE (architecture_reviews|missing_requirement_reviews) /);
  if (update) { state.writes++; return { rows: [stored(update[1])] }; }
  const select = sql.match(/ FROM (architecture_reviews|missing_requirement_reviews|traceability_reviews|api_contracts|relational_schemas|document_schemas|adrs|readmes|env_vars|deployments) WHERE /);
  if (select) return { rows: [stored(select[1])] };
  throw new Error('Unexpected query in isolated database mock');
}

mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real database initialization is forbidden in S2 tests'); } } } });
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: { pool: { query, connect: async () => ({ query, release() {} }) } } });
mock.module(new URL('../../src/services/rateLimit.ts', import.meta.url).href, { namedExports: { checkRateLimits: async () => { state.quotaChecks++; return { allowed: true }; } } });
class AIGenerationError extends Error {}
mock.module(new URL('../../src/services/aiClient.ts', import.meta.url).href, { namedExports: {
  AIGenerationError,
  generateStructured: async ({ groqSchemaName }) => {
    state.ai.push(groqSchemaName);
    const payload = {
      mappr_system: system, architecture_iteration: { summary: 'Mock architecture update', patch },
      architecture_review: { findings: [] }, requirements_review: { findings: [] }, traceability: { links: [] },
      api_contract: { endpoints: [] }, relational_schema: { tables: [] }, document_schema: { collections: [] },
      adr_set: { adrs: [] }, readme: { overview: 'Mock overview', gettingStarted: [] },
      env_vars: { vars: [] }, deployment_runbook: { components: [], environments: [], cicdSteps: [], migrations: null },
    }[groqSchemaName];
    assert.ok(payload, 'Unmocked AI schema');
    return structuredClone(payload);
  },
} });

const { createApp } = await import('../../src/app.ts');
const { mutationOrigin } = await import('../../src/middleware/mutationOrigin.ts');
const signCookie = id => `${id}.${createHmac('sha256', process.env.COOKIE_SECRET).update(id).digest('hex')}`;
const cookie = value => `mappr_anon=${encodeURIComponent(value)}`;
const ownerCookie = cookie(signCookie(owner));
const otherCookie = cookie(signCookie(other));

const reviewKeys = ['mapId', 'findings', 'createdAt', 'updatedAt'];
const mutations = [
  ['POST', 'iterate', { instruction: 'Update the architecture description.' }, ['mapId','version','summary','patch','data']],
  ['POST', 'critique', {}, reviewKeys],
  ['POST', 'requirements', {}, reviewKeys],
  ['POST', 'traceability', {}, ['mapId','links','createdAt','updatedAt']],
  ['POST', 'api-contract', {}, ['mapId','version','endpoints','createdAt','updatedAt']],
  ['POST', 'relational-schema', {}, ['mapId','version','tables','createdAt','updatedAt']],
  ['POST', 'document-schema', {}, ['mapId','version','collections','createdAt','updatedAt']],
  ['POST', 'adrs', {}, ['mapId','techArchHash','adrs','createdAt','updatedAt']],
  ['POST', 'readme', {}, ['mapId','version','overview','gettingStarted','createdAt','updatedAt']],
  ['POST', 'env-vars', {}, ['mapId','techArchHash','vars','createdAt','updatedAt']],
  ['POST', 'deployment', {}, ['mapId','techArchHash','components','environments','cicdSteps','migrations','createdAt','updatedAt']],
  ['PATCH', 'critique/findings/test-finding', { dismissed: true }, reviewKeys],
  ['PATCH', 'requirements/findings/test-finding', { dismissed: false }, reviewKeys],
];

test('S2 real-router authorization with isolated database/provider mocks', { timeout: 60000 }, async t => {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  async function request(method, path, { session, body, headers = {} } = {}) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
        ...(session ? { cookie: session } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}), ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, data: text && res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Local test request timeout')));
      req.on('error', reject);
      req.end(encoded);
    });
  }
  function assertNoMutation() {
    assert.equal(state.ai.length, 0); assert.equal(state.quotaChecks, 0);
    assert.equal(state.writes, 0); assert.equal(state.transactions, 0);
  }

  await t.test('inventory includes every current existing-map mutation', () => {
    const routes = new URL('../../src/routes/', import.meta.url);
    const found = readdirSync(routes).flatMap(name => [...readFileSync(new URL(name, routes), 'utf8').matchAll(/router\.(post|patch|put|delete)\('\/maps\/:id\/([^']+)'/g)].map(match => `${match[1].toUpperCase()} ${match[2].replace(':findingId','test-finding')}`));
    assert.deepEqual(found.sort(), mutations.map(([method, suffix]) => `${method} ${suffix}`).sort());
  });

  for (const [method, suffix, body, keys] of mutations) {
    await t.test(`owner preserves ${method} ${suffix} success contract`, async () => {
      reset();
      const result = await request(method, `/maps/${mapId}/${suffix}`, { session: ownerCookie, body, headers: { origin } });
      assert.equal(result.status, method === 'PATCH' ? 200 : 201);
      assert.deepEqual(Object.keys(result.data).sort(), [...keys].sort());
      assert.equal(result.data.mapId, mapId);
      assert.equal(state.ownerChecks, 1);
      assert.equal(state.ai.length, method === 'PATCH' ? 0 : 1);
      assert.equal(state.usage.length, method === 'PATCH' ? 0 : 1);
      assert.equal(state.maps.get(mapId).anon_id, owner);
      assert.equal(result.headers['access-control-allow-origin'], origin);
      assert.equal(result.headers['access-control-allow-credentials'], 'true');
    });
    await t.test(`other session cannot spoof ownership: ${method} ${suffix}`, async () => {
      reset();
      const result = await request(method, `/maps/${mapId}/${suffix}?anonId=${owner}`, { session: otherCookie, body: { ...body, anonId: owner, ownerId: owner }, headers: { origin, 'x-owner-id': owner } });
      assert.equal(result.status, 404); assert.deepEqual(result.data, { error: 'not_found' });
      assert.equal(state.ownerChecks, 1); assert.equal(state.queries.length, 1); assertNoMutation();
      assert.equal(state.queries[0].values[1], other);
    });
    await t.test(`unknown map stays indistinguishable: ${method} ${suffix}`, async () => {
      reset();
      const result = await request(method, `/maps/${absentMap}/${suffix}`, { session: ownerCookie, body });
      assert.equal(result.status, 404); assert.deepEqual(result.data, { error: 'not_found' });
      assert.equal(state.queries.length, 1); assertNoMutation();
    });
  }

  await t.test('missing/invalid/newly replaced sessions cannot mutate any existing map', async () => {
    const badCookies = [undefined, cookie(`${owner}.${'0'.repeat(64)}`), cookie(signCookie('not-a-uuid')), cookie(`${signCookie(owner)}.extra`), cookie('j:{"unexpected":true}'), cookie('j:42')];
    for (const session of badCookies) for (const [method, suffix, body] of mutations) {
      reset();
      const result = await request(method, `/maps/${mapId}/${suffix}`, { session, body });
      assert.equal(result.status, 401); assert.deepEqual(result.data, { error: 'session_required' });
      assert.ok(result.headers['set-cookie']); assert.equal(state.queries.length, 0); assertNoMutation();
    }
  });

  await t.test('malformed map IDs and database authorization failures fail closed', async () => {
    reset();
    const malformed = await request('POST', '/maps/not-a-uuid/critique', { session: ownerCookie, body: {} });
    assert.equal(malformed.status, 404); assert.equal(state.queries.length, 0); assertNoMutation();
    state.failOwner = true;
    const errorLog = mock.method(console, 'error', () => {});
    try {
      const failed = await request('POST', `/maps/${mapId}/critique`, { session: ownerCookie, body: {} });
      assert.equal(failed.status, 500); assert.deepEqual(failed.data, { error: 'internal_error' });
      assert.deepEqual(errorLog.mock.calls[0].arguments, ['Map ownership verification failed']); assertNoMutation();
    } finally { errorLog.mock.restore(); }
  });

  await t.test('edit eligibility: established owner receives only uncached permission with credentialed CORS', async () => {
    reset();
    const result = await request('GET', `/maps/${mapId}/edit-eligibility`, { session: ownerCookie, headers: { origin } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { mapId, canEdit: true });
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers.vary, /Cookie/i);
    assert.equal(result.headers['access-control-allow-origin'], origin);
    assert.equal(result.headers['access-control-allow-credentials'], 'true');
    assert.equal(state.ownerChecks, 1); assert.equal(state.queries.length, 1);
    assert.deepEqual(state.queries[0], { sql: 'SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2', values: [mapId, owner] });
    assert.equal(result.text.includes(owner), false); assert.equal(result.text.includes('anon_id'), false);
    assertNoMutation();
  });

  await t.test('edit eligibility: missing, invalid, and same-request replacement cookies are 401', async () => {
    const sessions = [undefined, cookie(`${owner}.${'0'.repeat(64)}`), cookie(signCookie('not-a-uuid')), cookie(`${signCookie(owner)}.extra`), cookie('j:{"unexpected":true}'), cookie('j:42')];
    for (const session of sessions) {
      reset();
      const result = await request('GET', `/maps/${mapId}/edit-eligibility`, { session, headers: { origin } });
      assert.equal(result.status, 401); assert.deepEqual(result.data, { error: 'session_required' });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.ok(result.headers['set-cookie']); assert.equal(state.queries.length, 0); assertNoMutation();
      // A later request can establish this replacement identity, but it still
      // cannot become the existing map's owner merely by receiving a cookie.
      const replacement = result.headers['set-cookie'][0].split(';')[0];
      const retried = await request('GET', `/maps/${mapId}/edit-eligibility`, { session: replacement });
      assert.equal(retried.status, 404); assert.deepEqual(retried.data, { error: 'not_found' });
      assert.equal(retried.headers['cache-control'], 'no-store'); assertNoMutation();
    }
  });

  await t.test('edit eligibility: non-owner, unknown, and malformed maps are indistinguishable 404s', async () => {
    for (const [target, session, expectedQueries] of [[mapId, otherCookie, 1], [absentMap, ownerCookie, 1], ['not-a-uuid', ownerCookie, 0]]) {
      reset();
      const result = await request('GET', `/maps/${target}/edit-eligibility?anonId=${owner}`, {
        session, body: { anonId: owner, ownerId: owner }, headers: { origin, 'x-owner-id': owner },
      });
      assert.equal(result.status, 404); assert.deepEqual(result.data, { error: 'not_found' });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.text.includes(owner), false); assert.equal(result.text.includes(target), false);
      assert.equal(state.queries.length, expectedQueries); assertNoMutation();
      if (session === otherCookie) assert.equal(state.queries[0].values[1], other);
    }
  });

  await t.test('edit eligibility: lookup failures return an uncached generic 500 without leaking errors', async () => {
    reset(); state.failOwner = true;
    const errorLog = mock.method(console, 'error', () => {});
    try {
      const result = await request('GET', `/maps/${mapId}/edit-eligibility`, { session: ownerCookie });
      assert.equal(result.status, 500); assert.deepEqual(result.data, { error: 'internal_error' });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.deepEqual(errorLog.mock.calls[0].arguments, ['Map edit eligibility verification failed']);
      assert.equal(result.text.includes(owner), false); assertNoMutation();
    } finally { errorLog.mock.restore(); }
  });

  await t.test('edit eligibility: rechecks current ownership and never personalizes shared map reads', async () => {
    reset();
    assert.equal((await request('GET', `/maps/${mapId}/edit-eligibility`, { session: ownerCookie })).status, 200);
    state.maps.get(mapId).anon_id = other; // In-memory fixture only; no ownership-transfer API.
    const changed = await request('GET', `/maps/${mapId}/edit-eligibility`, { session: ownerCookie });
    assert.equal(changed.status, 404); assert.equal(state.ownerChecks, 2); assertNoMutation();
    reset();
    for (const session of [undefined, otherCookie]) {
      const shared = await request('GET', `/maps/${mapId}`, { session });
      assert.equal(shared.status, 200);
      assert.deepEqual(Object.keys(shared.data).sort(), ['id','inputDescription','data','createdAt','updatedAt'].sort());
      assert.equal(shared.headers['cache-control'], undefined);
    }
    assert.equal(state.ownerChecks, 0); assertNoMutation();
  });

  await t.test('all GET/share-link paths stay readable without owner authorization', async () => {
    const suffixes = ['', '/versions', '/diff?from=1&to=2', '/critique', '/requirements', '/traceability', '/api-contract', '/relational-schema', '/relational-schema/sql?dialect=postgres', '/document-schema', '/document-schema/script', '/adrs', '/adrs/markdown', '/readme', '/readme/markdown', '/env-vars', '/env-vars/file', '/deployment', '/deployment/markdown'];
    for (const session of [undefined, otherCookie]) for (const suffix of suffixes) {
      reset();
      const result = await request('GET', `/maps/${mapId}${suffix}`, { session });
      assert.equal(result.status, 200, `Read failed: ${suffix}`);
      assert.equal(state.ownerChecks, 0); assertNoMutation();
      if (!suffix) assert.deepEqual(Object.keys(result.data).sort(), ['id','inputDescription','data','createdAt','updatedAt'].sort());
    }
    reset();
    assert.equal((await request('HEAD', `/maps/${mapId}`)).status, 200);
    assert.equal((await request('GET', `/maps/${mapId}`, { headers: { origin: 'https://another.mappr.test' } })).status, 200);
    assert.equal(state.ownerChecks, 0); assertNoMutation();
  });

  await t.test('new-map generation binds both fresh and established sessions without changing response shape', async () => {
    for (const session of [undefined, ownerCookie, cookie('j:{"invalid":true}')]) {
      reset();
      const result = await request('POST', '/generate', { session, body: { description: 'A sufficiently detailed mock product description.' }, headers: { origin } });
      assert.equal(result.status, 201);
      assert.deepEqual(Object.keys(result.data).sort(), ['id','createdAt','updatedAt','data'].sort());
      let expectedOwner = owner;
      if (session !== ownerCookie) {
        const issued = result.headers['set-cookie'][0];
        const packed = decodeURIComponent(issued.split(';')[0].slice('mappr_anon='.length));
        expectedOwner = packed.split('.')[0];
        assert.equal(packed === signCookie(expectedOwner), true);
        assert.match(issued, /HttpOnly/); assert.match(issued, /SameSite=Lax/);
      }
      assert.equal(state.maps.get(result.data.id).anon_id === expectedOwner, true);
      assert.equal(state.usage[0].anonId === expectedOwner, true);
      assert.equal(state.ownerChecks, 0); assert.equal(state.ai.length, 1); assert.equal(state.commits, 1);
    }
  });

  await t.test('origin safety blocks untrusted/opaque browser mutations but preserves originless CLI and preflight', async () => {
    for (const headers of [{ origin: 'https://attacker.mappr.test' }, { origin: 'null' }, { origin: `${origin}/` }, { 'sec-fetch-site': 'same-site' }, { referer: `${origin}/page` }]) {
      for (const target of [`/maps/${mapId}/critique`, '/generate']) {
        reset();
        const result = await request('POST', target, { session: ownerCookie, body: {}, headers });
        assert.equal(result.status, 403); assert.deepEqual(result.data, { error: 'origin_not_allowed' });
        assert.equal(state.queries.length, 0); assertNoMutation();
      }
    }
    reset();
    assert.equal((await request('POST', `/maps/${mapId}/critique`, { session: ownerCookie, body: {} })).status, 201);
    const options = await request('OPTIONS', `/maps/${mapId}/iterate`, { headers: { origin, 'access-control-request-method': 'POST' } });
    assert.equal(options.status, 204); assert.equal(options.headers['access-control-allow-credentials'], 'true');
  });

  await t.test('unconfigured/invalid frontend origins reject browser origins without blocking CLI', () => {
    for (const configured of [undefined, 'not-an-origin', `${origin}/`]) {
      let status, body, proceeded;
      const guard = mutationOrigin(configured);
      const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
      guard({ method: 'POST', get: header => header === 'origin' ? origin : undefined }, response, () => { proceeded = true; });
      assert.equal(status, 403); assert.deepEqual(body, { error: 'origin_not_allowed' }); assert.equal(proceeded, undefined);
      guard({ method: 'POST', get: () => undefined }, response, () => { proceeded = true; });
      assert.equal(proceeded, true);
    }
  });
});
