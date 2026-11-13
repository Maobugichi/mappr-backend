# Mappr S4A Overview preview/apply implementation

Date: 2026-11-10. **Offline foundation PASS; live enablement BLOCKED.**
The Overview proposal/apply lifecycle, additive migration and offline tests are
implemented. Nothing was deployed or activated, and no database was contacted.
S3C's successful deployment/smoke result is the supplied handoff, not a new live
inspection in this task. STOP for review.

## Scope and release boundary

Read the S4A brief, change contract, S3C handoff, existing authorization/revision
services, artifact paths and relevant tests. Inspected Git status/diffs first;
no applicable AGENTS.md was found. The starting tracked tree and index were
clean at `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513`; existing untracked documents
were retained.

The brief explicitly permits a non-billing foundation while credits are
unapproved. This implementation uses that boundary: **no production AI provider,
credit charge, refund, reservation or entitlement policy has been wired.** A
generation adapter is injected into the engine for synthetic offline tests. The
pure Overview prompt/output contract is prepared for later provider integration.
It is not an enabled AI preview service and does not claim a shared quota limit.

Production route admission is:

1. Existing S2 signed-session ownership and Origin/Fetch-Metadata checks.
2. Exact `MAPPR_CHANGES_ENABLED === 'true'`; otherwise 503 `feature_disabled`.
3. Exact existing revision flag; otherwise 503 `revision_not_ready`.
4. An unconditional release interlock returns 503
   `preview_policy_not_configured`, identifying approved credits and artifact
   safeguards as prerequisites. **Setting environment flags cannot bypass it.**

Both new endpoints use this interlock, before the engine or any generation.
The production generator is additionally unconfigured and refuses generation.
Offline tests explicitly inject a synthetic engine/router and readiness callback;
HTTP clients cannot select these dependencies. Existing routes are not subject
to the new feature gate. No local/live environment file or flag was changed.

## Changed files

| File | Implementation |
| --- | --- |
| `src/schema/changeProposal.ts` | Strict preview/approval, summary output and single-operation schemas. |
| `src/services/changes/overview.ts` | One enabled handler, pure prompt, summary-only candidate, full actual SystemDiff, saved-operation validation and SHA-256 fingerprints. |
| `src/services/changes/engine.ts` | Durable key reservation, generation deadline/lease, immutable ready response, guarded publication, atomic apply and durable replay receipt. |
| `src/services/changes/artifacts.ts` | Ten-type inventory and conservative stale/missing metadata; no artifact rewrites or fresh claims. |
| `src/services/changes/availability.ts` | Default-off flag, revision requirement, release interlock and central configurable TTL. |
| `src/services/changes/errors.ts` | Typed, sanitized error envelope and recovery instructions. |
| `src/routes/changes.ts` | Preview/apply handlers, scoped response/parser errors, no-store and replay/retry headers. |
| `src/app.ts` | Mounts new routes behind the existing owner guard; adds a test injection seam and exposes Date/replay/retry headers through CORS. |
| `src/services/canonicalRevision.ts` | Adds an optional query client to the existing coherent reader, allowing reuse inside the locked transaction. Default behavior is preserved. |
| `src/db/migrations/014_change_proposals.sql` | Prepared additive proposal/history metadata schema; **not executed**. |
| `tests/changes/overview-preview-apply.test.mjs` | New mocked engine/HTTP/concurrency/transaction tests. |
| `tests/auth/map-edit-authorization.test.mjs` | Extends the guarded-route inventory with the two new paths; existing legacy assertions remain. |

No Architecture prompt, patch schema, generation accounting, cookie settings,
artifact route, migration 013, operator executor or existing report was edited.
No frontend files were accessed. Application inputs remain in the backend repo.

## Endpoint contracts

The following success paths describe the implemented engine and tested routes;
production admission currently stops at the release interlock above.

Both endpoints require established signed-cookie owner credentials and the
existing configured browser Origin policy. S2's originless CLI compatibility
allowance is preserved; this is not a new mandatory-Origin/CSRF-token policy.
Map/proposal IDs are UUIDs. New responses set `Cache-Control: no-store` and
`Vary: Cookie`. CORS exposes `Date`, `Idempotency-Replayed` and `Retry-After`.
No proposal or receipt is added to public/shared map reads.

### Preview

`POST /maps/:id/changes/preview`

Required header: `Idempotency-Key: <UUID>`.

