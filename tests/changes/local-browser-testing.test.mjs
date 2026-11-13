import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalBrowserEnvironment, assertLocalBrowserRequest, localBrowserTestingEnabled } from '../../src/services/localBrowserTesting.ts';

const baseline = { ...process.env };
function setup() {
  for (const name of ['RENDER', 'RENDER_SERVICE_ID', 'VERCEL', 'K_SERVICE']) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: 'development', PORT: '4000', FRONTEND_ORIGIN: 'http://localhost:3000',
    MAPPR_LOCAL_CHANGES_TESTING: 'true', MAPPR_CHANGES_ENABLED: 'true', MAPPR_REVISION_WRITES_ENABLED: 'true', MAPPR_DAILY_ADMISSION_ENABLED: 'true', CHANGE_PROPOSAL_TTL_SECONDS: '900' });
}
const request = (overrides = {}, headers = {}) => ({ socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 4000 },
  path: '/maps/fixture/changes/preview', body: { context: { activeView: 'overview' } },
  get: name => ({ host: 'localhost:4000', ...headers })[name], ...overrides });
test.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(baseline, key)) delete process.env[key]; Object.assign(process.env, baseline); });

test('local test opt-in cannot authorize production, hosted, unset or other environments', async t => {
  for (const [key, value] of [['MAPPR_LOCAL_CHANGES_TESTING', 'false'], ['MAPPR_LOCAL_CHANGES_TESTING', 'TRUE'], ['NODE_ENV', 'production'],
    ['NODE_ENV', 'test'], ['NODE_ENV', ''], ['RENDER', 'true'], ['RENDER_SERVICE_ID', 'fixture'], ['VERCEL', '1'], ['K_SERVICE', 'fixture']]) {
    await t.test(key + '=' + value, () => { setup(); process.env[key] = value; assert.equal(localBrowserTestingEnabled(), false);
      assert.throws(assertLocalBrowserEnvironment); assert.throws(() => assertLocalBrowserRequest(request()), error => error.code === 'preview_policy_not_configured'); });
  }
});

test('local test startup requires port 4000, exact loopback frontend Origin, real safety flags and approved expiry', async t => {
  for (const [key, value] of [['PORT', '4001'], ['FRONTEND_ORIGIN', 'https://external.test'], ['FRONTEND_ORIGIN', 'http://localhost:3000/'],
    ['FRONTEND_ORIGIN', 'http://localhost.evil.test:3000'], ['FRONTEND_ORIGIN', ''], ['MAPPR_CHANGES_ENABLED', 'false'],
    ['MAPPR_REVISION_WRITES_ENABLED', 'false'], ['MAPPR_DAILY_ADMISSION_ENABLED', 'false'], ['CHANGE_PROPOSAL_TTL_SECONDS', '60']]) {
    await t.test(key + '=' + value, () => { setup(); process.env[key] = value; assert.throws(assertLocalBrowserEnvironment); });
  }
  setup(); assert.equal(assertLocalBrowserEnvironment().host, '127.0.0.1'); assert.doesNotThrow(() => assertLocalBrowserRequest(request()));
});

test('request gate checks actual loopback sockets and Host and rejects forwarded/proxy spoofing', async t => {
  setup(); assert.throws(() => assertLocalBrowserRequest(), error => error.code === 'preview_policy_not_configured');
  for (const socket of [{ remoteAddress: '192.0.2.1', localAddress: '127.0.0.1', localPort: 4000 },
    { remoteAddress: '127.0.0.1', localAddress: '192.0.2.2', localPort: 4000 },
    { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 80 }]) {
    assert.throws(() => assertLocalBrowserRequest(request({ socket })), error => error.code === 'preview_policy_not_configured');
  }
  for (const headers of [{ host: 'external.test:4000' }, { host: '127.0.0.1:4000' }, { 'x-forwarded-for': '127.0.0.1' },
    { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-host': 'localhost:4000' }, { 'x-forwarded-proto': 'http' }]) {
    await t.test(JSON.stringify(headers), () => assert.throws(() => assertLocalBrowserRequest(request({}, headers)), error => error.code === 'preview_policy_not_configured'));
  }
  assert.doesNotThrow(() => assertLocalBrowserRequest(request({ socket: { remoteAddress: '::ffff:127.0.0.1', localAddress: '127.0.0.1', localPort: 4000 } })));
});

test('local preview gate is scoped to the three requested views and does not authorize other contexts', () => {
  setup(); for (const activeView of ['overview', 'architecture', 'tech-stack']) assert.doesNotThrow(() => assertLocalBrowserRequest(request({ body: { context: { activeView } } })));
  for (const activeView of ['database', 'json', 'all']) assert.throws(() => assertLocalBrowserRequest(request({ body: { context: { activeView } } })), error => error.code === 'unsupported_scope');
});
