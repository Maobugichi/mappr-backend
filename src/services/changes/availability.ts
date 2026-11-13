import { revisionWritesEnabled } from '../canonicalRevision.js';
import { ChangeError } from './errors.js';
import type { Request } from 'express';
import { localBrowserTestingEnabled, assertLocalBrowserRequest } from '../localBrowserTesting.js';

export function proposalTtlSeconds(): number {
  const raw = process.env.CHANGE_PROPOSAL_TTL_SECONDS ?? '900';
  // Provisional technical bounds only; live expiry policy still needs approval.
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 86400) throw new ChangeError('temporarily_unavailable');
  return Number(raw);
}
export function assertChangesAvailable(req?: Request): void {
  if (process.env.MAPPR_CHANGES_ENABLED !== 'true') throw new ChangeError('feature_disabled');
  if (!revisionWritesEnabled()) throw new ChangeError('revision_not_ready');
  if (localBrowserTestingEnabled()) { assertLocalBrowserRequest(req); return; }
  // Production/hosted release remains blocked even with the local test flag set.
  throw new ChangeError('preview_policy_not_configured', { required: ['daily_admission_rollout', 'artifact_freshness_safeguards'] });
}
