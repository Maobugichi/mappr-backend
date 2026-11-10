// Explicit operator support only. No app pool, dotenv, startup hook, or logging.
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isUuid } from '../middleware/anonSession.js';
import { planStoredOwnerRevisionBackfill, type BackfillReason } from '../services/revisionState.js';
import { backfillStoredOwnerRevisions, type StoredOwnerBackfillCandidate } from './backfillCurrentRevision.js';
import type { RevisionDatabase } from './revisionTransaction.js';

const approvalSchema = z.strictObject({
  developerApproved: z.literal(true), backupVerified: z.literal(true), writersStopped: z.literal(true),
  backupEvidence: z.string().trim().min(1), writerStopEvidence: z.string().trim().min(1),
});
const configSchema = z.strictObject({
  connectionString: z.string().min(1), sslRejectUnauthorized: z.boolean(),
  expectedDatabase: z.string().min(1), expectedRole: z.string().min(1),
  expectedTargetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  developmentOnly: z.literal(true), scope: z.literal('all-existing-development-maps'),
  approval: approvalSchema.optional(),
});
export type OperatorConfig = z.infer<typeof configSchema>;
export type OperatorMode = 'status' | 'migrate' | 'backfill';
type QueryClient = Pick<PoolClient, 'query'>;
type Summary = { maps: number; snapshots: number; initialize: number; match: number; unchanged: number;
  quarantined: number; reasons: Partial<Record<BackfillReason, number>> };

export class CutoverError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new CutoverError(code); }
const normalize = (text: string) => text.replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = <T>(items: T[]) => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function parseOperatorConfig(input: unknown): OperatorConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) fail('invalid_configuration');
  try {
    const url = new URL(parsed.data.connectionString);
    // Require fully explicit credentials/endpoint/database; no pg env fallbacks,
    // service discovery, startup options, or URL overrides of client TLS options.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
      || !url.password || url.pathname.length < 2 || url.search || url.hash) fail('invalid_configuration');
  } catch { fail('invalid_configuration'); }
  return parsed.data;
}

export function assertOperatorRequest(config: OperatorConfig, mode: OperatorMode, confirmation?: string): void {
  if (!['status', 'migrate', 'backfill'].includes(mode)) fail('invalid_mode');
  if (mode === 'status') { if (confirmation !== undefined) fail('invalid_confirmation'); return; }
  if (!config.approval || !config.expectedTargetFingerprint || confirmation !== 'AUTHORIZE_S3B_DEVELOPMENT_WRITE') {
    fail('execution_not_approved');
  }
}

export async function verifyTarget(client: QueryClient, config: OperatorConfig): Promise<string> {
  const { rows: [identity] } = await client.query(`SELECT current_database() AS database_name, current_user AS role_name,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('default_transaction_isolation') AS default_isolation,
    current_setting('server_version_num')::integer AS server_version_num`);
  if (!identity || identity.database_name !== config.expectedDatabase || identity.role_name !== config.expectedRole) fail('target_mismatch');
  if (identity.default_isolation !== 'read committed') fail('incorrect_isolation');
  if (identity.server_version_num < 170000 || identity.server_version_num >= 180000) fail('unsupported_database_version');
  const url = new URL(config.connectionString);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    url.hostname.toLowerCase(), url.port || '5432', url.pathname, url.username,
    identity.database_name, identity.role_name, identity.database_oid,
  ])).digest('hex');
  if (config.expectedTargetFingerprint && config.expectedTargetFingerprint !== fingerprint) fail('target_mismatch');
  return fingerprint;
}

