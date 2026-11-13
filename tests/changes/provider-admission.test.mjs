import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Worker-only fixture credentials. No dotenv, private inputs, sockets, real
// SDKs or PostgreSQL connections. Any accidental fetch is forbidden too.
process.env.GEMINI_API_KEY = 's4c-fixture-gemini-not-a-real-key';
process.env.GROQ_API_KEY = 's4c-fixture-groq-not-a-real-key';
process.env.GEMINI_MODEL = 'fixture-gemini';
process.env.FREE_DAILY_LIMIT = '2'; process.env.GLOBAL_DAILY_CEILING = '200';
process.env.DATABASE_URL = 'never-connect';
globalThis.fetch = async () => { throw new Error('Real network forbidden'); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const base = { meta: { productName: 'Private fixture', oneLineSummary: 'Keep tagline' }, product: { summary: 'Original', concepts: [] },
  users: [], features: [], techStack: [], architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [] };
let gemini, groq, calls = [], constructors = 0, counts = { user: 0, global: 0 }, queries = [];
const userText = 'private-sentinel-untrusted-instruction';
const valid = summary => ({ text: JSON.stringify({ summary }) });
function reset() { calls = []; queries = []; counts = { user: 0, global: 0 };
  gemini = async () => valid('Generated summary'); groq = async () => ({ choices: [{ message: { content: JSON.stringify({ summary: 'Fallback summary' }) } }] }); }
reset();
mock.module('@google/genai', { namedExports: { GoogleGenAI: class {
  constructor() { constructors++; }
  models = { generateContent: async request => { calls.push({ provider: 'gemini', request }); return gemini(request); } };
} } });
mock.module('groq-sdk', { defaultExport: class {
  constructor() { constructors++; }
  chat = { completions: { create: async (request, options) => { calls.push({ provider: 'groq', request, options }); return groq(request, options); } } };
} });
mock.module('pg', { namedExports: { Pool: class { constructor() { throw new Error('Real PostgreSQL forbidden'); } } } });
async function query(sql, args) { queries.push({ sql, args }); return { rows: [{ count: sql.includes('WHERE anon_id') ? counts.user : counts.global }] }; }
mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: { pool: { query } } });
const { createOverviewProvider, generateOverviewSummary } = await import('../../src/services/changes/provider.ts');
// Real shared fallback/validation implementation, with only its SDK transports mocked.
const { generateStructured, AIGenerationError } = await import('../../src/services/aiClient.ts');
const { createPreviewAdmission, blockedPreviewAdmission } = await import('../../src/services/changes/admission.ts');
const { checkRateLimits, FREE_DAILY_LIMIT, GLOBAL_DAILY_CEILING } = await import('../../src/services/rateLimit.ts');
const { SummaryOutputSchema } = await import('../../src/schema/changeProposal.ts');
const { createArchitectureProvider, createTechStackProvider, createDatabaseProvider } = await import('../../src/services/changes/provider.ts');
const signal = () => new AbortController().signal;
const refuses = (work, code) => assert.rejects(work, error => error.code === code);
const quiet = async work => { const log = mock.method(console, 'error', () => {}); try { return await work(log); } finally { log.mock.restore(); } };

test('S4C real adapter calls shared Gemini with the exact strict summary prompt/schema and cancellation options', async () => {
  reset(); const before = structuredClone(base); const output = await generateOverviewSummary(base, userText, signal());
  assert.deepEqual(output, { summary: 'Generated summary' }); assert.deepEqual(base, before); assert.equal(calls.length, 1);
  assert.equal(constructors, 2); const request = calls[0].request;
  assert.equal(request.model, 'fixture-gemini'); assert.match(request.contents, /only a replacement product.summary/);
  assert.match(request.contents, /untrusted data/); assert.ok(request.contents.includes(userText)); assert.ok(request.contents.includes('Keep tagline'));
  assert.deepEqual(request.config.responseSchema.required, ['summary']); assert.deepEqual(Object.keys(request.config.responseSchema.properties), ['summary']);
  assert.ok(request.config.abortSignal instanceof AbortSignal); assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
});

