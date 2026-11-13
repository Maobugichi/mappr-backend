import type { PreviewAdmission, PreviewSettlement } from './admission.js';
import { DailyAdmission, DailyAdmissionError, dailyAdmission, type DailyAttempt } from '../dailyAdmission.js';
import { ChangeError } from './errors.js';
import { proposalTtlSeconds } from './availability.js';

const attemptFor = (intent: PreviewSettlement): DailyAttempt => ({ id: intent.proposalId, proposalId: intent.proposalId,
  mapId: intent.mapId, actorId: intent.actorId, operation: 'overview_preview' });
async function safe<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof DailyAdmissionError)) throw error;
    const code = error.code === 'daily_limit_exceeded' || error.code === 'capacity_exceeded' || error.code === 'attempt_limit_exceeded'
      ? error.code : error.code === 'attempt_expired' ? 'generation_timeout' : 'temporarily_unavailable';
    throw new ChangeError(code);
  }
}
export function createDailyPreviewAdmission(service: DailyAdmission = dailyAdmission): PreviewAdmission {
  return {
    assertConfigured() {
      try { service.assertConfigured(); }
      catch { throw new ChangeError('preview_policy_not_configured'); }
      // Current approved policy is 15 minutes. Other configured lifetimes need review.
      if (proposalTtlSeconds() !== 900) throw new ChangeError('preview_policy_not_configured');
    },
    recover: () => safe(() => service.recoverExpired()),
    reserve: (client, intent) => safe(async () => { await service.reserveInTransaction(client, {
      id: intent.proposalId, proposalId: intent.proposalId, mapId: intent.mapId, actorId: intent.actorId,
      operation: 'overview_preview', leaseExpiresAt: intent.leaseExpiresAt,
    }); }),
    ready: (client, intent) => safe(() => service.success(client, attemptFor(intent), intent.mapId)),
    failed: (client, intent) => safe(() => service.failureInTransaction(client, attemptFor(intent))),
  };
}
