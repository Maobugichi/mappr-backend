import type { PoolClient } from 'pg';
import { checkRateLimits, type RateLimitCheck } from '../rateLimit.js';
import { ChangeError, type ChangeErrorCode } from './errors.js';

export interface PreviewAdmissionIntent {
  proposalId: string; mapId: string; actorId: string; requestDigest: string;
  admittedAt: Date; leaseExpiresAt: Date;
}
export interface PreviewSettlement { proposalId: string; mapId: string; actorId: string }
// No price/credit quantity is selected here. A future approved ledger must make
// reservations and settlement durable/idempotent using this SQL transaction.
export interface PreviewAdmissionLedger {
  assertConfigured(): void;
  reserve(client: PoolClient, intent: PreviewAdmissionIntent): Promise<void>;
  ready(client: PoolClient, intent: PreviewSettlement): Promise<void>;
  failed(client: PoolClient, intent: PreviewSettlement, reason: ChangeErrorCode): Promise<void>;
}
export interface PreviewAdmission extends PreviewAdmissionLedger {
  // Recovery must finish before entering any map/proposal transaction.
  recover?(): Promise<void>;
}
const unconfiguredLedger: PreviewAdmissionLedger = {
  assertConfigured() { throw new ChangeError('preview_policy_not_configured'); },
  async reserve() { throw new ChangeError('preview_policy_not_configured'); },
  async ready() { throw new ChangeError('preview_policy_not_configured'); },
  async failed() { throw new ChangeError('preview_policy_not_configured'); },
};
export function createPreviewAdmission(options: { ledger?: PreviewAdmissionLedger;
  checkQuota?: (actorId: string, client: PoolClient) => Promise<RateLimitCheck> } = {}): PreviewAdmission {
  const ledger = options.ledger ?? unconfiguredLedger;
  return {
    assertConfigured: () => ledger.assertConfigured(),
    async reserve(client, intent) {
      ledger.assertConfigured();
      // Reuse the SAME committed-usage ceilings/day boundary. This precheck is
      // not a replacement for shared serialized reservation admission: the
      // future ledger and ALL budget-sharing legacy writers must participate.
      const quota = await (options.checkQuota ?? checkRateLimits)(intent.actorId, client);
      if (!quota.allowed) throw new ChangeError(quota.reason === 'global_limit' ? 'capacity_exceeded' : 'daily_limit_exceeded');
      await ledger.reserve(client, intent);
    },
    ready: (client, intent) => ledger.ready(client, intent),
    failed: (client, intent, reason) => ledger.failed(client, intent, reason),
  };
}
export const blockedPreviewAdmission = createPreviewAdmission();