const architectureOutput={operations:[{op:'upsert_item',collection:'architecture.nodes',value:{id:'api',label:'API',type:'service',description:'API service'}}]};
test('S4F Architecture adapter uses shared structured providers, strict scoped operations and selected-node context',async()=>{
 reset();gemini=async()=>({text:JSON.stringify(architectureOutput)});
 const generate=createArchitectureProvider(),context={activeView:'architecture',selectedTarget:{kind:'architecture_node',id:'api'}};
 assert.deepEqual(await generate(base,userText,signal(),context),architectureOutput);assert.equal(calls.length,1);
 assert.match(calls[0].request.contents,/untrusted data/);assert.ok(calls[0].request.contents.includes(JSON.stringify(context)));
 assert.deepEqual(calls[0].request.config.responseSchema.required,['operations']);assert.ok(calls[0].request.config.responseSchema.properties.operations.items.anyOf.length===3);
 assert.ok(calls[0].request.config.abortSignal instanceof AbortSignal);
});
test('S4F Architecture malformed operations correct/fallback without accepting a root replacement or leaking text',async()=>quiet(async log=>{
 reset();let n=0;gemini=async()=>({text:JSON.stringify(++n===1?{...architectureOutput,summary:userText}:architectureOutput)});
 const generate=createArchitectureProvider();assert.deepEqual(await generate(base,userText,signal(),{activeView:'architecture',selectedTarget:null}),architectureOutput);
 assert.equal(calls.length,2);assert.match(calls[1].request.contents,/previous response did not match the schema/);
 reset();gemini=async()=>{throw new Error(userText)};groq=async()=>({choices:[{message:{content:JSON.stringify(architectureOutput)}}]});
 assert.deepEqual(await generate(base,userText,signal(),{activeView:'architecture',selectedTarget:null}),architectureOutput);
 const request=calls.find(c=>c.provider==='groq').request;assert.equal(request.response_format.json_schema.name,'architecture_change');
 assert.equal(request.response_format.json_schema.schema.additionalProperties,false);assert.equal(JSON.stringify(log.mock.calls).includes(userText),false);
 const parent=new AbortController();parent.abort();await refuses(()=>generate(base,userText,parent.signal,{activeView:'architecture',selectedTarget:null}),'generation_timeout');
}));

test('S4C extra keys/blank/oversized/wrong-type outputs are rejected then corrected through existing validation retry', async t => {
  for (const [name, invalid] of [['extra', { summary: 'Text', mapId: 'not-allowed' }], ['blank', { summary: ' ' }],
    ['oversized', { summary: 'x'.repeat(4001) }], ['wrong-type', { summary: 7 }], ['replacement', base]]) await t.test(name, async () => {
    reset(); let n = 0; gemini = async () => ++n === 1 ? { text: JSON.stringify(invalid) } : valid('  Corrected summary  ');
    const result = await generateOverviewSummary(base, userText, signal()); assert.deepEqual(result, { summary: 'Corrected summary' });
    assert.equal(calls.length, 2); assert.match(calls[1].request.contents, /previous response did not match the schema/);
    assert.doesNotMatch(calls[1].request.contents, /Unrecognized key|Invalid input/);
  });
});

test('S4C provider fallback preserves the existing Groq order, strict schema and request token cap', async () => quiet(async log => {
  reset(); gemini = async () => { throw new Error(userText); };
  groq = async request => {
    if (request.model !== 'qwen/qwen3.8-27b') throw new Error(userText);
    return { choices: [{ message: { content: JSON.stringify({ summary: 'Last configured fallback' }) } }] };
  };
  assert.deepEqual(await generateOverviewSummary(base, userText, signal()), { summary: 'Last configured fallback' });
  assert.deepEqual(calls.filter(c => c.provider === 'groq').map(c => c.request.model), ['openai/gpt-oss-20b','openai/gpt-oss-120b','qwen/qwen3.8-27b']);
  for (const call of calls.filter(c => c.provider === 'groq')) {
    assert.equal(call.options.maxRetries, 0); assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.request.max_completion_tokens, 6000); assert.equal(call.request.response_format.json_schema.name, 'overview_summary');
    assert.equal(call.request.response_format.json_schema.schema.additionalProperties, false);
  }
  assert.equal(JSON.stringify(log.mock.calls).includes(userText), false);
}));

test('S4C exhausted providers and malformed JSON yield sanitized failure without leaking output/key/prompt', async () => quiet(async log => {
  reset(); gemini = async () => ({ text: '{' + userText }); groq = async () => { throw new Error(userText); };
  await refuses(() => generateOverviewSummary(base, userText, signal()), 'change_generation_failed');
  assert.equal(calls.length, 4); const output = JSON.stringify(log.mock.calls);
  for (const secret of [userText, process.env.GEMINI_API_KEY, process.env.GROQ_API_KEY]) assert.equal(output.includes(secret), false);
}));

