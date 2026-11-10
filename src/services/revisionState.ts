import { isUuid } from '../middleware/anonSession.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';

export const MAX_REVISION = 2147483647;
export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_REVISION;
}

export type BackfillReason = 'unknown_owner' | 'invalid_owner_metadata' | 'invalid_system' | 'invalid_history' | 'snapshot_mismatch' | 'invalid_current_revision';
export type BackfillPlan = { action: 'initialize' | 'match' | 'unchanged'; revision: number }
  | { action: 'quarantine'; reason: BackfillReason };
export interface BackfillState {
  anonId: unknown;
  verifiedOwnerId: unknown;
  data: unknown;
  currentRevision: unknown;
  snapshots: Array<{ version: number; data: unknown; matches_current: boolean }>;
}

// Pure planning only: PostgreSQL supplies matches_current using JSONB equality.
// Application startup never invokes a planner or backfill procedure.
export function planRevisionBackfill(state: BackfillState): BackfillPlan {
  if (!isUuid(state.anonId) || !isUuid(state.verifiedOwnerId)
    || state.anonId.toLowerCase() !== state.verifiedOwnerId.toLowerCase()) {
    return { action: 'quarantine', reason: 'unknown_owner' };
  }
  return planConsistentBackfill(state);
}

// Privileged bookkeeping only: stored owner metadata is NOT browser ownership
// proof. No route uses this planner and it never grants or repairs edit access.
export function planStoredOwnerRevisionBackfill(state: Omit<BackfillState, 'verifiedOwnerId'>): BackfillPlan {
  if (!isUuid(state.anonId)) return { action: 'quarantine', reason: 'invalid_owner_metadata' };
  return planConsistentBackfill(state);
}

function planConsistentBackfill(state: Omit<BackfillState, 'verifiedOwnerId'>): BackfillPlan {
  if (!MapprSystemSchema.safeParse(state.data).success) return { action: 'quarantine', reason: 'invalid_system' };
  const snapshots = [...state.snapshots].sort((a, b) => a.version - b.version);
  if (snapshots.some((item, index) => item.version !== index + 1 || !isRevision(item.version)
    || !MapprSystemSchema.safeParse(item.data).success)) {
    return { action: 'quarantine', reason: 'invalid_history' };
  }
  if (snapshots.length === 0) {
    return state.currentRevision === null
      ? { action: 'initialize', revision: 1 }
      : { action: 'quarantine', reason: 'invalid_current_revision' };
  }
  const latest = snapshots[snapshots.length - 1]!;
  if (latest.matches_current !== true) return { action: 'quarantine', reason: 'snapshot_mismatch' };
  if (state.currentRevision === null) return { action: 'match', revision: latest.version };
  return state.currentRevision === latest.version
    ? { action: 'unchanged', revision: latest.version }
    : { action: 'quarantine', reason: 'invalid_current_revision' };
}
