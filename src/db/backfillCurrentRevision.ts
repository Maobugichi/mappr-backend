import { isUuid } from '../middleware/anonSession.js';
import { planRevisionBackfill, planStoredOwnerRevisionBackfill, type BackfillReason } from '../services/revisionState.js';
import { revisionTransaction, type RevisionDatabase } from './revisionTransaction.js';

export interface ReviewedBackfillCandidate {
  mapId: string;
  // Explicit operator-reviewed creator identity; never inferred from a visitor.
  verifiedOwnerId?: string;
}

// Export-only S3B operator procedure. No pool, env, CLI, startup, or npm hook.
// DO NOT invoke against any database until the separate S3B review/backup step.
// Keep candidate IDs private; the returned summary contains counts/reasons only.
export async function backfillCurrentRevisions(database: RevisionDatabase, candidates: readonly ReviewedBackfillCandidate[]) {
  return backfill(database, candidates);
}

export interface StoredOwnerBackfillCandidate {
  mapId: string;
  // Captured by a target-verified maintenance inventory, NOT an editor identity.
  expectedStoredOwnerId: string;
}

// Only the explicit S3B operator calls this path. Recheck the captured metadata
// under the map lock and stop at the first missing/quarantined record.
export async function backfillStoredOwnerRevisions(database: RevisionDatabase, candidates: readonly StoredOwnerBackfillCandidate[]) {
  return backfill(database, candidates, true);
}

async function backfill(database: RevisionDatabase, candidates: readonly (ReviewedBackfillCandidate | StoredOwnerBackfillCandidate)[], maintenance = false) {
  if (candidates.length > 100 || candidates.some(item => !isUuid(item.mapId))
    || new Set(candidates.map(item => item.mapId.toLowerCase())).size !== candidates.length) {
    throw new Error('Backfill requires a reviewed batch of at most 100 distinct valid map IDs');
  }
  const summary = { initialized: 0, matched: 0, unchanged: 0, missing: 0, quarantined: 0,
    reasons: {} as Partial<Record<BackfillReason, number>> };
  for (const candidate of candidates) {
    const outcome = await revisionTransaction(database, async client => {
      const { rows } = await client.query(
        'SELECT id, anon_id, data, current_revision FROM public.maps WHERE id = $1 FOR UPDATE', [candidate.mapId]
      );
      const map = rows[0];
      if (!map) return { action: 'missing' } as const;
      const history = await client.query(
        `SELECT version, data, data IS NOT DISTINCT FROM $2::jsonb AS matches_current
         FROM public.map_versions WHERE map_id = $1 ORDER BY version`, [candidate.mapId, JSON.stringify(map.data)]
      );
      const state = { anonId: map.anon_id, data: map.data, currentRevision: map.current_revision, snapshots: history.rows };
      const plan = maintenance
        ? ('expectedStoredOwnerId' in candidate && isUuid(candidate.expectedStoredOwnerId) && isUuid(map.anon_id)
          && candidate.expectedStoredOwnerId.toLowerCase() === map.anon_id.toLowerCase()
          ? planStoredOwnerRevisionBackfill(state)
          : { action: 'quarantine', reason: 'invalid_owner_metadata' } as const)
        : planRevisionBackfill({ ...state, verifiedOwnerId: 'verifiedOwnerId' in candidate ? candidate.verifiedOwnerId : undefined });
      if (plan.action === 'quarantine' || plan.action === 'unchanged') return plan;
      if (plan.action === 'initialize') {
        const inserted = await client.query(
          `INSERT INTO public.map_versions (map_id, version, data, patch, summary)
           VALUES ($1, 1, $2, NULL, 'Initial generation (reviewed revision backfill)')`,
          [candidate.mapId, JSON.stringify(map.data)]
        );
        if (inserted.rowCount !== 1) throw new Error('Backfill snapshot was not inserted');
      }
      const updated = await client.query('UPDATE public.maps SET current_revision = $1 WHERE id = $2', [plan.revision, candidate.mapId]);
      if (updated.rowCount !== 1) throw new Error('Backfill revision was not updated');
      return plan;
    }).catch(() => {
      // Earlier per-map commits remain valid; retries are classified unchanged.
      throw Object.assign(new Error('Backfill stopped. Review the count-only summary before restarting the reviewed batch.'),
        { summary: structuredClone(summary) });
    });
    if (outcome.action === 'quarantine') {
      summary.quarantined++;
      summary.reasons[outcome.reason] = (summary.reasons[outcome.reason] ?? 0) + 1;
    } else if (outcome.action === 'initialize') summary.initialized++;
    else if (outcome.action === 'match') summary.matched++;
    else if (outcome.action === 'unchanged') summary.unchanged++;
    else summary.missing++;
    if (maintenance && (outcome.action === 'quarantine' || outcome.action === 'missing')) {
      throw Object.assign(new Error('Maintenance backfill stopped. Review count-only progress before retry.'),
        { summary: structuredClone(summary) });
    }
  }
  return summary;
}
