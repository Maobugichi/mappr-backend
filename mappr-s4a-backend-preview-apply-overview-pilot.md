# Mappr S4A — Universal AI Changes: backend Overview pilot (implementation only)

## Current established state

- S2/S2.1 owner authorization and edit eligibility are implemented.
- S3 revision migration/backfill is complete: 38 coherent maps, 41 history snapshots, zero quarantine.
- Reviewed S2/S3 backend release `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513` is deployed on Render with the literal `MAPPR_REVISION_WRITES_ENABLED=true` setting.
- Read-only live smoke passed: `/health` 200, map revision 1 and matching history. **Live mutation, browser credential integration, and conflicting write behavior have not yet been verified.**
- Frontend and backend live in separate VS Code environments. Only work inside the **backend** repository for this task. The repo/current implementation is the source of truth.

## Goal

Implement the smallest honest, safe slice of **Describe a Change → Preview → Review → Apply** for **Overview product summary** (`product.summary`) against one canonical Mappr map. This is a feature implementation, not another broad audit, and must preserve working architecture-only `/iterate` and existing views/artifacts. **Do not build cross-view editing yet.** This pilot should establish an extensible server contract, not a one-off route that will need rewriting for future views.

First read `BACKEND_CHANGE_CONTRACT.md`, `BACKEND_S3C_REVISION_ACTIVATION_HANDOFF.md` (if present), current S2/S3 implementation, and relevant tests. Do a short Git-diff/instruction check. If a contract conflicts with current code, report the smallest real issue and follow repo truth; do not re-audit prior migration work.

## Required functionality

1. **Preview endpoint**: `POST /maps/:id/changes/preview`, with UUID `Idempotency-Key` and JSON payload containing `instruction`, `context: {activeView: "overview", selectedTarget: null}`, and `expectedBaseRevision` (positive integer). Use established signed-cookie owner checks and the existing browser-origin protection; no anonymous URL-only edits. Require valid inputs and bounded instruction length. Only support this exact context in S4A; return a clear unsupported-scope response for other views.
2. **Actual edit scope**: The proposed AI edit can modify **only `product.summary`** of a validated full `MapprSystem`. Preserve `meta.oneLineSummary` and every other canonical field. The AI may propose candidate summary text, but server-side code must construct the full candidate from the existing canonical base and validate it with the actual schema. Do not accept an arbitrary AI patch or let the client submit a canonical replacement.
3. **Consistent base**: Capture a coherent `data` + `current_revision` base. Refuse not-ready history. Reject stale preview intent with typed `409 revision_conflict`. No lock or DB transaction should be held during AI generation. Before persisting a proposal, recheck current revision/base so obsolete results do not appear actionable.
4. **Immutable proposal**: Persist a durable proposal containing owner/map binding, base revision and fingerprint, the exact validated candidate (or a server-owned minimal patch + enough data to reconstruct it), a server-computed structured diff, instruction/context, created/expiry times, and lifecycle state. Generate a proposal ID server-side. Define expiry from one central setting (proposed 15-minute default, but check the prior contract). A client-provided proposal or diff must never be trusted to authorize apply.
5. **Preview response**: Include `proposalId`, `baseRevision`, `expiresAt`, human-readable summary, diff with only permitted field changes, warning/impact metadata (including explicitly conservative artifact freshness messaging), and any required contract fields. **Do not mutate `maps.data`, `map_versions`, or revision counters during preview.** Do not claim that derived artifacts were regenerated.
6. **Apply endpoint**: `POST /maps/:id/changes/:proposalId/apply` with `{approved:true, expectedBaseRevision}`. Revalidate owner, proposal binding/expiry/state, base revision and candidate. Commit canonical map, exactly one history snapshot, revision increment, and any approved usage accounting atomically under a per-map row lock. Recheck history *after* lock acquisition under READ COMMITTED as in S3. An outdated proposal gets typed `409 revision_conflict`; no silent rebase, regeneration, or partial write.
7. **Idempotency/replay**: Same owner + idempotency key + identical preview request must yield the same saved proposal/result without duplicate AI calls or charges; different payload with same key must conflict. The apply of a successfully committed proposal must return the same authoritative committed result on retry, even if the original HTTP response was lost. Avoid races between two concurrent apply requests. Keep proposal retention/cleanup straightforward and testable.
8. **Owner/security/response**: Preserve S2/S2.1 cookie ownership and origin handling; do not expose proposal data through public map reads. Keep error bodies typed and non-sensitive (`session_required`, `not_found`, `revision_conflict`, `proposal_expired`, `proposal_not_ready`, etc. as agreed by the contract). Successful apply returns authoritative `revision`, full `data`, `summary`, and committed diff/version so the separate frontend can update its canonical state safely.
9. **Existing writer compatibility**: All canonical writers, including current `/iterate`, must remain safe with the S3 revision system and the proposed apply path. Avoid any mixed legacy/off writer logic or bypassing revision checks. No changes to existing architecture iteration prompts/patch behavior except an essential shared concurrency fix.
10. **Artifact freshness**: Review existing artifact cache paths. Do not falsely mark old derived artifacts as fresh after apply. For this implementation-only phase, design and prepare the minimal safe invalidation/freshness treatment needed for Overview edits, with clearly reported unimplemented dependencies if S5 work is necessary. Do not silently rewrite generated artifacts or break existing export/read semantics.

## Scope, billing and rollout boundaries

- **This is backend code + offline tests + an additive schema migration PREPARATION ONLY.** Do **not** execute DDL/DML against Supabase, deploy, switch the active Render build, or turn the feature on live.
- Proposals need durable storage. Prepare a narrowly scoped additive migration and an explicit later rollout order; do not re-run migration 013 or S1 baseline.
- **Preview credit/billing policy has not been approved.** Do not invent a new billable charge, refund policy, or quota bypass. Preserve existing resource protection and describe the smallest decision necessary before live enablement. Guard rollout until this is resolved. If safe AI preview cannot be provided without a policy decision, implement the non-billing foundation and report the blocker honestly.
- Protect the new routes behind a default-OFF feature gate if useful; don't accidentally expose partially complete behavior on the currently deployed release.
- No frontend edits, no UI implementation, no unrelated schema redesign, no new generation modes, no broad refactors. No real AI billing/calls in tests.

## Verification

Add focused mocks/integration-style offline tests for: owner/nonowner/missing session; invalid context/input; no preview canonical writes; correct summary-only diff; schema-invalid AI output; duplicate/idempotency-key collision; concurrent previews; stale base during AI; expiry; owner/map-bound proposal; apply rejection before commit; atomic apply; same-base competing applies with one winner; uncertain response and replay; preservation of all unrelated canonical fields; existing `/iterate` compatibility; no unexpected billable call/usage on failed/unauthorized paths. Run TypeScript, build, and relevant existing S2/S3 tests once after changes. Only claim real PostgreSQL tests if actually executed against a separately authorized isolated target.

## Deliverables and STOP

- Implement code and offline tests; prepare (do not execute) the additive migration.
- Produce `BACKEND_S4A_OVERVIEW_PREVIEW_APPLY.md` with changed files, exact endpoint request/response/error contracts, feature-gate behavior, test results, unresolved billing and artifact freshness decisions, and the **next smallest backend/database/front-end handoff**.
- Stop for review. Do not start S4B/frontend work or deploy.