test('S4C repeated invalid structured output exhausts bounded correction/fallback without arbitrary operations', async () => quiet(async () => {
  reset(); gemini = async () => ({ text: JSON.stringify({ summary: 'Text', operations: [] }) });
  groq = async () => ({ choices: [{ message: { content: JSON.stringify({ summary: ' ' }) } }] });
  await refuses(() => generateOverviewSummary(base, userText, signal()), 'change_generation_failed');
  assert.equal(calls.length, 8, 'One initial output plus one schema correction per existing provider');
}));

test('S4C deadline stops fallback even if the SDK ignores cancellation; late failures are consumed', async () => {
  reset(); const late = deferred(); gemini = () => late.promise;
  const generator = createOverviewProvider({ timeoutMs: 10 });
  await refuses(() => generator(base, userText, signal()), 'generation_timeout');
  assert.equal(calls.length, 1); assert.equal(calls[0].request.config.abortSignal.aborted, true);
  late.reject(new Error(userText)); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
});

test('S4C parent cancellation prevents starting requests and interrupts transient retry delay', async () => {
  reset(); const already = new AbortController(); already.abort();
  await refuses(() => generateOverviewSummary(base, userText, already.signal), 'generation_timeout'); assert.equal(calls.length, 0);
  const abort = new AbortController(), attempted = deferred();
  gemini = async () => { attempted.resolve(); throw Object.assign(new Error(userText), { status: 503 }); };
  const pending = generateOverviewSummary(base, userText, abort.signal); await attempted.promise;
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await refuses(() => pending, 'generation_timeout'); assert.equal(calls.length, 1);
});

test('S4C cancellation during schema correction cannot start another provider', async () => {
  reset(); const abort = new AbortController(); gemini = async () => { abort.abort(); return { text: JSON.stringify({ summary: ' ', extra: 'secret' }) }; };
  await refuses(() => generateOverviewSummary(base, userText, abort.signal), 'generation_timeout'); assert.equal(calls.length, 1);
});

test('legacy shared generator callers retain SDK options, model selection and error class behavior', async () => quiet(async () => {
  reset(); const config = { buildPrompt: () => 'Synthetic legacy prompt', zodSchema: SummaryOutputSchema,
    geminiResponseSchema: { type: 'OBJECT' }, groqSchemaName: 'legacy_fixture' };
  await generateStructured(config); assert.equal(calls[0].request.config.abortSignal, undefined); assert.equal(calls[0].request.config.httpOptions, undefined);
  reset(); gemini = async () => { throw new Error('Synthetic failure'); };
  await generateStructured(config); assert.equal(calls.find(c => c.provider === 'groq').options, undefined);
  reset(); gemini = async () => { throw new Error('Synthetic failure'); }; groq = async () => { throw new Error('Synthetic failure'); };
  await assert.rejects(() => generateStructured(config), error => error instanceof AIGenerationError);
}));

test('admission reuses the existing daily ceilings/day boundary and supplied transaction client', async () => {
  reset(); assert.equal(FREE_DAILY_LIMIT, 2); assert.equal(GLOBAL_DAILY_CEILING, 200);
  assert.deepEqual(await checkRateLimits('fixture-actor'), { allowed: true }); assert.equal(queries.length, 2);
  assert.ok(queries.every(q => q.sql.includes("date_trunc('day', now())")));
  counts.user = 2; assert.deepEqual(await checkRateLimits('fixture-actor'), { allowed: false, reason: 'user_limit' });
  counts.global = 200; assert.deepEqual(await checkRateLimits('fixture-actor'), { allowed: false, reason: 'global_limit' });
  const events = [], client = { query: async (sql, args) => { events.push({ sql, args }); return { rows: [{ count: 0 }] }; } };
  await checkRateLimits('fixture-actor', client); assert.equal(events.length, 2);
});

test('unconfigured admission always refuses before quota reads/reservations, independent of flags', async () => {
  reset(); assert.throws(blockedPreviewAdmission.assertConfigured, e => e.code === 'preview_policy_not_configured');
  await refuses(() => blockedPreviewAdmission.reserve({ query }, {}), 'preview_policy_not_configured'); assert.equal(queries.length, 0);
});