// Parse the already tested A1 schema as a reference, NEVER execute its SQL.
// This intentionally supports only the fixed, observed S1 application schema.
function expectedSchema(baseline: string) {
  const columns: unknown[] = [], constraints: unknown[] = [], indexes: unknown[] = [], tables: string[] = [];
  for (const [, table, body] of baseline.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    tables.push(table);
    for (const line of body.split('\n').map(line => line.trim().replace(/,$/, '')).filter(Boolean)) {
      const column = line.match(/^(\w+) (uuid|integer|text|jsonb|timestamptz)( NOT NULL)?(?: DEFAULT ((?:gen_random_uuid|now)\(\)))?$/);
      if (column) { columns.push([table, column[1], column[2], Boolean(column[3]), column[4] ?? null]); continue; }
      const constraint = line.match(/^CONSTRAINT (\w+) (PRIMARY KEY|UNIQUE|FOREIGN KEY) (.+)$/);
      if (!constraint) fail('unsupported_schema_reference');
      const [, name, kind, rest] = constraint;
      constraints.push([table, name, kind === 'PRIMARY KEY' ? 'p' : kind === 'UNIQUE' ? 'u' : 'f', normalize(`${kind} ${rest}`)]);
      if (kind !== 'FOREIGN KEY') indexes.push([table, name, normalize(`CREATE UNIQUE INDEX ${name} ON ${table} USING btree ${rest}`)]);
    }
  }
  for (const [, name, table, columnsText] of baseline.matchAll(/CREATE INDEX (\w+) ON public\.(\w+) USING btree \(([^)]+)\);/g)) {
    indexes.push([table, name, `CREATE INDEX ${name} ON ${table} USING btree (${columnsText})`]);
  }
  if (tables.length !== 13 || columns.length !== 78 || constraints.length !== 36 || indexes.length !== 28) fail('unsupported_schema_reference');
  return { columns: sorted(columns), constraints: sorted(constraints), indexes: sorted(indexes), tables: tables.sort() };
}

export async function inspectSchema(client: QueryClient, baseline: string): Promise<boolean> {
  const expected = expectedSchema(baseline);
  const tables = (await client.query(`SELECT c.relname AS table_name, c.relkind, c.relrowsecurity,
    (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      OR pg_has_role(c.relowner,'USAGE')) AS can_alter,
    (has_table_privilege(c.oid,'INSERT') AND has_table_privilege(c.oid,'UPDATE')) AS can_write
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`)).rows;
  if (!equal(tables.map(row => row.table_name).sort(), expected.tables)
    || tables.some(row => row.relkind !== 'r' || row.relrowsecurity)) fail('unknown_schema');
  const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS column_name,
    format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind='r'`)).rows;
  const revisionColumns = columns.filter(row => row.table_name === 'maps' && row.column_name === 'current_revision');
  if (revisionColumns.length && (revisionColumns.length !== 1 || revisionColumns[0].data_type !== 'integer'
    || revisionColumns[0].not_null || revisionColumns[0].default_expression !== null)) fail('unexpected_revision_column');
  const ordinary = columns.filter(row => !(row.table_name === 'maps' && row.column_name === 'current_revision'));
  if (!equal(sorted(ordinary.map(row => [row.table_name,row.column_name,row.data_type.replace('timestamp with time zone','timestamptz'),
    row.not_null,row.default_expression === null ? null : normalize(row.default_expression)])), expected.columns)) fail('unknown_schema');
  const constraints = (await client.query(`SELECT c.relname AS table_name,k.conname,k.contype,k.convalidated,k.condeferrable,
    pg_get_constraintdef(k.oid) AS definition FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`)).rows;
  if (constraints.some(row => !row.convalidated || row.condeferrable)
    || !equal(sorted(constraints.map(row => [row.table_name,row.conname,row.contype,normalize(row.definition)])),expected.constraints)) fail('unknown_schema');
  const indexes = (await client.query(`SELECT t.relname AS table_name,i.relname AS index_name,x.indisvalid,x.indisready,
    pg_get_indexdef(x.indexrelid) AS definition FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'`)).rows;
  if (indexes.some(row => !row.indisvalid || !row.indisready)
    || !equal(sorted(indexes.map(row => [row.table_name,row.index_name,normalize(row.definition)])),expected.indexes)) fail('unknown_schema');
  const { rows: [safety] } = await client.query(`SELECT count(*)::integer AS triggers FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal`);
  if (safety.triggers !== 0) fail('unknown_schema');
  if (!tables.find(row => row.table_name === 'maps')?.can_alter
    || tables.filter(row => ['maps','map_versions'].includes(row.table_name)).some(row => !row.can_write)) fail('insufficient_privileges');
  return revisionColumns.length === 1;
}