```json
{
  "instruction": "Clarify the product summary for independent coworking spaces.",
  "context": { "activeView": "overview", "selectedTarget": null },
  "expectedBaseRevision": 7
}
```

Input objects are strict. Instruction is trimmed and limited to 1–2000
characters; revision is an integer from 1 through 2147483647. This pilot
requires explicit `selectedTarget:null`. Other views or selected targets return
422 `unsupported_scope`; malformed/unknown properties return 400. Map UUID
failures follow the existing owner guard's indistinguishable 404 behavior.

The adapter can return only `{summary:string}`: nonblank after trimming, maximum
4000 characters, no extra properties. The server constructs and validates a
complete candidate from the captured base. The single reviewed operation is:

```json
{"op":"set_field","path":"product.summary","value":"The proposed replacement summary."}
```

The 201 response contains:

```text
contractVersion: 1
mapId, proposalId: UUID
status: "ready"
baseRevision: 7
context: {activeView:"overview",selectedTarget:null}
createdAt, expiresAt: ISO UTC timestamps
summary: "Updated the product summary."
operations: [the validated set_field operation]
diff: complete existing SystemDiff, with only product.summary changed
affectedSections: ["product"]
warnings: [{code,message,sections}, ...]
artifactImpacts: [{artifactType,action,reason}, ...]
```

The summary is server-authored from the validated effect. No-op/invalid outputs
are refused. `meta.oneLineSummary`, other known fields, array order and unknown
extension fields are preserved. Preview changes only proposal metadata; it
never changes canonical data, history, revision counters or usage.

### Apply

`POST /maps/:id/changes/:proposalId/apply`

```json
{"approved":true,"expectedBaseRevision":7}
```

Only these properties are accepted. Client operations, diffs, replacement data,
false/missing approval and invalid revisions are rejected.

The 200 response contains:

```text
contractVersion: 1
mapId, proposalId
status: "applied"
previousRevision: 7
revision: 8
version: 8
appliedAt: ISO UTC timestamp
summary: server-computed summary
data: complete authoritative committed MapprSystem for revision 8
diff: exactly the stored/revalidated preview SystemDiff
affectedSections: ["product"]
warnings: advisory scope/freshness warnings
artifactFreshness: ten-type stale/missing metadata
```

No AI runs during apply. With no approved billing policy, this foundation writes
no `generations` rows; this is not a live free-use entitlement. Production apply
is also blocked pending rollout review.

### Errors

Envelope:

```json
{
  "error":"revision_conflict",
  "message":"The map changed. Refresh and preview again.",
  "requestId":"<server UUID>",
  "retry":"refresh_map",
  "details":{"expectedBaseRevision":7,"currentRevision":8}
}
```

| HTTP | Codes | Behavior |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid JSON/key/proposal UUID/schema/approval; no generation. |
| 401 / 403 / 404 | `session_required`, `origin_not_allowed`, `not_found` | Existing owner/origin protection; proposal/map/actor mismatches are 404. |
| 409 | `revision_conflict` | Refresh canonical data; create a new preview explicitly. |
| 409 | `idempotency_key_reused` | Different normalized payload under the same owner/map/key; no generation. |
| 409 | `preview_in_progress` | Same-key work exists; `Retry-After: 2`, retry the same request. |
| 409 | `proposal_mismatch`, `proposal_obsolete`, `proposal_not_ready` | Incorrect approval base, unsupported/tampered policy/candidate/diff, or unusable proposal. |
| 410 | `proposal_expired` | Approval disabled; saved preview remains inspectable through same-key replay. Explicit new preview required. |
| 413 | `request_too_large` | Existing 100 KB request limit; scoped JSON error. |
| 422 | `unsupported_scope`, `no_changes`, `change_not_valid` | No usable proposal/canonical writes. |
| 502 / 504 | `change_generation_failed`, `generation_timeout` | Saved terminal generation outcome; same-key retries never run another generation. |
| 503 | `feature_disabled`, `revision_not_ready`, `preview_policy_not_configured`, `temporarily_unavailable` | Rollout/readiness/configuration/schema/lock/query refusal; no legacy fallback. |
| 500 | `internal_error` | Sanitized unexpected/uncertain database outcome; retry the same identity to discover the outcome. |

Saved terminal failures replay their code/details, with a new HTTP request ID.
Provider errors, prompts, instructions, owner IDs and raw SQL are not logged or
included in error envelopes. Quota/reservation errors are not implemented as a
fictional billing policy; they belong to the approved admission integration.

