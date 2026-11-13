import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { MapprSystemSchema, type MapprSystem } from '../../schema/mapprSystem.js';
import { ApplyRequestSchema, PreviewRequestSchema, RejectRequestSchema, type PreviewRequest } from '../../schema/changeProposal.js';
import { isUuid } from '../../middleware/anonSession.js';
import { revisionTransaction, type RevisionDatabase } from '../../db/revisionTransaction.js';
import { readRevisionedMap, CanonicalMapNotFoundError, RevisionNotReadyError } from '../canonicalRevision.js';
import { MAX_REVISION } from '../revisionState.js';
import { ChangeError, safeChangeError, type ChangeErrorCode } from './errors.js';
import { fingerprint, resolveChangeHandler } from './overview.js';
import { conservativeArtifacts } from './artifacts.js';
import { proposalTtlSeconds } from './availability.js';
import { blockedPreviewAdmission, type PreviewAdmission } from './admission.js';
import { generateOverviewSummary, OVERVIEW_GENERATOR_ID, generateArchitectureChange, ARCHITECTURE_GENERATOR_ID,
  generateTechStackChange, TECH_STACK_GENERATOR_ID, generateDatabaseChange, DATABASE_GENERATOR_ID } from './provider.js';
import { createDailyPreviewAdmission } from './dailyAdmission.js';

type Json = Record<string, any>;
interface Proposal {
  id: string; map_id: string; actor_id: string; request_digest: string; base_revision: number;
  base_fingerprint: string; state: string; admitted_at: Date; lease_expires_at: Date;
  expires_at: Date | null; candidate_fingerprint: string | null; preview_response: Json | null;
  terminal_error: { code: ChangeErrorCode; details: Json } | null;
  validation_policy: unknown; apply_receipt: Json | null;
  request_payload: PreviewRequest;
}
type Outcome = { response: Json; replayed: boolean } | { error: ChangeError };
type Generator = (base: MapprSystem, instruction: string, signal: AbortSignal, context: PreviewRequest['context']) => Promise<unknown>;
interface Dependencies {
  database: RevisionDatabase;
  // Production retains the release interlock AND default-off daily admission.
  // Offline consumers must explicitly inject a non-billing admission fixture.
  generate: Generator;
  generatorId: string | ((context: PreviewRequest['context']) => string);
  admission?: PreviewAdmission;
  ttlSeconds?: () => number;
  generationTimeoutMs?: number; // Short deterministic offline tests; default 120s.
}
const unwrap = (outcome: Outcome) => { if ('error' in outcome) throw outcome.error; return outcome; };
const terminal = (code: ChangeErrorCode, details: Json = {}) => ({ error: new ChangeError(code, details) });

