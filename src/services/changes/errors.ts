import { randomUUID } from 'node:crypto';

const definitions = {
  invalid_request: [400, 'The change request is invalid.', 'none'],
  session_required: [401, 'An established owner session is required.', 'none'],
  origin_not_allowed: [403, 'The request origin is not allowed.', 'none'],
  not_found: [404, 'The requested resource is unavailable.', 'none'],
  revision_conflict: [409, 'The map changed. Refresh and preview again.', 'refresh_map'],
  idempotency_key_reused: [409, 'The preview key belongs to a different request.', 'none'],
  preview_in_progress: [409, 'This preview is still processing.', 'same_request'],
  proposal_mismatch: [409, 'The approval revision differs from the proposal base.', 'none'],
  proposal_obsolete: [409, 'This proposal uses an unsupported validation policy.', 'new_preview'],
  proposal_not_ready: [409, 'This proposal cannot be approved.', 'same_request'],
  proposal_expired: [410, 'Approval expired. Explicitly request a new preview.', 'new_preview'],
  proposal_rejected: [410, 'This proposal was rejected. Request a new preview to make a change.', 'new_preview'],
  request_too_large: [413, 'The change request exceeds the request limit.', 'none'],
  unsupported_scope: [422, 'This view or selected target is not supported for changes.', 'none'],
  no_changes: [422, 'The proposal contains no actual changes.', 'new_preview'],
  change_not_valid: [422, 'The proposed change is invalid.', 'new_preview'],
  change_generation_failed: [502, 'A valid change could not be generated.', 'new_preview'],
  daily_limit_exceeded: [429, 'The existing daily generation allowance is exhausted.', 'none'],
  attempt_limit_exceeded: [429, 'Too many generation attempts today. Please try again later.', 'none'],
  capacity_exceeded: [503, 'The existing daily generation capacity is exhausted.', 'same_request'],
  feature_disabled: [503, 'The change feature is disabled.', 'none'],
  revision_not_ready: [503, 'Revision migration/backfill is not ready.', 'none'],
  preview_policy_not_configured: [503, 'Preview release and artifact safety require review before enablement.', 'none'],
  temporarily_unavailable: [503, 'The change service is temporarily unavailable.', 'same_request'],
  generation_timeout: [504, 'Preview generation exceeded its deadline.', 'new_preview'],
  internal_error: [500, 'The request could not be completed. Retry the same request to determine its outcome.', 'same_request'],
} as const;
export type ChangeErrorCode = keyof typeof definitions;
export class ChangeError extends Error {
  constructor(readonly code: ChangeErrorCode, readonly details: Record<string, unknown> = {}) { super(definitions[code][1]); }
  get status() { return definitions[this.code][0]; }
  body(requestId = randomUUID()) {
    return { error: this.code, message: this.message, requestId, retry: definitions[this.code][2], details: this.details };
  }
}
export function safeChangeError(error: unknown): ChangeError {
  if (error instanceof ChangeError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (['42703', '42P01', '55P03', '57014'].includes(code ?? '')) return new ChangeError('temporarily_unavailable');
  return new ChangeError('internal_error');
}
export function knownChangeCode(value: unknown): value is ChangeErrorCode {
  return typeof value === 'string' && Object.hasOwn(definitions, value);
}