## Concurrency, lifecycle and recovery guarantees

- One revision sequence: `maps.current_revision` and `map_versions.version`.
  The new writer explicitly selects READ COMMITTED and uses the S3 transaction
  helper's 3-second lock / 10-second statement limits.
- Every new transaction locks the parent map first, then reads/locks its
  proposal. Coherent history is read in a fresh statement after map-lock
  acquisition. The existing Architecture writer uses the same map lock and
  base check. Two proposals or proposal/legacy iteration from one base have
  one winner; no automatic rebase or regeneration occurs.
- Preview admission stores a unique owner/map/key, normalized request digest,
  full request, base revision, fingerprint, policy/generator metadata and a
  180-second processing lease. All database resources are released before the
  injected generation adapter. Its deadline is 120 seconds.
- Publication rechecks owner, revision, exact PostgreSQL JSONB source text and
  deadline/lease. The ready UPDATE additionally checks the database clock,
  preventing publication after earlier eligibility checks have gone stale.
  Same-key concurrent requests return in-progress, never take over generation.
- The full candidate is not stored redundantly: one immutable minimal operation,
  a retained base-snapshot FK, exact base/candidate fingerprints and the saved
  preview/diff reconstruct and verify it. Fingerprints use server-returned JSONB
  text, not JavaScript JSON equality alone.
- Apply validates the stored policy, binding, base, operation and actual diff.
  It updates only `product.summary` using `jsonb_set`, copies the exact resulting
  JSONB into one full snapshot with `INSERT SELECT`, increments revision, and
  stores proposal state/receipt in the same transaction. Owners/input/created
  timestamps/other canonical fields/artifacts are not rewritten; map updated
  time advances for the intended edit. History's legacy `patch` stays NULL for
  this new change kind; actual operations/diff are in `change_metadata`.
- Already-applied replay is checked after current owner/binding/approval-base
  validation, before current-revision, expiry or current-history checks. It
  returns the immutable original receipt with `Idempotency-Replayed:true`,
  including after later revisions or expiry. Preview ready replays also carry
  that header and do not extend expiry.
- Commit acknowledgement loss is not treated as a rollback. Retry the same
  proposal/key; do not blindly regenerate. An uncertain preview admission can
  remain generating until its lease lazily fails, without running AI twice.
- Failed/conflicted outcomes are durable. Ready expiry is lazy at approval;
  expired previews and key tombstones are retained. No cleanup scheduler or
  purge was added: applied receipts/history and other proposal rows remain for
  the map's lifetime, exceeding the proposed 24-hour tombstone minimum.

The centralized `CHANGE_PROPOSAL_TTL_SECONDS` default is provisionally 900;
technical bounds are 1–86400 integer seconds, **not an approved product policy**.
It is captured for a newly admitted preview and sets absolute expiry at ready
publication. Existing ready replays retain their original timestamps even if
configuration changes. Approval eligibility uses the database clock after both
locks: a click before expiry can still be rejected after waiting. Acceptance
before expiry may finish afterward. No automatic renewal or provider call occurs.

## Artifact safety: prepared metadata, not S5 completion

Reviewed existing cache paths: API/relational/document/README artifacts use
map-version keys; ADR/environment/deployment use the tech/architecture hash;
critique/requirements/traceability are unversioned. README's current prompt
omits `product.summary`. These paths are unchanged.

The new resolver inventories all ten tables in one SQL statement. Any saved
output is conservatively `stale`, `sourceRevision:null`,
`reason:"provenance_unknown"`; absent output is `missing/not_generated`.
Preview predicts `invalidate` or `none`; apply re-inventories and returns
stale/missing metadata. Neither path reports `fresh`, deletes/relabels output,
regenerates it, or promises README wording propagation.

**Not implemented:** provenance capture, guarded artifact publication, tracked
current/stale-inspection GETs, or current-only export guards. Existing artifact
writers do not share the new publication discipline, so this inventory is the
observed statement snapshot, not a guarantee of artifact state at COMMIT under
concurrent artifact generation. Legacy reads/exports remain unchanged. These
are concrete S5 release dependencies; warnings alone do not make live apply
safe. The production interlock remains closed until they are addressed.

## Prepared migration and later rollout requirements