export class ChangeEngine {
  constructor(private readonly deps: Dependencies) {}
  private get admission(): PreviewAdmission { return this.deps.admission ?? blockedPreviewAdmission; }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return revisionTransaction(this.deps.database, async client => {
      // Explicit for this new writer; legacy S3 behavior remains unchanged.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      return work(client);
    });
  }
  private async lockMap(client: PoolClient, mapId: string, actorId: string) {
    const { rows: [map] } = await client.query(`/* changes:lock-map */
      SELECT id,anon_id,data::text AS canonical_text FROM public.maps WHERE id=$1 FOR UPDATE`, [mapId]);
    if (!map || map.anon_id !== actorId.toLowerCase()) throw new ChangeError('not_found');
    return map as { id: string; anon_id: string; canonical_text: string };
  }
  private async now(client: PoolClient): Promise<Date> {
    return (await client.query('/* changes:clock */ SELECT clock_timestamp() AS now')).rows[0].now;
  }
  private async coherent(client: PoolClient, mapId: string) {
    try { return await readRevisionedMap(mapId, client); }
    catch (error) {
      if (error instanceof CanonicalMapNotFoundError) throw new ChangeError('not_found');
      if (error instanceof RevisionNotReadyError) throw new ChangeError('revision_not_ready');
      throw error;
    }
  }
  private async proposal(client: PoolClient, mapId: string, actorId: string, proposalId: string): Promise<Proposal> {
    const { rows: [row] } = await client.query(`/* changes:proposal */ SELECT * FROM public.map_change_proposals
      WHERE id=$1 AND map_id=$2 AND actor_id=$3 FOR UPDATE`, [proposalId, mapId, actorId]);
    if (!row) throw new ChangeError('not_found');
    return row;
  }
  private async fail(client: PoolClient, proposal: Proposal, code: ChangeErrorCode, details: Json = {}, state = 'failed'): Promise<Outcome> {
    const error = { code, details };
    const saved = await client.query(`/* changes:fail */ UPDATE public.map_change_proposals
      SET state=$2,terminal_error=$3 WHERE id=$1 AND state='generating'`, [proposal.id, state, JSON.stringify(error)]);
    if (saved.rowCount !== 1) throw new ChangeError('proposal_not_ready');
    await this.admission.failed(client, { proposalId: proposal.id, mapId: proposal.map_id, actorId: proposal.actor_id }, code);
    return terminal(code, details);
  }
  private async replayPreview(client: PoolClient, proposal: Proposal): Promise<Outcome> {
    // Ready responses are immutable, including after expiry/conflict/application.
    if (proposal.preview_response) return { response: proposal.preview_response, replayed: true };
    if (proposal.terminal_error) return terminal(proposal.terminal_error.code, proposal.terminal_error.details);
    if (proposal.state !== 'generating') return terminal('proposal_not_ready');
    const now = await this.now(client);
    if (now >= proposal.lease_expires_at) return this.fail(client, proposal, 'generation_timeout');
    return terminal('preview_in_progress');
  }
  private async project(client: PoolClient, mapId: string, candidate: MapprSystem, handler: ReturnType<typeof resolveChangeHandler>) {
    return (await client.query(`/* changes:project */ SELECT candidate,candidate::text AS candidate_text
      FROM (SELECT ${handler.expression} AS candidate
        FROM public.maps WHERE id=$1) projected`, [mapId, handler.storageValue(candidate)])).rows[0] as { candidate: MapprSystem; candidate_text: string };
  }
  async preview(mapId: string, actorId: string, key: string, input: unknown) {
    const parsed = PreviewRequestSchema.safeParse(input);
    if (!isUuid(mapId) || !isUuid(actorId) || !isUuid(key) || !parsed.success) throw new ChangeError('invalid_request');
    const request = parsed.data;
    const handler = resolveChangeHandler(request.context);
    const digest = fingerprint(JSON.stringify(request));
    await this.admission.recover?.();
    const admission = await this.transaction(async client => {
      const locked = await this.lockMap(client, mapId, actorId);
      const { rows: [existing] } = await client.query(`/* changes:key */ SELECT * FROM public.map_change_proposals
        WHERE actor_id=$1 AND map_id=$2 AND preview_key=$3 FOR UPDATE`, [actorId, mapId, key]);
      if (existing) {
        if (existing.request_digest !== digest) throw new ChangeError('idempotency_key_reused');
        return { outcome: await this.replayPreview(client, existing) };
      }
      const base = await this.coherent(client, mapId);
      if (base.current_revision !== request.expectedBaseRevision) throw new ChangeError('revision_conflict', {
        expectedBaseRevision: request.expectedBaseRevision, currentRevision: base.current_revision,
      });
      handler.validateBase(base.data, request.context);
      const ttl = (this.deps.ttlSeconds ?? proposalTtlSeconds)();
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new ChangeError('temporarily_unavailable');
      const now = await this.now(client), id = randomUUID();
      this.admission.assertConfigured(); // Fail before proposal INSERT or provider work.
      const reserved = await client.query(`/* changes:reserve */ INSERT INTO public.map_change_proposals
        (id,map_id,actor_id,preview_key,request_digest,request_payload,base_revision,base_fingerprint,state,
         admitted_at,lease_expires_at,validation_policy,generator_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generating',$9,$10,$11,$12)`,
      [id, mapId, actorId, key, digest, JSON.stringify(request), base.current_revision, fingerprint(locked.canonical_text),
        now, new Date(now.getTime() + 180000), JSON.stringify(handler.policy),
        typeof this.deps.generatorId === 'function' ? this.deps.generatorId(request.context) : this.deps.generatorId]);
      if (reserved.rowCount !== 1) throw new ChangeError('internal_error');
      await this.admission.reserve(client, { proposalId: id, mapId, actorId, requestDigest: digest,
        admittedAt: now, leaseExpiresAt: new Date(now.getTime() + 180000) });
      return { id, base: base.data, ttl };
    });
    if ('outcome' in admission) return unwrap(admission.outcome!);
    const proposalId = admission.id!;
    const ttl = admission.ttl!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let publishing = false;
    const controller = new AbortController();
    try {
      // All connections/locks are released before the injected generation adapter.
      const output = await Promise.race([
        this.deps.generate(structuredClone(admission.base!), request.instruction, controller.signal, structuredClone(request.context)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new ChangeError('generation_timeout'));
        }, this.deps.generationTimeoutMs ?? 120000); }),
      ]);
      if (timer) clearTimeout(timer);
      const validated = handler.candidate(admission.base!, output, request.context);
      publishing = true;
      const outcome = await this.transaction(async client => {
        const locked = await this.lockMap(client, mapId, actorId);
        const proposal = await this.proposal(client, mapId, actorId, proposalId);
        if (proposal.state !== 'generating') return this.replayPreview(client, proposal);
        const now = await this.now(client);
        if (now >= proposal.lease_expires_at || now.getTime() >= proposal.admitted_at.getTime() + 120000) {
          return this.fail(client, proposal, 'generation_timeout');
        }
        const current = await this.coherent(client, mapId);
        if (current.current_revision !== proposal.base_revision) return this.fail(client, proposal, 'revision_conflict', {
          expectedBaseRevision: proposal.base_revision, currentRevision: current.current_revision,
        }, 'conflicted');
        if (fingerprint(locked.canonical_text) !== proposal.base_fingerprint) return this.fail(client, proposal, 'revision_not_ready');
        const projection = await this.project(client, mapId, validated.candidate, handler);
        if (!isDeepStrictEqual(projection.candidate, validated.candidate)) return this.fail(client, proposal, 'change_not_valid');
        const artifacts = await conservativeArtifacts(client, mapId, projection.candidate_text, proposal.base_revision + 1);
        const readyAt = await this.now(client);
        if (readyAt >= proposal.lease_expires_at || readyAt.getTime() >= proposal.admitted_at.getTime() + 120000) {
          return this.fail(client, proposal, 'generation_timeout');
        }
        const response = { contractVersion: 1, mapId, proposalId, status: 'ready', baseRevision: proposal.base_revision,
          context: request.context, createdAt: readyAt.toISOString(), expiresAt: new Date(readyAt.getTime() + ttl * 1000).toISOString(),
          summary: validated.summary, operations: validated.operations, diff: validated.diff, affectedSections: handler.affectedSections,
          warnings: handler.warnings, artifactImpacts: artifacts.artifactImpacts,
          artifactImpactsContext: { asOfRevision: proposal.base_revision + 1, semantics: 'proposed_revision_snapshot' } };
        const saved = await client.query(`/* changes:ready */ UPDATE public.map_change_proposals SET state='ready',
          ready_at=$2,expires_at=$3,candidate_fingerprint=$4,preview_response=$5 WHERE id=$1 AND state='generating'
          AND lease_expires_at>clock_timestamp() AND admitted_at+interval '120 seconds'>clock_timestamp()`,
        [proposalId, readyAt, new Date(response.expiresAt), fingerprint(projection.candidate_text), JSON.stringify(response)]);
        if (saved.rowCount !== 1) return this.fail(client, proposal, 'generation_timeout');
        await this.admission.ready(client, { proposalId, mapId, actorId });
        return { response, replayed: false };
      });
      return unwrap(outcome);
    } catch (error) {
      // A COMMIT can be uncertain. Never overwrite a saved ready/applied result;
      // only a still-generating row can become a terminal failure.
      // Unknown publication/COMMIT errors have uncertain outcomes. Preserve the
      // durable row, and let a same-key retry read it; never blindly regenerate.
      if (publishing && !(error instanceof ChangeError)) throw safeChangeError(error);
      const safe = error instanceof ChangeError ? error : new ChangeError('change_generation_failed');
      try {
        const outcome = await this.transaction(async client => {
          await this.lockMap(client, mapId, actorId);
          const proposal = await this.proposal(client, mapId, actorId, proposalId);
          if (proposal.state !== 'generating') return this.replayPreview(client, proposal);
          return this.fail(client, proposal, safe.code, safe.details);
        });
        return unwrap(outcome);
      } catch (recordingError) { throw safeChangeError(recordingError); }
    } finally { if (timer) clearTimeout(timer); }
  }
  async apply(mapId: string, actorId: string, proposalId: string, input: unknown) {
    const parsed = ApplyRequestSchema.safeParse(input);
    if (!isUuid(mapId) || !isUuid(actorId) || !isUuid(proposalId) || !parsed.success) throw new ChangeError('invalid_request');
    const outcome = await this.transaction(async client => {
      const locked = await this.lockMap(client, mapId, actorId);
      const proposal = await this.proposal(client, mapId, actorId, proposalId);
      if (parsed.data.expectedBaseRevision !== proposal.base_revision) throw new ChangeError('proposal_mismatch');
      if (proposal.state === 'applied') {
        if (!proposal.apply_receipt) throw new ChangeError('proposal_not_ready');
        return { response: proposal.apply_receipt, replayed: true };
      }
      if (proposal.state === 'expired') return terminal('proposal_expired', { expiresAt: proposal.expires_at?.toISOString() });
      if (['conflicted', 'failed'].includes(proposal.state) && proposal.terminal_error) return terminal(proposal.terminal_error.code, proposal.terminal_error.details);
      if (proposal.state !== 'ready' || !proposal.preview_response) throw new ChangeError('proposal_not_ready');
      const now = await this.now(client); // Database clock AFTER both locks.
      if (!proposal.expires_at || now >= proposal.expires_at) {
        await client.query("/* changes:expire */ UPDATE public.map_change_proposals SET state='expired' WHERE id=$1", [proposalId]);
        return terminal('proposal_expired', { expiresAt: proposal.expires_at?.toISOString() });
      }
      let handler: ReturnType<typeof resolveChangeHandler>;
      try { handler = resolveChangeHandler(proposal.preview_response.context); }
      catch { throw new ChangeError('proposal_obsolete'); }
      if (!isDeepStrictEqual(proposal.validation_policy, handler.policy)
        || !isDeepStrictEqual(proposal.request_payload?.context, proposal.preview_response.context)) throw new ChangeError('proposal_obsolete');
      if (proposal.preview_response.contractVersion !== 1 || proposal.preview_response.status !== 'ready'
        || proposal.preview_response.proposalId !== proposalId || proposal.preview_response.mapId !== mapId
        || proposal.preview_response.baseRevision !== proposal.base_revision) throw new ChangeError('proposal_obsolete');
      const current = await this.coherent(client, mapId); // Fresh statement after lock.
      if (current.current_revision !== proposal.base_revision) {
        const details = { proposalId, expectedBaseRevision: proposal.base_revision, currentRevision: current.current_revision };
        await client.query(`/* changes:conflict */ UPDATE public.map_change_proposals SET state='conflicted',terminal_error=$2
          WHERE id=$1 AND state='ready'`, [proposalId, JSON.stringify({ code: 'revision_conflict', details })]);
        return terminal('revision_conflict', details);
      }
      if (fingerprint(locked.canonical_text) !== proposal.base_fingerprint || current.current_revision === MAX_REVISION) throw new ChangeError('revision_not_ready');
      const expected = handler.revalidate(current.data, proposal.preview_response);
      const projected = await this.project(client, mapId, expected.candidate, handler);
      if (fingerprint(projected.candidate_text) !== proposal.candidate_fingerprint
        || !isDeepStrictEqual(projected.candidate, expected.candidate)) throw new ChangeError('proposal_obsolete');
      const revision = current.current_revision + 1;
      // Patch only the handler's fixed JSONB scope. Copy exact resulting JSONB into
      // history with INSERT SELECT; unrelated numeric/extension data is preserved.
      const updated = await client.query(`/* changes:update-map */ UPDATE public.maps
        SET data=${handler.expression},current_revision=$3,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING data,data::text AS canonical_text,updated_at`, [mapId, handler.storageValue(expected.candidate), revision]);
      if (updated.rowCount !== 1 || fingerprint(updated.rows[0].canonical_text) !== proposal.candidate_fingerprint
        || !MapprSystemSchema.safeParse(updated.rows[0].data).success) throw new ChangeError('proposal_obsolete');
      const metadata = { kind: 'proposal', baseRevision: proposal.base_revision, actorId,
        operations: expected.operations, diff: expected.diff, validationPolicy: handler.policy };
      const snapshot = await client.query(`/* changes:snapshot */ INSERT INTO public.map_versions
        (map_id,version,data,patch,summary,proposal_id,change_metadata)
        SELECT id,$2,data,NULL,$3,$4,$5 FROM public.maps WHERE id=$1`,
      [mapId, revision, expected.summary, proposalId, JSON.stringify(metadata)]);
      if (snapshot.rowCount !== 1) throw new ChangeError('internal_error');
      const artifacts = await conservativeArtifacts(client, mapId);
      const receipt = { contractVersion: 1, mapId, proposalId, status: 'applied', previousRevision: proposal.base_revision,
        revision, version: revision, appliedAt: updated.rows[0].updated_at.toISOString(), summary: expected.summary,
        data: updated.rows[0].data, diff: expected.diff, affectedSections: handler.affectedSections, warnings: handler.warnings,
        artifactFreshness: artifacts.artifactFreshness,
        artifactFreshnessContext: { asOfRevision: revision, semantics: 'transaction_snapshot' } };
      const applied = await client.query(`/* changes:applied */ UPDATE public.map_change_proposals SET state='applied',
        applied_revision=$2,applied_at=$3,apply_receipt=$4 WHERE id=$1 AND state='ready'`,
      [proposalId, revision, updated.rows[0].updated_at, JSON.stringify(receipt)]);
      if (applied.rowCount !== 1) throw new ChangeError('proposal_not_ready');
      return { response: receipt, replayed: false };
    });
    return unwrap(outcome);
  }
  async reject(mapId: string, actorId: string, proposalId: string, input: unknown) {
    const parsed = RejectRequestSchema.safeParse(input);
    if (!isUuid(mapId) || !isUuid(actorId) || !isUuid(proposalId) || !parsed.success) throw new ChangeError('invalid_request');
    return this.transaction(async client => {
      await this.lockMap(client, mapId, actorId);
      const proposal = await this.proposal(client, mapId, actorId, proposalId);
      if (parsed.data.expectedBaseRevision !== proposal.base_revision) throw new ChangeError('proposal_mismatch');
      if (proposal.state === 'failed' && proposal.terminal_error?.code === 'proposal_rejected') {
        return { response: proposal.terminal_error.details, replayed: true };
      }
      if (proposal.state !== 'ready') throw new ChangeError('proposal_not_ready');
      const response = { contractVersion: 1, mapId, proposalId, status: 'rejected', baseRevision: proposal.base_revision,
        rejectedAt: (await this.now(client)).toISOString() };
      // Existing failed+terminal_error storage represents an explicit terminal
      // rejection. Ready-generation usage is retained; rejection never calls AI.
      const result = await client.query(`/* changes:reject */ UPDATE public.map_change_proposals
        SET state='failed',terminal_error=$2 WHERE id=$1 AND state='ready'`,
      [proposalId, JSON.stringify({ code: 'proposal_rejected', details: response })]);
      if (result.rowCount !== 1) throw new ChangeError('proposal_not_ready');
      return { response, replayed: false };
    });
  }
}

export function createChangeEngine(database: Pick<Pool, 'connect'>) {
  return new ChangeEngine({ database,
    generatorId: context => context.activeView === 'database' ? DATABASE_GENERATOR_ID : context.activeView === 'tech-stack' ? TECH_STACK_GENERATOR_ID
      : context.activeView === 'architecture' ? ARCHITECTURE_GENERATOR_ID : OVERVIEW_GENERATOR_ID,
    generate: (base, instruction, signal, context) => context.activeView === 'database'
      ? generateDatabaseChange(base, instruction, signal, context) : context.activeView === 'tech-stack'
        ? generateTechStackChange(base, instruction, signal, context) : context.activeView === 'architecture'
        ? generateArchitectureChange(base, instruction, signal, context) : generateOverviewSummary(base, instruction, signal),
    admission: createDailyPreviewAdmission() });
}
export const createOverviewChangeEngine = createChangeEngine;
// Preserve the previous internal factory name; daily-admission rollout is default off.
export const createUnconfiguredChangeEngine = createOverviewChangeEngine;
