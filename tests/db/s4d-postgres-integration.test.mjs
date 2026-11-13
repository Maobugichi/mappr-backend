import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID, createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { Pool, Client } from 'pg';
import { parse as parseDotenv } from 'dotenv';

// Opt-in only: no application URL fallback. This suite requires a separately
// provisioned, marked, EMPTY synthetic database on the pinned local PG17 cluster.
const enabled = Boolean(process.env.MAPPR_S4D_PG_TEST_CONFIG);
test('isolated PostgreSQL 17 S4/S5 migration, publication and daily admission integration', {
  skip: !enabled && 'No explicit isolated synthetic target; PostgreSQL integration NOT run.', timeout: 240000,
}, async t => {
  assert.equal(process.env.MAPPR_S4D_PG_TEST_DISPOSABLE, 'I_ACCEPT_SYNTHETIC_LOCAL_DATABASE_ONLY');
  const config = JSON.parse(readFileSync(process.env.MAPPR_S4D_PG_TEST_CONFIG, 'utf8'));
  assert.equal(config.purpose, 'S4D_SYNTHETIC_ONLY'); assert.equal(config.host, '127.0.0.1'); assert.equal(config.ssl, false);
  assert.match(config.database, /^mappr_s4d_synthetic_[a-f0-9]{16}$/); assert.ok(Number.isInteger(config.port) && config.port !== 5432);
  for (const role of [config.ownerRole, config.clientRole]) assert.match(role, /^mappr_s4d_(?:owner|client)_[a-f0-9]{16}$/);
  for (const value of [process.env.DATABASE_URL, parseDotenv(readFileSync(new URL('../../.env', import.meta.url))).DATABASE_URL].filter(Boolean)) {
    assert.notEqual(decodeURIComponent(new URL(value).pathname.slice(1)), config.database, 'Application target excluded');
  }
  const connection = { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    ssl: false, connectionTimeoutMillis: 10000, query_timeout: 20000, application_name: 'mappr_s4d_synthetic_integration',
    options: '-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=30000' };
  const admin = new Client(connection); admin.on('error', () => {}); await admin.connect(); t.after(() => admin.end());
  await admin.query('BEGIN READ ONLY');
  const { rows: [identity] } = await admin.query(`SELECT current_database() database,current_setting('server_version_num')::integer version,
    host(inet_server_addr()) host,inet_server_port() port,current_setting('data_directory') dir,
    (SELECT system_identifier::text FROM pg_control_system()) system_id,
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) marker`);
  assert.equal(identity.database, config.database); assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, config.port);
  assert.equal(Math.floor(identity.version / 10000), 17); assert.equal(identity.system_id, config.expectedSystemIdentifier);
  assert.equal(path.resolve(identity.dir).toLowerCase(), path.resolve(config.expectedDataDirectory).toLowerCase());
  assert.equal(identity.marker, `mappr-s4d-synthetic:${config.database}`);
  assert.equal((await admin.query("SELECT count(*)::integer n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n, 0);
  await admin.query('ROLLBACK');
  const ordinaryRoles = ['anon','authenticated'];
  const existingOrdinary = (await admin.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)',[ordinaryRoles])).rows;
  assert.ok(existingOrdinary.every(r=>!r.rolsuper&&!r.rolbypassrls&&!r.rolcanlogin),'Only isolated NOLOGIN ordinary test roles may be reused');
  const ordinaryInitiallyAbsent = existingOrdinary.length === 0;
  const raw = new Pool({ ...connection, max: 12, options: connection.options + ` -c role=${config.ownerRole}` });
  raw.on('error', () => {}); t.after(() => raw.end());
  let fault = null;
  const database = { async connect() { const client = await raw.connect(); return {
    async query(sql, args) {
      if (fault?.match(sql)) { const active = fault; fault = null;
        if (active.afterCommit) { const result = await client.query(sql, args); throw new Error('Synthetic lost COMMIT acknowledgement'); }
        await client.query('SELECT 1/0');
      }
      return client.query(sql, args);
    }, release: () => client.release(),
  }; }, query: (sql, args) => raw.query(sql, args) };
  process.env.DATABASE_URL = 'never-use-application-pool'; process.env.COOKIE_SECRET = 's4d-synthetic-cookie-secret';
  process.env.FRONTEND_ORIGIN = 'https://synthetic.mappr.test'; process.env.NODE_ENV = 'test';
  process.env.MAPPR_REVISION_WRITES_ENABLED = 'true'; process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true';
  process.env.MAPPR_CHANGES_ENABLED = 'true'; process.env.FREE_DAILY_LIMIT = '2'; process.env.GLOBAL_DAILY_CEILING = '200';
  delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.CHANGE_PROPOSAL_TTL_SECONDS;
  globalThis.fetch = async () => { throw new Error('Non-loopback/provider network forbidden'); };
  mock.module(new URL('../../src/db/pool.ts', import.meta.url).href, { namedExports: { pool: database } });
  const system = { meta: { productName: 'Synthetic product', oneLineSummary: 'Synthetic tagline' }, product: { summary: 'Original summary', concepts: [] },
    users: [], features: [], techStack: [], architecture: { nodes: [], edges: [] }, dataModel: { entities: [], relations: [] },
    designSystem: { colors: [], typography: [], spacing: [], components: [] }, developmentPlan: [] };
  let aiCalls = 0, aiHook;
  const copy = x => structuredClone(x), deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  mock.module(new URL('../../src/services/aiClient.ts', import.meta.url).href, { namedExports: {
    AIGenerationError: class extends Error {}, generateStructured: async config => {
      aiCalls++; if (aiHook) await aiHook(config);
      const outputs = { mappr_system: system, overview_summary: { summary: 'Reviewed synthetic summary' },
        architecture_iteration: { summary: 'Added synthetic service', patch: { addNodes: [{ id: 'new-api', label: 'API', type: 'service', description: 'Synthetic service' }], removeNodeIds: [], updateNodes: [], addEdges: [], removeEdges: [] } },
        api_contract: { endpoints: [] }, relational_schema: { tables: [] }, document_schema: { collections: [] }, adr_set: { adrs: [] },
        env_vars: { vars: [] }, deployment_runbook: { components: [], environments: [], cicdSteps: [], migrations: null },
        readme: { overview: 'Synthetic overview', gettingStarted: [] }, architecture_review: { findings: [] }, requirements_review: { findings: [] }, traceability: { links: [] } };
      assert.ok(outputs[config.groqSchemaName], 'Only known synthetic provider output is allowed'); return copy(outputs[config.groqSchemaName]);
    },
  } });
  const { DailyAdmission, dailyAdmission, cleanupDailyAttempt, recordSuccessfulGeneration } = await import('../../src/services/dailyAdmission.ts');
  const { createOverviewChangeEngine } = await import('../../src/services/changes/engine.ts');
  const { createApp } = await import('../../src/app.ts');
  const { createChangesRouter } = await import('../../src/routes/changes.ts');
  const { assertChangesAvailable } = await import('../../src/services/changes/availability.ts');
  const { captureArtifactSource, publishArtifact } = await import('../../src/services/artifacts/provenance.ts');
  const { ARTIFACTS } = await import('../../src/services/artifacts/registry.ts');
  const { ARTIFACT_EXPORTS } = await import('../../src/middleware/artifactReads.ts');
  const engine = createOverviewChangeEngine(database);
  const scalar = async (sql, args) => (await raw.query(sql, args)).rows[0].n;
  const usage = actor => scalar('SELECT count(*)::integer n FROM generations WHERE anon_id=$1', [actor]);
  const states = actor => raw.query('SELECT state FROM generation_attempts WHERE actor_id=$1 ORDER BY admitted_at,id', [actor]).then(r => r.rows.map(x => x.state));
  const changed = (sql,args) => raw.query(sql,args);
  const proposalBody = (revision = 1) => ({ instruction: 'Clarify the summary.', context: { activeView: 'overview', selectedTarget: null }, expectedBaseRevision: revision });
  const fails = (work, code) => assert.rejects(work, error => error.code === code);
  async function seed(actor = randomUUID(), precise = false) {
    const data = JSON.stringify(system).replace(/}$/, ',"extension":{"precise":' + (precise ? '9007199254740993' : '17') + '}}');
    const { rows: [map] } = await raw.query('INSERT INTO maps(anon_id,input_description,data,current_revision) VALUES($1,$2,$3,1) RETURNING id', [actor, 'Synthetic input', data]);
    await raw.query("INSERT INTO map_versions(map_id,version,data,summary) SELECT id,1,data,'Synthetic initial' FROM maps WHERE id=$1", [map.id]);
    return { actor, id: map.id };
  }
  async function failSql(work, code) { const client = await raw.connect(); try { await client.query('BEGIN');
    await assert.rejects(() => work(client), error => error.code === code); await client.query('ROLLBACK');
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } } }
  const baselineActor = randomUUID(), baselineMap = randomUUID(); let baselineRecord;
  await t.test('empty-target baseline and 013 prepare real constraints; 014/015/016 preserve synthetic existing rows', async () => {
    await raw.query(readFileSync(new URL('../../src/db/baseline/001_existing_schema.sql', import.meta.url), 'utf8'));
    await raw.query(readFileSync(new URL('../../src/db/migrations/013_current_revision.sql', import.meta.url), 'utf8'));
    await raw.query('INSERT INTO maps(id,anon_id,input_description,data,current_revision) VALUES($1,$2,$3,$4,1)', [baselineMap,baselineActor,'Pre-migration synthetic input',system]);
    await raw.query("INSERT INTO map_versions(map_id,version,data,summary) VALUES($1,1,$2,'Synthetic initial')",[baselineMap,system]);
    await raw.query('INSERT INTO generations(anon_id,map_id) VALUES($1,$2)',[baselineActor,baselineMap]);
    await raw.query("INSERT INTO readmes(map_id,version,overview,getting_started) VALUES($1,1,'Legacy synthetic output','[]')",[baselineMap]);
    baselineRecord=(await raw.query('SELECT to_jsonb(m)::text m,(SELECT to_jsonb(g)::text FROM generations g WHERE map_id=m.id) g FROM maps m WHERE id=$1',[baselineMap])).rows[0];
    const proposalSql=readFileSync(new URL('../../src/db/migrations/014_change_proposals.sql',import.meta.url),'utf8');
    assert.match(proposalSql,/COMMIT;\s*$/); const uncommittedSql=proposalSql.replace(/COMMIT;\s*$/,'');
    const migration=await raw.connect();
    try {
      if(ordinaryInitiallyAbsent){
        await migration.query('BEGIN');
        for(const name of ['014_change_proposals.sql','015_artifact_provenance.sql','016_daily_generation_admission.sql']){
          const sql=readFileSync(new URL('../../src/db/migrations/'+name,import.meta.url),'utf8');
          await migration.query(sql.replace(/^[\s\S]*?\bBEGIN;/,'').replace(/COMMIT;\s*$/,''));
        }
        const {rows}=await migration.query("SELECT relrowsecurity rls FROM pg_class WHERE oid IN ('public.map_change_proposals'::regclass,'public.artifact_generations'::regclass,'public.daily_admission_policy'::regclass,'public.generation_attempts'::regclass)");
        assert.equal(rows.length,4);assert.ok(rows.every(r=>r.rls));
        await migration.query('ROLLBACK'); // Exact migrations without Supabase roles; no objects left.
      }
      for(const role of ordinaryRoles)if(!existingOrdinary.some(r=>r.rolname===role))await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await raw.query('GRANT USAGE ON SCHEMA public TO anon,authenticated');
      // Reproduce observed Supabase defaults in THIS disposable database only.
      await raw.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO PUBLIC,anon,authenticated');
      await raw.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${config.clientRole}"`);
      // Unknown inherited grants must abort, not silently alter group/default ACLs.
      await admin.query('BEGIN');
      try {
        await admin.query(`GRANT "${config.clientRole}" TO anon`);
        await admin.query(`SET LOCAL ROLE "${config.ownerRole}"`);
        await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES FROM "${config.clientRole}"`);
        await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO "${config.clientRole}"`);
        const body=uncommittedSql.replace(/^[\s\S]*?\bBEGIN;/,'');
        await assert.rejects(()=>admin.query(body),e=>e.code==='42501');
      } finally { await admin.query('ROLLBACK'); }
      assert.equal((await raw.query("SELECT to_regclass('public.map_change_proposals') relation")).rows[0].relation,null);
      await migration.query(uncommittedSql);
      assert.equal((await admin.query("SELECT to_regclass('public.map_change_proposals') relation")).rows[0].relation,null,'No unprotected catalog visibility before COMMIT');
      await migration.query('COMMIT');
    } finally { await migration.query('ROLLBACK'); migration.release(); }
    for(const [name,privateTables,guard] of [
      ['015_artifact_provenance.sql',['artifact_generations'],'DO $artifact_privacy$'],
      ['016_daily_generation_admission.sql',['daily_admission_policy','generation_attempts'],'DO $admission_privacy$'],
    ]){
      const sql=readFileSync(new URL('../../src/db/migrations/'+name,import.meta.url),'utf8');
      assert.match(sql,/COMMIT;\s*$/);assert.ok(sql.includes(guard));
      // Each table's actual guard must reject inherited privileges, including
      // MAINTAIN. Inject only the adversarial GRANT; execute the real DDL/guard.
      for(const table of privateTables)for(const privilege of ['TRUNCATE','MAINTAIN'])for(const role of ordinaryRoles){
        await admin.query('BEGIN');
        try {
          await admin.query(`GRANT "${config.clientRole}" TO "${role}"`);
          await admin.query(`SET LOCAL ROLE "${config.ownerRole}"`);
          await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${config.clientRole}"`);
          const body=sql.replace(/^[\s\S]*?\bBEGIN;/,'').replace(/COMMIT;\s*$/,'')
            .replace(guard,`GRANT ${privilege} ON public.${table} TO "${config.clientRole}";\n${guard}`);
          await assert.rejects(()=>admin.query(body),e=>e.code==='42501'&&/privacy requires removal of inherited client privileges/.test(e.message));
        } finally { await admin.query('ROLLBACK'); }
        for(const privateTable of privateTables)assert.equal((await raw.query('SELECT to_regclass($1) relation',['public.'+privateTable])).rows[0].relation,null);
        assert.equal(await scalar("SELECT count(*)::integer n FROM information_schema.columns WHERE table_schema='public' AND column_name=$1",[name.startsWith('015')?'generation_id':'attempt_id']),0);
      }
      const client=await raw.connect();
      try {
        await client.query(sql.replace(/COMMIT;\s*$/,''));
        for(const table of privateTables)assert.equal((await admin.query('SELECT to_regclass($1) relation',['public.'+table])).rows[0].relation,null,'No private-table visibility before COMMIT');
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK');client.release(); }
    }
    const after=(await raw.query("SELECT to_jsonb(m)::text m,(SELECT (to_jsonb(g)-'attempt_id')::text FROM generations g WHERE map_id=m.id) g FROM maps m WHERE id=$1",[baselineMap])).rows[0];
    assert.deepEqual(after,baselineRecord);assert.equal(await scalar('SELECT count(*)::integer n FROM generations WHERE attempt_id IS NOT NULL'),0);
    assert.equal(await scalar("SELECT count(*)::integer n FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated"),0);
    assert.equal(await scalar("SELECT count(*)::integer n FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace AND (NOT indisvalid OR NOT indisready)"),0);
  });
  // Only the test-injected router bypasses availability. The production gate is
  // asserted separately below and its source is never changed by this suite.
  const server=createApp({changesRouter:createChangesRouter({engine,assertAvailable:()=>{}})}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  async function request(method, route, actor, body, key = randomUUID()) {
    const text=body===undefined?undefined:JSON.stringify(body),cookie=actor?`mappr_anon=${actor}.${createHmac('sha256',process.env.COOKIE_SECRET).update(actor).digest('hex')}`:null;
    return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Origin:process.env.FRONTEND_ORIGIN,
      ...(cookie?{Cookie:cookie}:{}),'Idempotency-Key':key,...(text?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:res.headers['content-type']?.includes('application/json')?JSON.parse(text):text});});
    });req.setTimeout(20000,()=>req.destroy(new Error('Synthetic local HTTP timeout')));req.on('error',reject);req.end(text);});
  }

  await t.test('owner permissions are non-superuser; RLS blocks inherited client access including proposals',async()=>{
    const roles=(await admin.query('SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',[[config.ownerRole,config.clientRole]])).rows;
    assert.equal(roles.length,2);assert.ok(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
    await raw.query(`GRANT USAGE ON SCHEMA public TO "${config.clientRole}"`);
    await raw.query(`GRANT SELECT,INSERT ON public.daily_admission_policy,public.generation_attempts,public.artifact_generations TO "${config.clientRole}"`);
    await admin.query(`SET ROLE "${config.clientRole}"`);
    try {
      assert.equal((await admin.query('SELECT * FROM daily_admission_policy')).rowCount,0);
      assert.equal((await admin.query('SELECT * FROM generation_attempts')).rowCount,0);
      assert.equal((await admin.query('SELECT * FROM artifact_generations')).rowCount,0);
      assert.equal((await admin.query('SELECT * FROM map_change_proposals')).rowCount,0);
      await assert.rejects(()=>admin.query("INSERT INTO daily_admission_policy VALUES(false,'daily-success-v1','UTC')"),e=>e.code==='42501');
    }finally{await admin.query('RESET ROLE');}
    assert.equal((await raw.query('SELECT current_user role')).rows[0].role,config.ownerRole);
  });
  await t.test('014 catalog revokes PUBLIC/ordinary grants and exposes no policy, sequence, view or routine',async()=>{
    const {rows:[protection]}=await raw.query(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,
      (SELECT count(*)::integer FROM pg_policy WHERE polrelid=c.oid) policies,
      EXISTS(SELECT 1 FROM aclexplode(c.relacl) WHERE grantee=0) public_grants,
      pg_get_userbyid(c.relowner)=current_user backend_owner
      FROM pg_class c WHERE c.oid='public.map_change_proposals'::regclass`);
    assert.deepEqual(protection,{rls:true,forced:false,policies:0,public_grants:false,backend_owner:true});
    for(const role of ordinaryRoles){
      const {rows:[priv]}=await raw.query("SELECT has_table_privilege($1,'public.map_change_proposals','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[role]);
      assert.equal(priv.allowed,false,role+' effective table privileges');
      await admin.query(`SET ROLE "${role}"`);
      try {
        for(const sql of ['SELECT * FROM public.map_change_proposals','INSERT INTO public.map_change_proposals(id) VALUES(gen_random_uuid())',
          "UPDATE public.map_change_proposals SET generator_id='forbidden'",'DELETE FROM public.map_change_proposals','TRUNCATE public.map_change_proposals CASCADE']){
          await assert.rejects(()=>admin.query(sql),e=>e.code==='42501');
        }
      }finally{await admin.query('RESET ROLE');}
    }
    assert.equal(await scalar("SELECT count(*)::integer n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('S','v','m')"),0);
    assert.equal(await scalar("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='public'::regnamespace"),0);
  });
  await t.test('015/016 deny client CRUD and TRUNCATE by privileges while preserving owner access and policy',async()=>{
    const tables=['artifact_generations','daily_admission_policy','generation_attempts'];
    const policyBefore=(await raw.query('SELECT to_jsonb(p) value FROM daily_admission_policy p')).rows;
    assert.equal(policyBefore.length,1);
    for(const table of tables){
      const {rows:[catalog]}=await raw.query(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,
        (SELECT count(*)::integer FROM pg_policy WHERE polrelid=c.oid) policies,
        EXISTS(SELECT 1 FROM aclexplode(c.relacl) WHERE grantee=0) public_grants,
        pg_get_userbyid(c.relowner)=current_user backend_owner FROM pg_class c WHERE c.oid=$1::regclass`,['public.'+table]);
      assert.deepEqual(catalog,{rls:true,forced:false,policies:0,public_grants:false,backend_owner:true});
      for(const role of ordinaryRoles){
        assert.equal((await raw.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') allowed",[role,'public.'+table])).rows[0].allowed,false);
        await admin.query(`SET ROLE "${role}"`);
        try {
          for(const sql of [`SELECT * FROM public.${table}`,`INSERT INTO public.${table} DEFAULT VALUES`,
            `UPDATE public.${table} SET ${table==='daily_admission_policy'?'policy_version=policy_version':'id=id'}`,`DELETE FROM public.${table}`,`TRUNCATE public.${table} CASCADE`]){
            await assert.rejects(()=>admin.query(sql),e=>e.code==='42501');
          }
        }finally{await admin.query('RESET ROLE');}
      }
      for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']){
        assert.equal((await raw.query('SELECT has_table_privilege(current_user,$1,$2) allowed',['public.'+table,privilege])).rows[0].allowed,true);
      }
    }
    assert.deepEqual((await raw.query('SELECT to_jsonb(p) value FROM daily_admission_policy p')).rows,policyBefore);
  });
  await t.test('014 RLS still denies proposal contents/mutations after explicit client regrant and matching actor claims',async()=>{
    const map=await seed(),key=randomUUID(),p=await engine.preview(map.id,map.actor,key,proposalBody());
    for(const role of ordinaryRoles){
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE "${config.ownerRole}"`);
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.map_change_proposals TO "${role}"`);
        await admin.query(`SET LOCAL ROLE "${role}"`);
        await admin.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:map.actor,role})]);
        assert.equal((await admin.query('SELECT * FROM public.map_change_proposals WHERE id=$1',[p.response.proposalId])).rowCount,0);
        assert.equal((await admin.query("UPDATE public.map_change_proposals SET generator_id='forbidden' WHERE id=$1",[p.response.proposalId])).rowCount,0);
        assert.equal((await admin.query('DELETE FROM public.map_change_proposals WHERE id=$1',[p.response.proposalId])).rowCount,0);
        await assert.rejects(()=>admin.query(`INSERT INTO public.map_change_proposals
          (id,map_id,actor_id,preview_key,request_digest,request_payload,base_revision,base_fingerprint,state,admitted_at,lease_expires_at,validation_policy,generator_id)
          VALUES($1,$2,$3,$4,repeat('a',64),'{}',1,repeat('b',64),'generating',clock_timestamp(),clock_timestamp()+interval '3 minutes','{}','forbidden')`,
          [randomUUID(),map.id,map.actor,randomUUID()]),e=>e.code==='42501');
      } finally { await admin.query('ROLLBACK'); }
    }
    const row=(await raw.query('SELECT state,generator_id FROM public.map_change_proposals WHERE id=$1',[p.response.proposalId])).rows[0];
    assert.equal(row.state,'ready');assert.notEqual(row.generator_id,'forbidden');
    assert.equal((await engine.preview(map.id,map.actor,key,proposalBody())).replayed,true);
    const before=aiCalls;
    const denied=await request('POST',`/maps/${map.id}/changes/preview`,randomUUID(),proposalBody());assert.equal(denied.status,404);
    await fails(()=>engine.apply(map.id,randomUUID(),p.response.proposalId,{approved:true,expectedBaseRevision:1}),'not_found');
    await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1});
    assert.equal((await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1})).replayed,true);
    assert.equal(aiCalls,before);assert.equal(await usage(map.actor),1);
  });
  await t.test('thirteen real AI routes use real SQL admission/publication with only mocked AI',async()=>{
    const generatedActor=randomUUID(),generated=await request('POST','/generate',generatedActor,{description:'A sufficiently long synthetic product description.'});
    assert.equal(generated.status,201,JSON.stringify(generated.body));assert.equal(generated.body.revision,1);assert.equal(await usage(generatedActor),1);
    const architecture=await seed(),iterated=await request('POST',`/maps/${architecture.id}/iterate`,architecture.actor,{instruction:'Add a service.'});
    assert.equal(iterated.status,201,JSON.stringify(iterated.body));assert.equal(iterated.body.revision,2);assert.equal(await usage(architecture.actor),1);
    for(const [kind,metadata] of Object.entries(ARTIFACTS)){
      const map=await seed(),result=await request('POST',`/maps/${map.id}/${metadata.route}`,map.actor,{});
      assert.equal(result.status,201,kind+': '+JSON.stringify(result.body));assert.equal(await usage(map.actor),1);
      const tracked=await request('GET',`/maps/${map.id}/${metadata.route}?freshness=tracked`,null);
      assert.equal(tracked.status,200);assert.equal(tracked.body.isCurrent,true);assert.equal(tracked.body.sourceRevision,1);
      assert.equal(await scalar("SELECT count(*)::integer n FROM artifact_generations WHERE map_id=$1 AND origin='generated'",[map.id]),1);
      if(ARTIFACT_EXPORTS[kind]){
        const exported=await request('GET',`/maps/${map.id}/${metadata.route}/${ARTIFACT_EXPORTS[kind]}${kind==='relational_schema'?'?dialect=postgres':''}`,null);
        assert.equal(exported.status,200,kind+' current export');
      }
    }
    const map=await seed(),p=await request('POST',`/maps/${map.id}/changes/preview`,map.actor,proposalBody());
    assert.equal(p.status,201,JSON.stringify(p.body));assert.equal(await usage(map.actor),1);
  });
  await t.test('real CHECK/FK/unique constraints reject invalid identity, state and mismatched successful usage',async()=>{
    const map=await seed(),attempt=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'iterate'});
    await failSql(c=>c.query("UPDATE generation_attempts SET state='unknown' WHERE id=$1",[attempt.id]),'23514');
    await failSql(c=>c.query('UPDATE generation_attempts SET lease_expires_at=admitted_at WHERE id=$1',[attempt.id]),'23514');
    await failSql(c=>c.query('INSERT INTO generations(anon_id,map_id,attempt_id) VALUES($1,$2,$3)',[randomUUID(),map.id,attempt.id]),'23503');
    await failSql(c=>c.query('INSERT INTO generations(anon_id,map_id,attempt_id) VALUES($1,$2,$3)',[map.actor,map.id,randomUUID()]),'23503');
    await dailyAdmission.failure(attempt);
    const ready=await engine.preview(map.id,map.actor,randomUUID(),proposalBody()),id=ready.response.proposalId;
    await failSql(c=>c.query('UPDATE map_change_proposals SET base_revision=99 WHERE id=$1',[id]),'23503');
    await failSql(c=>c.query("UPDATE map_change_proposals SET state='applied' WHERE id=$1",[id]),'23514');
    await failSql(c=>c.query('INSERT INTO generations(anon_id,map_id,attempt_id) VALUES($1,$2,$3)',[map.actor,map.id,id]),'23505');
    await failSql(c=>c.query('UPDATE generation_attempts SET proposal_id=$2 WHERE id=$1',[id,randomUUID()]),'23514');
  });
  await t.test('mixed operation actor and global last-unit races admit only one provider',async()=>{
    const map=await seed();await raw.query('INSERT INTO generations(anon_id,map_id) VALUES($1,$2)',[map.actor,map.id]);
    let before=aiCalls;
    const results=await Promise.all([request('POST','/generate',map.actor,{description:'A synthetic actor race product description.'}),request('POST',`/maps/${map.id}/readme`,map.actor,{})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,429]);assert.equal(aiCalls-before,1);assert.equal(await usage(map.actor),2);
    const current=await scalar(`SELECT (SELECT count(*) FROM generations)+(SELECT count(*) FROM generation_attempts WHERE state='reserved') AS n`);
    const fill=(await raw.query('INSERT INTO generations(anon_id) SELECT gen_random_uuid() FROM generate_series(1,$1::integer) RETURNING id',[199-Number(current)])).rows.map(r=>r.id);
    const other=await seed();before=aiCalls;
    const global=await Promise.all([request('POST','/generate',randomUUID(),{description:'A synthetic global race product description.'}),request('POST',`/maps/${other.id}/api-contract`,other.actor,{})]);
    assert.deepEqual(global.map(r=>r.status).sort(),[201,503]);assert.equal(aiCalls-before,1);
    await raw.query('DELETE FROM generations WHERE id=ANY($1)',[fill]);
  });
  await t.test('same-key concurrent preview replays and atomic Apply add no extra usage or provider work',async()=>{
    const map=await seed(undefined,true),entered=deferred(),release=deferred(),key=randomUUID();
    aiHook=async cfg=>{if(cfg.groqSchemaName==='overview_summary'){entered.resolve();await release.promise;}};
    const first=engine.preview(map.id,map.actor,key,proposalBody());await entered.promise;
    assert.equal(await scalar("SELECT count(*)::integer n FROM pg_stat_activity WHERE application_name='mappr_s4d_synthetic_integration' AND state='idle in transaction'"),0);
    await fails(()=>engine.preview(map.id,map.actor,key,proposalBody()),'preview_in_progress');release.resolve();const p=await first;aiHook=null;
    const before=aiCalls,rows=await usage(map.actor);assert.equal((await engine.preview(map.id,map.actor,key,proposalBody())).replayed,true);
    await fails(()=>engine.preview(map.id,map.actor,key,{...proposalBody(),instruction:'Different instruction'}),'idempotency_key_reused');
    const applied=await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1});
    assert.equal(applied.response.revision,2);assert.equal((await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1})).replayed,true);
    assert.equal(await usage(map.actor),rows);assert.equal(aiCalls,before);
    assert.equal(await scalar('SELECT count(*)::integer n FROM map_versions WHERE map_id=$1',[map.id]),2);
    assert.equal((await raw.query("SELECT data#>>'{extension,precise}' n FROM maps WHERE id=$1",[map.id])).rows[0].n,'9007199254740993');
  });
  await t.test('stale preview versus Architecture commit shares the real map lock and releases only the loser',async()=>{
    const map=await seed(),entered=deferred(),release=deferred();
    aiHook=async cfg=>{if(cfg.groqSchemaName==='overview_summary'){entered.resolve();await release.promise;}};
    const pending=engine.preview(map.id,map.actor,randomUUID(),proposalBody());await entered.promise;
    const committed=await request('POST',`/maps/${map.id}/iterate`,map.actor,{instruction:'Add a service.'});
    release.resolve();aiHook=null;
    if(committed.status!==201){await pending;assert.equal(committed.status,201,JSON.stringify(committed.body));}
    await fails(()=>pending,'revision_conflict');
    assert.equal(await usage(map.actor),1);assert.deepEqual((await states(map.actor)).sort(),['failed','succeeded']);
  });
  await t.test('server-side usage error rolls back ready publication, and recovery is idempotent',async()=>{
    const map=await seed(),key=randomUUID();fault={match:sql=>sql.includes('/* daily:usage */')};
    await assert.rejects(()=>engine.preview(map.id,map.actor,key,proposalBody()));assert.equal(await usage(map.actor),0);
    assert.equal((await raw.query('SELECT state FROM map_change_proposals WHERE map_id=$1',[map.id])).rows[0].state,'generating');
    await raw.query("UPDATE generation_attempts SET admitted_at=clock_timestamp()-interval '181 seconds',lease_expires_at=clock_timestamp()-interval '1 second' WHERE map_id=$1",[map.id]);
    await dailyAdmission.recoverExpired();await dailyAdmission.recoverExpired();assert.deepEqual(await states(map.actor),['failed']);
    await fails(()=>engine.preview(map.id,map.actor,key,proposalBody()),'generation_timeout');
  });
  await t.test('lost admission/ready/Apply COMMIT acknowledgements resolve from actual durable records',async()=>{
    let map=await seed(),key=randomUUID();fault={match:sql=>sql==='COMMIT',afterCommit:true};
    // Recovery's initial empty scan also commits: inject the admission fault only after its INSERT.
    fault=null;
    const original=database.connect;
    database.connect=async()=>{const c=await original();return {...c,query:async(sql,args)=>{const result=await c.query(sql,args);if(sql.includes('/* daily:reserve */'))fault={match:s=>s==='COMMIT',afterCommit:true};return result;}};};
    try{await assert.rejects(()=>engine.preview(map.id,map.actor,key,proposalBody()));}finally{database.connect=original;fault=null;}
    await fails(()=>engine.preview(map.id,map.actor,key,proposalBody()),'preview_in_progress');assert.equal(await usage(map.actor),0);
    await raw.query("UPDATE generation_attempts SET admitted_at=clock_timestamp()-interval '181 seconds',lease_expires_at=clock_timestamp()-interval '1 second' WHERE map_id=$1",[map.id]);await dailyAdmission.recoverExpired();
    map=await seed();key=randomUUID();aiHook=async cfg=>{if(cfg.groqSchemaName==='overview_summary')fault={match:s=>s==='COMMIT',afterCommit:true};};
    await assert.rejects(()=>engine.preview(map.id,map.actor,key,proposalBody()));aiHook=null;
    const p=await engine.preview(map.id,map.actor,key,proposalBody());assert.equal(p.replayed,true);assert.equal(await usage(map.actor),1);
    fault={match:s=>s==='COMMIT',afterCommit:true};await assert.rejects(()=>engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1}));
    const receipt=await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1});assert.equal(receipt.replayed,true);assert.equal(await usage(map.actor),1);
  });
  await t.test('artifact provenance, archival, stale inspection and current-only export survive actual summary Apply',async()=>{
    const map=await seed();await raw.query("INSERT INTO readmes(map_id,version,overview,getting_started) VALUES($1,1,'Synthetic old output','[]')",[map.id]);
    const posted=await request('POST',`/maps/${map.id}/readme`,map.actor,{});assert.equal(posted.status,201);
    assert.equal(await scalar('SELECT count(*)::integer n FROM artifact_generations WHERE map_id=$1',[map.id]),2);
    const p=await engine.preview(map.id,map.actor,randomUUID(),proposalBody());await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1});
    assert.equal((await request('GET',`/maps/${map.id}/readme?freshness=tracked`,null)).status,409);
    const inspection=await request('GET',`/maps/${map.id}/readme?freshness=tracked&includeStale=true`,map.actor);assert.equal(inspection.status,200);assert.equal(inspection.body.inspectionOnly,true);
    assert.equal((await request('GET',`/maps/${map.id}/readme?freshness=tracked&includeStale=true`,randomUUID())).status,404);
    assert.equal((await request('GET',`/maps/${map.id}/readme/markdown`,null)).status,409);assert.equal(await usage(map.actor),2);
  });
  await t.test('artifact publication conflicts and actual SQL rollback leave successful usage atomic',async()=>{
    const map=await seed(),a=await captureArtifactSource(map.id,map.actor,'readme'),b=await captureArtifactSource(map.id,map.actor,'readme');
    async function publish(source){const attempt=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'readme',id:source.generationId});try{return await publishArtifact(source,map.actor,async c=>{
      const {rows:[row]}=await c.query("INSERT INTO readmes(map_id,version,overview,getting_started) VALUES($1,1,'Synthetic publication','[]') ON CONFLICT(map_id,version) DO UPDATE SET overview=excluded.overview,updated_at=clock_timestamp() RETURNING *",[map.id]);
      await recordSuccessfulGeneration(c,map.actor,map.id,attempt);return row;
    });}catch(error){await cleanupDailyAttempt(attempt);throw error;}}
    const results=await Promise.allSettled([publish(a),publish(b)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(await usage(map.actor),1);
    assert.deepEqual((await states(map.actor)).sort(),['failed','succeeded']);
    const broken=await seed();fault={match:sql=>sql.includes('/* artifacts:save:')};
    const response=await request('POST',`/maps/${broken.id}/readme`,broken.actor,{});assert.equal(response.status,500);
    assert.equal(await usage(broken.actor),0);assert.equal(await scalar('SELECT count(*)::integer n FROM readmes WHERE map_id=$1',[broken.id]),0);
    assert.deepEqual(await states(broken.actor),['failed']);
  });
  await t.test('expired hold recovery racing a late publisher never commits late usage',async()=>{
    const map=await seed(),attempt=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'iterate'});
    await raw.query("UPDATE generation_attempts SET admitted_at=clock_timestamp()-interval '181 seconds',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[attempt.id]);
    async function late(){const c=await database.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE',[map.id]);
      await c.query("UPDATE maps SET input_description='Should roll back' WHERE id=$1",[map.id]);await dailyAdmission.success(c,attempt,map.id);await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
    const results=await Promise.allSettled([dailyAdmission.recoverExpired(),late()]);assert.equal(results[1].status,'rejected');
    assert.deepEqual(await states(map.actor),['failed']);assert.equal(await usage(map.actor),0);
    assert.equal((await raw.query('SELECT input_description FROM maps WHERE id=$1',[map.id])).rows[0].input_description,'Synthetic input');
  });
  await t.test('captured-day rollover and timezone/DST math are enforced by PostgreSQL',async()=>{
    const map=await seed(),attempt=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'iterate'});
    await raw.query("UPDATE generation_attempts SET quota_day_start=quota_day_start-interval '1 day',quota_day_end=quota_day_end-interval '1 day',admitted_at=admitted_at-interval '1 day' WHERE id=$1",[attempt.id]);
    const c=await database.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM maps WHERE id=$1 FOR UPDATE',[map.id]);await dailyAdmission.success(c,attempt,map.id);await c.query('COMMIT');}finally{c.release();}
    const a=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'iterate'}),b=await dailyAdmission.reserve({actorId:map.actor,mapId:map.id,operation:'readme'});
    await fails(()=>dailyAdmission.reserve({actorId:map.actor,operation:'generate'}),'daily_limit_exceeded');await dailyAdmission.failure(a);await dailyAdmission.failure(b);
    const wrong=new Pool({...connection,options:connection.options+` -c role=${config.ownerRole} -c timezone=Pacific/Honolulu`});try{
      const service=new DailyAdmission(wrong);await fails(()=>service.reserve({actorId:randomUUID(),operation:'generate'}),'daily_admission_not_ready');
    }finally{await wrong.end();}
    const dst=await raw.connect();try{await dst.query('BEGIN');await dst.query("SET LOCAL timezone='America/New_York'");
      const hours=(await dst.query("SELECT extract(epoch FROM ((date_trunc('day','2026-03-08 12:00:00-04'::timestamptz)+interval '1 day')-date_trunc('day','2026-03-08 12:00:00-04'::timestamptz)))/3600 AS n")).rows[0].n;
      assert.equal(Number(hours),23);await dst.query('ROLLBACK');
    }finally{dst.release();}
  });
  await t.test('failed-attempt abuse limit denies before mocked provider work',async()=>{
    const map=await seed(),before=aiCalls;process.env.DAILY_AI_ATTEMPT_LIMIT='2';aiHook=async()=>{throw new Error('Synthetic provider failure');};
    try{for(let i=0;i<2;i++)assert.equal((await request('POST','/generate',map.actor,{description:'Synthetic failing provider description.'})).status,500);
      const blocked=await request('POST','/generate',map.actor,{description:'Synthetic third failing provider description.'});assert.equal(blocked.status,429);assert.equal(blocked.body.error,'attempt_limit_exceeded');
      assert.equal(aiCalls-before,2);assert.equal(await usage(map.actor),0);
    }finally{aiHook=null;delete process.env.DAILY_AI_ATTEMPT_LIMIT;}
  });
  await t.test('deleting only a synthetic applied map preserves usage and nullable attempt associations',async()=>{
    const map=await seed(),p=await engine.preview(map.id,map.actor,randomUUID(),proposalBody());await engine.apply(map.id,map.actor,p.response.proposalId,{approved:true,expectedBaseRevision:1});
    await raw.query('DELETE FROM maps WHERE id=$1',[map.id]);assert.equal(await usage(map.actor),1);
    const row=(await raw.query('SELECT state,map_id,proposal_id FROM generation_attempts WHERE actor_id=$1',[map.actor])).rows[0];assert.deepEqual(row,{state:'succeeded',map_id:null,proposal_id:null});
  });
  await t.test('production release interlock remains unconditional and final synthetic baseline stays intact',async()=>{
    assert.throws(assertChangesAvailable,e=>e.code==='preview_policy_not_configured');
    const after=(await raw.query("SELECT to_jsonb(m)::text m,(SELECT (to_jsonb(g)-'attempt_id')::text FROM generations g WHERE map_id=m.id) g FROM maps m WHERE id=$1",[baselineMap])).rows[0];assert.deepEqual(after,baselineRecord);
    assert.equal(await scalar("SELECT count(*)::integer n FROM generation_attempts a WHERE (state='succeeded') IS DISTINCT FROM EXISTS(SELECT 1 FROM generations g WHERE g.attempt_id=a.id)"),0);
    assert.equal(await scalar("SELECT count(*)::integer n FROM generation_attempts WHERE state='reserved'"),0);
  });
});