Migration 014 creates only `map_change_proposals`, its constraints/index, and
nullable `map_versions.proposal_id` / `change_metadata` with a unique proposal
association and same-map FK. It binds base/applied revisions to retained history.
It performs no DML, billing schema changes, data backfill, owner assignment or
artifact rewrite. There is no automatic migration execution.

Real PostgreSQL 17 execution, permissions, FK/cascade behavior and lock timing
remain unverified for this migration. The S3B operator intentionally recognizes
the earlier fixed schema and would reject the added table/columns; extend its
reviewed read-only schema/status coverage before using it after migration 014.
Do not replay 013, S1 baseline, backfill, or the broken generic migrate command.

Future order, requiring separate review/authorization:

1. Review this foundation, exact operation/TTL contract and credit policy.
2. Verify migration 014 and real transaction/concurrency behavior in a positively
   isolated PostgreSQL 17 database; prepare target/schema/recovery evidence and
   a narrowly scoped approved schema rollout. No live DDL is authorized here.
3. Implement approved, serialized resource admission/settlement with safe retry
   treatment and all callers sharing its budget. Then wire the bounded provider
   adapter to the prepared prompt/output contract, recording actual provenance.
4. Complete S5 provenance/current-versus-inspection reads/export safeguards and
   artifact publication consistency; retain existing saved output.
5. Obtain separate source-release/deployment/activation approval, complete the
   frontend checks below, and replace the interlock only in that reviewed work.

## Actual verification

Ran the focused suite during development: **54 passed, 0 failed**. Added two
publication/concurrency checks and HTTP commit-failure coverage before the final
run. Final TypeScript no-emit check and backend build both exited 0.

Final commands:

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs
```

The three dedicated disposable-schema settings were cleared only in the test
process. Result: **258 tests; 257 passed, 0 failed, 1 skipped**. S4A contributes
56 passing tests; the existing suites contribute 201. The skip is the explicitly
disabled optional PostgreSQL integration test. Node's experimental module-mock
warnings remain. No real PostgreSQL or provider construction is permitted by
these test workers; HTTP fixtures bind temporary loopback ports and close them.

Coverage includes owner/non-owner/missing-session/origin denial; strict
inputs/context; parser limits; summary-only actual differences and unrelated
field preservation; invalid/no-op/provider output; duplicate/colliding keys;
overlapping same/different-key previews; stale base during generation; lease
and publication-clock expiry; owner/proposal binding; tampered policy/hash/diff;
expiry after a lock wait; atomic commit rollback at four failure stages; concurrent
apply/replay; legacy iteration sharing the commit lock; commit-acknowledgement
loss; authoritative old-receipt replay after a newer revision; and conservative
artifact metadata with unchanged saved records/usage.

These are mocked transaction/HTTP results, not evidence of real PostgreSQL DDL,
lock/wait/commit behavior, real provider cancellation/retries, browser credential
delivery, deployed configuration, or complete artifact safety. No production
mutation or live smoke was run for S4A.

Preservation checks found only the three intended existing files changed. All
earlier reports/task briefs, operator tooling and other existing project files
remain unchanged. The local `.env` hash, Git index and release HEAD are unchanged;
the configured-secret scan found no matches in new/changed files. Ignored build
output was refreshed. No commit/push, SQL, deployment, backend startup, feature
activation or S4B work occurred.

## Frontend review and next smallest handoff

- Confirm Overview displays/edits `product.summary`, not `meta.oneLineSummary`;
  agree on the exact `overview` / explicit-null target body and actual diff UI.
- Keep previews separate from canonical cache. Apply/replay responses may be
  authoritative for an older revision: install data/revision atomically only
  under the existing per-map/session revision high-water rule. Refresh affected
  history/artifact queries; never let a replay regress a newer canonical view.
- Confirm credentialed browser cookie/Origin delivery, SameSite deployment
  compatibility, 409/410/503 handling and explicit approval. No frontend files
  or real browser flow were verified here.
- Use server Date/absolute expiry; retain an expired preview for inspection,
  disable approval, and require explicit consent for a new preview/key.
- Obtain product approval for credits, failures, abandoned/expired proposals,
  intentional replacement attempts and TTL before provider integration/release.
- Treat artifact warnings as a release blocker, not permission to present or
  export saved output as current. Complete the S5 read/export agreement first.

**Next smallest step:** review the non-billing engine/migration and settle credit
and expiry decisions; then authorize isolated PostgreSQL verification. Live
migration, provider integration, S5 completion and activation remain separate.
STOP for review.