const databaseOutput = { operations: [{ op: 'upsert_item', collection: 'dataModel.entities', value: {
  id: 'user', name: 'Account', fields: [{ name: 'id', type: 'uuid' }, { name: 'email', type: 'string' }] } }] };
const databaseContext = { activeView: 'database', selectedTarget: { kind: 'entity', id: 'user' } };
test('S4H Database adapter uses shared Gemini with actual canonical entity/field/cardinality schema and context', async () => {
  reset(); gemini = async () => ({ text: JSON.stringify(databaseOutput) }); const before = structuredClone(base);
  assert.deepEqual(await createDatabaseProvider()(base, userText, signal(), databaseContext), databaseOutput); assert.deepEqual(base, before); assert.equal(calls.length, 1);
  const request = calls[0].request; assert.match(request.contents, /untrusted data/); assert.ok(request.contents.includes(JSON.stringify(databaseContext)));
  assert.match(request.contents, /not generated relational\/document schemas/); assert.ok(request.contents.includes(userText));
  const alternatives = request.config.responseSchema.properties.operations.items.anyOf; assert.equal(alternatives.length, 3);
  assert.deepEqual(alternatives[0].properties.value.required, ['id', 'name', 'fields']);
  assert.deepEqual(alternatives[2].properties.value.items.properties.type.enum, ['one-to-one', 'one-to-many', 'many-to-many']);
  assert.ok(request.config.abortSignal instanceof AbortSignal);
});

test('S4H Database adapter rejects physical-schema fields then corrects/falls back using existing strict providers', async () => quiet(async log => {
  reset(); let n = 0; gemini = async () => ({ text: JSON.stringify(++n === 1 ? { ...databaseOutput, sql: userText } : databaseOutput) });
  const generate = createDatabaseProvider(); assert.deepEqual(await generate(base, userText, signal(), databaseContext), databaseOutput);
  assert.equal(calls.length, 2); assert.match(calls[1].request.contents, /previous response did not match the schema/);
  reset(); gemini = async () => { throw new Error(userText); }; groq = async () => ({ choices: [{ message: { content: JSON.stringify(databaseOutput) } }] });
  assert.deepEqual(await generate(base, userText, signal(), databaseContext), databaseOutput);
  const call = calls.find(value => value.provider === 'groq'); assert.equal(call.request.response_format.json_schema.name, 'database_change');
  assert.equal(call.request.response_format.json_schema.schema.additionalProperties, false); assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(log.mock.calls).includes(userText), false);
}));

test('S4H Database repeated invalid output and timeout are bounded, sanitized and never accepted as SQL', async () => quiet(async log => {
  reset(); const invalid = { operations: [{ op: 'upsert_item', collection: 'dataModel.entities', value: { id: 'u', name: 'User', fields: [{ name: 'id', type: 'uuid', primaryKey: true }] } }] };
  gemini = async () => ({ text: JSON.stringify(invalid) }); groq = async () => ({ choices: [{ message: { content: JSON.stringify(invalid) } }] });
  await refuses(() => createDatabaseProvider()(base, userText, signal(), databaseContext), 'change_generation_failed'); assert.equal(calls.length, 8);
  assert.equal(JSON.stringify(log.mock.calls).includes(userText), false);
  reset(); const abort = new AbortController(); abort.abort(); await refuses(() => createDatabaseProvider()(base, userText, abort.signal, databaseContext), 'generation_timeout'); assert.equal(calls.length, 0);
  const late = deferred(); gemini = () => late.promise;
  await refuses(() => createDatabaseProvider({ timeoutMs: 10 })(base, userText, signal(), databaseContext), 'generation_timeout');
  assert.equal(calls.length, 1); assert.equal(calls[0].request.config.abortSignal.aborted, true); late.reject(new Error(userText)); await new Promise(done => setImmediate(done));
}));

const techStackOutput = { operations: [{ op: 'upsert_item', collection: 'techStack', value: {
  category: 'Database', choice: 'SQLite', rationale: 'Embedded local persistence.' } }] };
