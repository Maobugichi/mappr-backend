import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Response } from 'express';
import { pool } from '../db/pool.js';
import { revisionTransaction, type RevisionDatabase } from '../db/revisionTransaction.js';
import { FREE_DAILY_LIMIT, GLOBAL_DAILY_CEILING } from './rateLimit.js';
import { ARTIFACTS, type ArtifactType } from './artifacts/registry.js';

export const DAILY_POLICY = 'daily-success-v1';
export type DailyOperation = 'generate' | 'iterate' | 'overview_preview' | ArtifactType;
export interface DailyAttempt { id: string; actorId: string; mapId: string | null; operation: DailyOperation; proposalId: string | null }
interface Intent { actorId: string; operation: DailyOperation; mapId?: string | null; id?: string; proposalId?: string | null; leaseExpiresAt?: Date }
interface AttemptRow { id: string; actor_id: string; map_id: string | null; proposal_id: string | null; operation: DailyOperation;
  state: string; lease_expires_at: Date; quota_day_start: Date; quota_day_end: Date; policy_version: string }
export function dailyAdmissionEnabled() { return process.env.MAPPR_DAILY_ADMISSION_ENABLED === 'true'; }
export class DailyAdmissionError extends Error {
  constructor(readonly code: 'daily_limit_exceeded' | 'capacity_exceeded' | 'attempt_limit_exceeded' | 'daily_admission_not_ready' | 'attempt_expired' | 'attempt_in_progress' | 'not_found') { super(code); }
  get status() { return this.code === 'not_found' ? 404 : this.code === 'capacity_exceeded' || this.code === 'daily_admission_not_ready' ? 503 : this.code === 'attempt_expired' || this.code === 'attempt_in_progress' ? 409 : 429; }
}
export function dailyRouteError(res: Response, error: unknown): boolean {
  if (!(error instanceof DailyAdmissionError)) return false;
  const message = error.code === 'daily_limit_exceeded' ? 'Your daily generation allowance is exhausted.'
    : error.code === 'capacity_exceeded' ? 'Mappr has hit its daily generation capacity. Please try again later.'
    : error.code === 'attempt_limit_exceeded' ? 'Too many generation attempts today. Please try again later.'
    : 'Generation admission is temporarily unavailable. Refresh saved state before retrying.';
  res.status(error.status).json({ error: error.code, message }); return true;
}
const positive = (raw: string | number, zero = false) => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new DailyAdmissionError('daily_admission_not_ready');
  return value;
};
export class DailyAdmission {
  constructor(private readonly database: RevisionDatabase = pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    try {
      return await revisionTransaction(this.database, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); return work(client);
      });
    } catch (error) {
      if (error instanceof DailyAdmissionError) throw error;
      throw new DailyAdmissionError('daily_admission_not_ready');
    }
  }
  assertConfigured() {
    if (!dailyAdmissionEnabled()) throw new DailyAdmissionError('daily_admission_not_ready');
    this.limits();
  }
  private limits() {
    return { actor: positive(FREE_DAILY_LIMIT, true), global: positive(GLOBAL_DAILY_CEILING, true),
      actorAttempts: positive(process.env.DAILY_AI_ATTEMPT_LIMIT ?? 10),
      globalAttempts: positive(process.env.GLOBAL_DAILY_AI_ATTEMPT_LIMIT ?? 1000) };
  }
  private async budgetLocks(client: PoolClient, actorId: string) {
    // Global, then actor. Hash collisions only cause extra serialization.
    // Never acquire a map/proposal/artifact lock after these quota locks.
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query('/* daily:global */ SELECT pg_advisory_xact_lock(1296126034,0)');
    await client.query('/* daily:actor */ SELECT pg_advisory_xact_lock(1296126035,hashtext($1))', [actorId]);
  }
  private async bucket(client: PoolClient) {
    const { rows: [row] } = await client.query(`/* daily:bucket */ WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now) SELECT clock.now,
      date_trunc('day',clock.now) AS day_start,
      date_trunc('day',clock.now)+interval '1 day' AS day_end,
      current_setting('TimeZone') AS timezone,p.quota_timezone,p.policy_version
      FROM public.daily_admission_policy p CROSS JOIN clock WHERE singleton=true`);
    if (!row || row.timezone !== row.quota_timezone || row.policy_version !== DAILY_POLICY) throw new DailyAdmissionError('daily_admission_not_ready');
    return row;
  }
  async reserve(intent: Intent): Promise<DailyAttempt | undefined> {
    if (!dailyAdmissionEnabled()) return undefined; // Explicit pre-migration compatibility mode.
    this.assertConfigured(); await this.recoverExpired();
    return this.transaction(async client => {
      if (intent.mapId) {
        const { rows: [map] } = await client.query('/* daily:map */ SELECT id,anon_id FROM public.maps WHERE id=$1 FOR UPDATE', [intent.mapId]);
        if (!map || map.anon_id !== intent.actorId.toLowerCase()) throw new DailyAdmissionError('not_found');
      }
      return this.reserveInTransaction(client, intent);
    });
  }
  async reserveInTransaction(client: PoolClient, intent: Intent): Promise<DailyAttempt> {
    this.assertConfigured();
    const attempt: DailyAttempt = { id: intent.id ?? randomUUID(), actorId: intent.actorId.toLowerCase(),
      mapId: intent.mapId ?? null, operation: intent.operation, proposalId: intent.proposalId ?? null };
    await this.budgetLocks(client, attempt.actorId);
    const bucket = await this.bucket(client), limits = this.limits();
    const { rows: [counts] } = await client.query(`/* daily:counts */ WITH used AS (
      SELECT g.anon_id FROM public.generations g
        WHERE g.attempt_id IS NULL AND g.created_at >= $1 AND g.created_at < $2
      UNION ALL SELECT g.anon_id FROM public.generation_attempts a JOIN public.generations g ON g.attempt_id=a.id
        WHERE a.quota_day_start=$1 AND a.quota_day_end=$2
      UNION ALL SELECT actor_id FROM public.generation_attempts
        WHERE state='reserved' AND quota_day_start=$1 AND quota_day_end=$2
    ) SELECT (SELECT count(*)::integer FROM used) AS global_used,
      (SELECT count(*)::integer FROM used WHERE anon_id=$3) AS actor_used,
      (SELECT count(*)::integer FROM public.generation_attempts WHERE quota_day_start=$1 AND quota_day_end=$2) AS global_attempts,
      (SELECT count(*)::integer FROM public.generation_attempts WHERE quota_day_start=$1 AND quota_day_end=$2 AND actor_id=$3) AS actor_attempts`,
    [bucket.day_start, bucket.day_end, attempt.actorId]);
    if (counts.global_used >= limits.global) throw new DailyAdmissionError('capacity_exceeded');
    if (counts.actor_used >= limits.actor) throw new DailyAdmissionError('daily_limit_exceeded');
    if (counts.global_attempts >= limits.globalAttempts || counts.actor_attempts >= limits.actorAttempts) throw new DailyAdmissionError('attempt_limit_exceeded');
    const lease = new Date(Math.min(bucket.now.getTime() + 180000, intent.leaseExpiresAt?.getTime() ?? Infinity));
    const saved = await client.query(`/* daily:reserve */ INSERT INTO public.generation_attempts
      (id,actor_id,map_id,proposal_id,operation,policy_version,quota_day_start,quota_day_end,quota_timezone,state,admitted_at,lease_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11) ON CONFLICT (id) DO NOTHING`,
    [attempt.id, attempt.actorId, attempt.mapId, attempt.proposalId, attempt.operation, DAILY_POLICY,
      bucket.day_start, bucket.day_end, bucket.timezone, bucket.now, lease]);
    if (saved.rowCount !== 1) throw new DailyAdmissionError('attempt_in_progress');
    return attempt;
  }
  private async locked(client: PoolClient, attempt: DailyAttempt): Promise<AttemptRow> {
    await this.budgetLocks(client, attempt.actorId);
    const { rows: [row] } = await client.query('/* daily:attempt */ SELECT * FROM public.generation_attempts WHERE id=$1 FOR UPDATE', [attempt.id]);
    if (!row || row.actor_id !== attempt.actorId || row.operation !== attempt.operation || row.proposal_id !== attempt.proposalId
      || (row.map_id !== attempt.mapId && !(attempt.operation === 'generate' && attempt.mapId === null)) || row.policy_version !== DAILY_POLICY) {
      throw new DailyAdmissionError('daily_admission_not_ready');
    }
    return row;
  }
  async success(client: PoolClient, attempt: DailyAttempt, mapId: string) {
    if (attempt.mapId !== null && attempt.mapId !== mapId) throw new DailyAdmissionError('daily_admission_not_ready');
    const row = await this.locked(client, attempt);
    if (row.state === 'succeeded') throw new DailyAdmissionError('attempt_in_progress'); // Refuse another publication; inspect saved identity instead.
    if (row.state !== 'reserved') throw new DailyAdmissionError('attempt_expired');
    const saved = await client.query(`/* daily:succeed */ UPDATE public.generation_attempts
      SET state='succeeded',finished_at=clock_timestamp(),map_id=$2
      WHERE id=$1 AND state='reserved' AND lease_expires_at>clock_timestamp()`, [attempt.id, mapId]);
    if (saved.rowCount !== 1) throw new DailyAdmissionError('attempt_expired');
    const usage = await client.query(`/* daily:usage */ INSERT INTO public.generations (anon_id,map_id,attempt_id)
      VALUES ($1,$2,$3)`, [attempt.actorId, mapId, attempt.id]);
    if (usage.rowCount !== 1) throw new DailyAdmissionError('daily_admission_not_ready');
  }
  private async publicationLocks(client: PoolClient, attempt: DailyAttempt) {
    if (attempt.mapId) await client.query('/* daily:map */ SELECT id,anon_id,current_revision FROM public.maps WHERE id=$1 FOR UPDATE', [attempt.mapId]);
    if (attempt.proposalId) await client.query('/* daily:proposal-lock */ SELECT id FROM public.map_change_proposals WHERE id=$1 FOR UPDATE', [attempt.proposalId]);
    if (Object.hasOwn(ARTIFACTS, attempt.operation) && attempt.mapId) {
      const table = ARTIFACTS[attempt.operation as ArtifactType].table;
      await client.query(`/* daily:artifact-lock */ SELECT id FROM public.${table} WHERE map_id=$1 ORDER BY id FOR UPDATE`, [attempt.mapId]);
    }
  }
  async failureInTransaction(client: PoolClient, attempt: DailyAttempt, expiredOnly = false) {
    const row = await this.locked(client, attempt);
    if (row.state !== 'reserved') return;
    const { rows: [proof] } = await client.query(`/* daily:proof */ SELECT clock_timestamp() AS now,
      EXISTS(SELECT 1 FROM public.generations WHERE attempt_id=$1) AS used,
      (SELECT state FROM public.map_change_proposals WHERE id=$2) AS proposal_state,
      EXISTS(SELECT 1 FROM public.artifact_generations WHERE id=$1 AND origin='generated') AS artifact_saved`, [attempt.id, attempt.proposalId]);
    if (expiredOnly && proof.now < row.lease_expires_at) return;
    if (proof.used || proof.artifact_saved || ['ready','applied','expired'].includes(proof.proposal_state)) throw new DailyAdmissionError('daily_admission_not_ready');
    if (attempt.proposalId && proof.proposal_state === 'generating') {
      const changed = await client.query(`/* daily:expire-proposal */ UPDATE public.map_change_proposals SET state='failed',
        terminal_error='{"code":"generation_timeout","details":{}}'::jsonb WHERE id=$1 AND state='generating'`, [attempt.proposalId]);
      if (changed.rowCount !== 1) throw new DailyAdmissionError('daily_admission_not_ready');
    }
    const failed = await client.query(`/* daily:fail */ UPDATE public.generation_attempts SET state='failed',finished_at=clock_timestamp()
      WHERE id=$1 AND state='reserved'`, [attempt.id]);
    if (failed.rowCount !== 1) throw new DailyAdmissionError('daily_admission_not_ready');
  }
  async failure(attempt: DailyAttempt) {
    return this.transaction(async client => { await this.publicationLocks(client, attempt); await this.failureInTransaction(client, attempt); });
  }
  async recoverExpired() {
    this.assertConfigured();
    const expired = await this.transaction(client => client.query(`/* daily:expired */ SELECT id,actor_id,map_id,proposal_id,operation
      FROM public.generation_attempts WHERE state='reserved' AND lease_expires_at<=clock_timestamp()
      ORDER BY lease_expires_at,id LIMIT 50`));
    for (const row of expired.rows) {
      const attempt = { id: row.id, actorId: row.actor_id, mapId: row.map_id, proposalId: row.proposal_id, operation: row.operation };
      await this.transaction(async client => { await this.publicationLocks(client, attempt); await this.failureInTransaction(client, attempt, true); });
    }
  }
}
export const dailyAdmission = new DailyAdmission();
export const reserveDailyAttempt = (intent: Intent) => dailyAdmission.reserve(intent);
export async function recordSuccessfulGeneration(client: PoolClient, actorId: string, mapId: string, attempt?: DailyAttempt) {
  if (attempt) {
    if (attempt.actorId !== actorId.toLowerCase() || (attempt.mapId !== null && attempt.mapId !== mapId)) throw new DailyAdmissionError('daily_admission_not_ready');
    try { return await dailyAdmission.success(client, attempt, mapId); }
    catch (error) {
      if (error instanceof DailyAdmissionError) throw error;
      throw new DailyAdmissionError('daily_admission_not_ready');
    }
  }
  if (dailyAdmissionEnabled()) throw new DailyAdmissionError('daily_admission_not_ready');
  const saved = await client.query('INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)', [actorId, mapId]);
  if (saved.rowCount !== 1) throw new Error('Generation usage was not written');
}
export async function cleanupDailyAttempt(attempt?: DailyAttempt) {
  if (!attempt) return;
  try { await dailyAdmission.failure(attempt); }
  catch { console.error('[dailyAdmission] Outcome requires durable recovery'); } // Preserve hold on uncertainty.
}