async function inspectInventory(client: QueryClient, columnPresent: boolean) {
  const maps = (await client.query(`SELECT id,anon_id,data,${columnPresent ? 'current_revision' : 'NULL::integer AS current_revision'}
    FROM public.maps ORDER BY id`)).rows;
  const history = (await client.query(`SELECT v.map_id,v.version,v.data,v.data IS NOT DISTINCT FROM m.data AS matches_current
    FROM public.map_versions v LEFT JOIN public.maps m ON m.id=v.map_id ORDER BY v.map_id,v.version`)).rows;
  const byMap = new Map<string, typeof history>();
  const ids = new Set(maps.map(row => row.id));
  for (const row of history) {
    if (!ids.has(row.map_id)) fail('orphan_history');
    const group = byMap.get(row.map_id) ?? []; group.push(row); byMap.set(row.map_id,group);
  }
  const summary: Summary = { maps: maps.length, snapshots: history.length, initialize: 0, match: 0, unchanged: 0, quarantined: 0, reasons: {} };
  const candidates: StoredOwnerBackfillCandidate[] = [];
  for (const row of maps) {
    if (!isUuid(row.id)) fail('invalid_inventory');
    const plan = planStoredOwnerRevisionBackfill({ anonId: row.anon_id, data: row.data,
      currentRevision: row.current_revision, snapshots: byMap.get(row.id) ?? [] });
    if (plan.action === 'quarantine') { summary.quarantined++; summary.reasons[plan.reason] = (summary.reasons[plan.reason] ?? 0)+1; }
    else { summary[plan.action]++; candidates.push({ mapId: row.id, expectedStoredOwnerId: row.anon_id }); }
  }
  return { summary, candidates };
}

async function inspect(client: QueryClient, config: OperatorConfig, baseline: string) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    await client.query('SET LOCAL search_path=public,pg_catalog');
    const targetFingerprint = await verifyTarget(client,config);
    const columnPresent = await inspectSchema(client,baseline);
    return { targetFingerprint, columnPresent, ...await inspectInventory(client,columnPresent) };
  } finally { await client.query('ROLLBACK'); }
}

export async function runS3bCutover(database: RevisionDatabase, request: {
  config: OperatorConfig; mode: OperatorMode; confirmation?: string; baselineSql: string; migrationSql: string;
}) {
  const config = parseOperatorConfig(request.config);
  assertOperatorRequest(config,request.mode,request.confirmation); // before acquiring any DB connection
  const expectedMigration = "BEGIN; SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '10s'; ALTER TABLE maps ADD COLUMN current_revision integer; COMMIT;";
  if (normalize(request.migrationSql.replace(/--[^\r\n]*/g,'')) !== expectedMigration) fail('unexpected_migration');
  const client = await database.connect();
  try {
    const before = await inspect(client,config,request.baselineSql);
    const publicStatus = (state: typeof before) => ({ targetFingerprint: state.targetFingerprint,
      targetPinned: Boolean(config.expectedTargetFingerprint), columnPresent: state.columnPresent,
      readyForBackfill: state.summary.quarantined === 0,
      revisionReady: state.columnPresent && state.summary.unchanged === state.summary.maps,
      summary: state.summary });
    if (request.mode === 'status') return publicStatus(before);
    if (before.summary.quarantined) fail('quarantined_inventory');
    if (request.mode === 'migrate') {
      if (before.columnPresent) fail('unexpected_revision_column');
      try { await client.query(request.migrationSql); }
      catch { try { await client.query('ROLLBACK'); } catch { /* Stop on uncertain outcome. */ } fail('migration_failed'); }
    } else {
      if (!before.columnPresent) fail('migration_required');
      // Reuse the one verified session; nested helpers release only their lease.
      const lease = Object.create(client) as PoolClient;
      lease.query = client.query.bind(client); lease.release = () => {};
      const pinned: RevisionDatabase = { connect: (async () => lease) as RevisionDatabase['connect'] };
      for (let offset=0; offset<before.candidates.length; offset+=100) {
        await backfillStoredOwnerRevisions(pinned,before.candidates.slice(offset,offset+100));
      }
    }
    const after = await inspect(client,config,request.baselineSql);
    if (!after.columnPresent) fail('migration_failed');
    if (after.summary.quarantined || !equal(before.candidates,after.candidates)) fail('inventory_changed');
    if (request.mode === 'backfill' && after.summary.unchanged !== after.summary.maps) fail('backfill_incomplete');
    return publicStatus(after);
  } catch (error) {
    // Raw SQL/provider errors can contain credentials, identifiers and payloads.
    if (error instanceof CutoverError) throw error;
    fail('operator_failed');
  } finally { client.release(); }
}