const stackContext = { activeView: 'tech-stack', selectedTarget: null };
test('S4G Tech Stack uses the real shared Gemini adapter with canonical schema, context and cancellation', async () => {
  reset(); gemini = async () => ({ text: JSON.stringify(techStackOutput) });
  const before = structuredClone(base), output = await createTechStackProvider()(base, userText, signal(), stackContext);
  assert.deepEqual(output, techStackOutput); assert.deepEqual(base, before); assert.equal(calls.length, 1);
  const req = calls[0].request; assert.match(req.contents, /untrusted data/); assert.match(req.contents, /change only techStack/);
  assert.ok(req.contents.includes(JSON.stringify(stackContext))); assert.ok(req.contents.includes(userText));
  assert.deepEqual(req.config.responseSchema.required, ['operations']);
  const variants = req.config.responseSchema.properties.operations.items.anyOf; assert.equal(variants.length, 2);
  assert.deepEqual(variants[0].properties.value.required, ['category', 'choice', 'rationale']);
  assert.ok(req.config.abortSignal instanceof AbortSignal);
});

test('S4G Tech Stack rejects malformed operations, corrects through the shared schema retry and preserves strict Groq fallback', async () => quiet(async log => {
  reset(); let attempt = 0;
  gemini = async () => ({ text: JSON.stringify(++attempt === 1 ? { ...techStackOutput, summary: userText } : techStackOutput) });
  const generate = createTechStackProvider(); assert.deepEqual(await generate(base, userText, signal(), stackContext), techStackOutput);
  assert.equal(calls.length, 2); assert.match(calls[1].request.contents, /previous response did not match the schema/);
  reset(); gemini = async () => { throw new Error(userText); };
  groq = async () => ({ choices: [{ message: { content: JSON.stringify(techStackOutput) } }] });
  assert.deepEqual(await generate(base, userText, signal(), stackContext), techStackOutput);
  const call = calls.find(c => c.provider === 'groq'); assert.equal(call.request.response_format.json_schema.name, 'tech_stack_change');
  assert.equal(call.request.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(call.options.maxRetries, 0); assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(log.mock.calls).includes(userText), false);
}));

test('S4G Tech Stack malformed output exhausts bounded providers without leaking text; cancellation stops provider work', async () => quiet(async log => {
  reset(); const invalid = { operations: [{ op: 'set_field', path: 'product.summary', value: userText }] };
  gemini = async () => ({ text: JSON.stringify(invalid) }); groq = async () => ({ choices: [{ message: { content: JSON.stringify(invalid) } }] });
  await refuses(() => createTechStackProvider()(base, userText, signal(), stackContext), 'change_generation_failed');
  assert.equal(calls.length, 8); assert.equal(JSON.stringify(log.mock.calls).includes(userText), false);
  reset(); const abort = new AbortController(); abort.abort();
  await refuses(() => createTechStackProvider()(base, userText, abort.signal, stackContext), 'generation_timeout'); assert.equal(calls.length, 0);
  const late = deferred(); gemini = () => late.promise;
  await refuses(() => createTechStackProvider({ timeoutMs: 10 })(base, userText, signal(), stackContext), 'generation_timeout');
  assert.equal(calls.length, 1); assert.equal(calls[0].request.config.abortSignal.aborted, true);
  late.reject(new Error(userText)); await new Promise(done => setImmediate(done)); assert.equal(calls.length, 1);
}));

test('pricing-neutral ledger adapter denies existing quota exhaustion and passes exact lifecycle identity/transaction', async () => {
  reset(); const events = [], client = { query }, intent = { actorId: 'fixture-actor', mapId: 'fixture-map', proposalId: 'fixture-proposal',
    requestDigest: 'a'.repeat(64), admittedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 180000) };
  const ledger = { assertConfigured() {}, async reserve(c, i) { events.push(['reserve', c, i]); }, async ready(c, i) { events.push(['ready', c, i]); },
    async failed(c, i, reason) { events.push(['failed', c, i, reason]); } };
  const admission = createPreviewAdmission({ ledger }); counts.user = 2;
  await refuses(() => admission.reserve(client, intent), 'daily_limit_exceeded'); assert.equal(events.length, 0);
  counts.global = 200; await refuses(() => admission.reserve(client, intent), 'capacity_exceeded'); assert.equal(events.length, 0);
  counts = { user: 0, global: 0 }; await admission.reserve(client, intent); await admission.ready(client, intent); await admission.failed(client, intent, 'no_changes');
  assert.deepEqual(events.map(e => e[0]), ['reserve','ready','failed']); assert.ok(events.every(e => e[1] === client && e[2] === intent));
  assert.equal(Object.hasOwn(intent, 'price'), false); assert.equal(Object.hasOwn(intent, 'credits'), false);
});
