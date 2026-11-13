# S4F: Architecture Describe a Change

2026-11-12. **Implementation and verification PASS; not deployed or activated.**

Architecture now uses the existing Overview proposal engine for natural-language
Describe a Change → Preview → Apply. Overview remains supported. The release
interlock remains intact. Other views are not implemented in this slice, and
deployment remains blocked until all requested views support editing.

## Implemented source and preserved work

Inspected Git status/diffs and the interrupted work before continuing. Compared
the result with the saved pre-S4F fingerprint baseline of 155 project files.
Preserved existing S4/S5 work, historical reports, migrations, environment settings,
and the Git index. No applicable repository/ancestor AGENTS.md was found.

| File | S4F change |
| --- | --- |
| `src/services/changes/architecture.ts` | Actual-schema operation validation, graph integrity, selected-node scope, candidate construction, complete diff, deterministic summary, saved-proposal validation and fixed JSONB projection. |
| `src/services/changes/overview.ts` | Small allowlisted Overview/Architecture handler registry; original Overview candidate, prompt and validation policy retained. |
| `src/services/changes/provider.ts` | Architecture structured-generation adapter using the existing shared Gemini/Groq infrastructure, retries/fallback, deadline, cancellation and sanitized failures. Overview retains its provider contract. |
| `src/services/changes/engine.ts` | Dispatch by validated context through the same reservation, generation, publication, Apply, locking, revision/history and replay lifecycle; explicit terminal rejection. |
| `src/schema/changeProposal.ts` | Additive strict rejection request schema; existing preview/approval schemas retained. |
| `src/routes/changes.ts` | Shared provider-aware factory and additive owner-protected rejection endpoint. |
| `src/services/changes/errors.ts` | Generalized scoped validation messages and `proposal_rejected` error. |
| `src/services/changes/warnings.ts`, `artifacts.ts` | Pure shared warning metadata and the existing S5 artifact inventory integration. |
| `tests/changes/architecture-changes.test.mjs` | Domain validation and optional explicitly isolated, read-only PostgreSQL projection test. |
| `tests/changes/overview-preview-apply.test.mjs` | Architecture lifecycle, atomic failure/recovery, conflicts, daily admission, rejection and HTTP coverage using the existing fixtures. |
| `tests/changes/provider-admission.test.mjs` | Architecture provider schema, context, correction/fallback, cancellation and redaction coverage. |
| `tests/artifacts/artifact-safety.test.mjs` | Selective dependency invalidation for an actual Architecture candidate. |
| `tests/auth/map-edit-authorization.test.mjs` | Rejection included in existing mutation authorization checks. |

No new dependency or migration is required. `MapprSystemSchema`, legacy
`POST /maps/:id/iterate`, revision helpers, daily-admission implementation,
artifact publishers/export guards and application mounting were not changed by
S4F. Historical S4A/S5A reports describe their earlier milestones; this document
records the current Architecture extension.

## API contract

Use established signed owner-session cookies, credentialed requests and the
configured trusted frontend Origin. Shared-link reading does not grant editing.
All change responses use the existing no-store/error/replay conventions.
The production availability check still blocks these routes; examples describe
the implemented contract for later approved activation.

### Preview

`POST /maps/:id/changes/preview`

Required header: `Idempotency-Key: <UUID>`.

```json
{
  "instruction": "Add a cache between the API and database.",
  "context": {
    "activeView": "architecture",
    "selectedTarget": null
  },
  "expectedBaseRevision": 7
}
```

Instruction is trimmed, 1–2000 characters. Revision is a positive bounded integer.
Unknown request fields are rejected. `selectedTarget` must be explicitly `null`
for a whole-graph change, or:

```json
{"kind":"architecture_node","id":"api"}
```

A selected target must exist in the captured graph. Selection restricts node
edits to that ID and edge additions/removals to its incident edges. Adding a
different node requires `selectedTarget:null`. IDs are canonical node IDs, not
frontend-generated diagram IDs.

The AI adapter returns only a strict `{operations:[...]}` object. Its generator
identifier is `architecture-operations:shared-ai-v1`; validation policy is
`{contract:1,operations:2,prompt:1,artifacts:"s5a-provenance-v1",scope:"architecture"}`.
The server constructs and validates the candidate; AI prose is not trusted as
the preview summary or diff.

The immutable `201` response retains the existing envelope:

| Field | Architecture meaning |
| --- | --- |
| `contractVersion`, `mapId`, `proposalId`, `status` | `1`, map UUID, proposal UUID, `"ready"`. |
| `baseRevision`, `context` | Captured canonical revision and validated request context. |
| `createdAt`, `expiresAt` | Server timestamps; use the returned expiry. The existing daily policy currently requires 900 seconds. |
| `summary` | Deterministic counts of actual nodes added/removed/updated and edges added/removed. |
| `operations` | Validated, normalized operations, including any incident-edge cleanup. |
| `diff` | Full existing `SystemDiff`; `diff.architecture.nodes` has added/removed/changed, and `diff.architecture.edges` has added/removed. Other sections are unchanged. |
| `affectedSections` | `["architecture"]`. |
| `warnings` | Architecture-only scope/related-section review warning and artifact freshness snapshot warning. |
| `artifactImpacts` | Existing S5 per-artifact dependency-impact records for the proposed candidate. |
| `artifactImpactsContext` | `{asOfRevision:8,semantics:"proposed_revision_snapshot"}` for base revision 7. |

Preview saves proposal/admission metadata; it does not change canonical data or
history. Same key and body replay the immutable response without another AI call.
A changed body with the same key returns `409 idempotency_key_reused`.

### Architecture operations

Each proposal contains 1–50 operations. Only these three strict forms are allowed:

```json
{
  "op": "upsert_item",
  "collection": "architecture.nodes",
  "value": {
    "id": "cache",
    "label": "Cache",
    "type": "service",
    "description": "Caches frequently requested API data."
  }
}
```

```json
{"op":"remove_item","collection":"architecture.nodes","key":"cache"}
```

```json
{
  "op": "replace_list",
  "path": "architecture.edges",
  "value": [
    {"from":"web","to":"api"},
    {"from":"api","to":"cache","label":"lookup"},
    {"from":"cache","to":"db","label":null}
  ]
}
```

Node values use the actual schema's required `id`, `label`, `type`, `description`
strings. `type` remains a string, not an invented enum. IDs/endpoints must be
nonblank and at most 128 characters; proposed node strings must be nonblank.
Edges have `from`, `to`, and an optional nullable string `label`; there is no
canonical edge ID. Edge replacements contain the complete final list, at most
500 entries. Unknown model fields, arbitrary paths/root replacements, duplicate
writes to a node, multiple edge replacements, missing removals, duplicate node
IDs, dangling endpoints and duplicate semantic edges are rejected.

Edges are identified by `(from,to,label ?? null)`; omitted and null labels are
equivalent, while an empty string remains distinct. Surviving items preserve
their relative order. Existing unknown extensions and unchanged edge label
representation survive. Node removal cascades incident edges, and the normalized
preview includes the resulting explicit `replace_list` operation. No-op upserts
are omitted; a proposal with no actual difference returns `422 no_changes`.

The entire candidate is validated against `MapprSystemSchema`, with additional
graph integrity and selected-target checks. A malformed touched graph is rejected
before admission/AI rather than silently repaired. Only architecture changes;
other canonical sections are preserved.

### Apply

`POST /maps/:id/changes/:proposalId/apply`

```json
{"approved":true,"expectedBaseRevision":7}
```

The client cannot submit operations or replacement data. The existing engine
locks the map and proposal, checks ownership, expiry, base revision/fingerprint,
saved context/policy, recomputed operations/diff/summary, and projected candidate
fingerprint. There is no automatic rebase.

The fixed handler expression patches only `maps.data.architecture`. A bound
known-field payload is merged into existing JSONB, preserving unrelated fields,
graph extensions and exact numeric values without round-tripping those values
through JavaScript. Canonical data/counter, an exact `INSERT SELECT` history
snapshot and the durable Apply receipt commit atomically. History uses the
existing proposal metadata fields, `patch:null`, and validated operations/diff
in `change_metadata`.

`200` contains `status:"applied"`, `previousRevision:7`, `revision:8`, `version:8`,
`appliedAt`, full authoritative `data`, actual `diff`, summary, affected sections,
warnings, `artifactFreshness`, and
`artifactFreshnessContext:{asOfRevision:8,semantics:"transaction_snapshot"}`.
No AI call or additional daily generation occurs on Apply.

Proposal ID remains the Apply idempotency key. A retry returns the stored receipt
with `Idempotency-Replayed:true`, even if newer revisions now exist. Failed
transaction stages roll back together. For an uncertain response/commit, retry
the same proposal; do not create another proposal to infer the outcome.
Overview, Architecture proposals and legacy iteration share the existing
canonical revision sequence and conflict protection.

### Explicit rejection

Additive shared endpoint: `POST /maps/:id/changes/:proposalId/reject`.

```json
{"rejected":true,"expectedBaseRevision":7}
```

`200` returns `contractVersion:1`, `mapId`, `proposalId`, `status:"rejected"`,
`baseRevision` and `rejectedAt`. Owner/map/proposal checks and map-then-proposal
locks match Apply. A ready proposal becomes terminal using the existing
`failed` state plus `terminal_error.code:"proposal_rejected"`; no schema change
is needed. Repeated rejection returns the same receipt and replay header.

Rejection changes no canonical data, history, artifacts or usage. A successfully
generated preview retains its consumed allowance. Apply after rejection returns
`410 proposal_rejected`. Rejecting an applied/non-ready proposal returns
`409 proposal_not_ready`; Apply/Reject races serialize and the first committed
action wins. The revision in this rejection body refers to the proposal base,
not an authoritative current canonical revision.

An old preview-key replay deliberately still returns the original immutable ready
preview, including after rejection, application or expiry. It never revives the
proposal. Clients must retain terminal UI state and must not interpret such a
response as proof that Apply remains available. A new preview needs a new key.

### Errors and allowance behavior

Existing error envelope remains
`{error,message,requestId,retry,details}`. Important outcomes:

| Status | Codes / handling |
| --- | --- |
| 400 | `invalid_request`; correct body, key, UUID or revision. |
| 401 / 403 / 404 | `session_required` / `origin_not_allowed` / `not_found`; existing ownership/privacy rules. |
| 409 | `revision_conflict` requires refresh/new preview; `proposal_mismatch`, `proposal_obsolete`, `proposal_not_ready`, `idempotency_key_reused`, `preview_in_progress` retain existing semantics. |
| 410 | `proposal_expired`, `proposal_rejected`; explicitly request a new preview/key. |
| 422 | `unsupported_scope`, `change_not_valid`, `no_changes`. |
| 429 / 503 | Existing allowance/attempt/capacity limits or availability/interlock failures. |
| 502 / 504 | `change_generation_failed` / `generation_timeout`; sanitized provider failures. |

Architecture participates in the same durable daily ledger as Overview and other
AI routes. Successful ready publication consumes one unit once; failed generation
releases its hold without a successful usage entry. Replays, Apply and rejection
do not generate or consume an extra unit. Rejected/expired successful previews
are not refunded. Attempt limits remain enforced.

For compatibility with migration 016, the internal accounting operation remains
`overview_preview` for both proposal scopes. This is a shared preview admission
class, not the frontend view identifier; saved context, policy and generator ID
distinguish Architecture. No quota, payment or billing policy was changed.

## Artifacts and connected views

The existing S5 dependency fingerprints determine impacts, not a new invalidation
engine. For an Architecture edit with previously current artifacts:

- Full-system artifacts become stale: API contract, README, critique,
  requirements and traceability.
- Tech-stack/architecture artifacts become stale: ADRs, environment variables
  and deployment.
- Relational/document schemas can remain current when their proven `dataModel`
  inputs are unchanged. Unknown legacy provenance is never promoted to current.

Missing artifacts remain missing. No artifact content or provenance is rewritten
or regenerated by Preview/Apply. Stale inspection and current-only export
protections remain in place. Preview impacts predict a candidate snapshot;
Apply freshness describes its transaction snapshot, not an everlasting claim.

Canonical Architecture/All/JSON readers see the committed graph through the same
map data. The warning explicitly asks users to review related features, tech
stack, database and development plan; this slice does not invent cross-section
edits or promise semantic synchronization of independently authored content.

## Frontend integration requirements

Frontend files were not accessed or modified. Implement against these exact
requirements in the separate frontend environment:

1. Reuse existing edit eligibility, signed session and credentialed mutation
   flow. Send literal `activeView:"architecture"`; use canonical map/node IDs.
   Send `selectedTarget:null` for whole-graph work. Never silently fall back to
   immediate `/iterate` mutation when preview is unavailable.
2. Capture the accepted canonical revision with the request. Generate a fresh
   UUID preview key per distinct user request; use the same key/body on retries.
   Render the actual node and edge diff, including cascading edge removals,
   server summary, warnings, artifact impacts and expiry. Preview must not
   replace canonical state.
3. Require explicit Apply or rejection. Send only the documented approval or
   rejection body. Disable opposing actions while one is pending. Treat the
   response as a durable outcome; handle a race as first commit wins.
4. On Apply success, synchronize the complete returned `data` and `revision`
   across the common map cache and every view, including Overview, Architecture,
   All and JSON. **An older successful or replayed response must never overwrite
   newer accepted canonical state.** Track revisions per map for reads and
   mutations, including concurrent legacy iteration. Equal-revision replay must
   not roll back newer artifact/UI state. Rejection receipts are not canonical
   map snapshots.
5. Reconcile graph nodes/edges from canonical data. Keep diagram layout and
   temporary rendering IDs separate. Do not write `product.summary` for an
   Architecture edit. History readers must tolerate proposal entries with
   `patch:null` and operations/diff in change metadata.
6. Refresh/invalidate map history and affected artifact caches after Apply.
   Order artifact fetches/publication responses using their existing revision,
   generation and fingerprint metadata. Do not install preview impact metadata
   as current artifact state. Reject older responses relative to accepted map
   state and refetch as required. Saved stale/unknown artifacts are inspectable,
   with visible status; exports require current provenance and existing S5
   safeguards.
7. On `409 revision_conflict`, refresh canonical data and explicitly request a
   new preview; do not rebase operations locally. On expiry during review,
   disable Apply and request a new preview/key. On rejection, clear proposal UI
   without changing canonical state or implying a refund. Do not let delayed
   ready-preview replays revive terminal proposal UI.

Frontend confirmation is still needed for the Architecture view identifier
mapping, selected-node canonical IDs, client diagram edge IDs versus canonical
edge tuples, rendering the three operation shapes/full diff, explicit rejection
UX, and the shared map/history/artifact cache revision-ordering implementation.
Existing Overview still edits `product.summary`; no frontend field remapping is
assumed. Browser/CORS/cookie and multi-view cache synchronization require testing
in the frontend environment.

## Verification results

Completed checks against the final implementation:

| Check | Actual result |
| --- | --- |
| Full relevant offline regression run | **403 tests: 400 passed, 0 failed, 3 optional PostgreSQL checks skipped; exit 0.** |
| Focused Architecture run with explicit isolated PostgreSQL enabled | **19 tests passed, 0 failed, 0 skipped; exit 0.** Includes the otherwise optional Architecture SQL check. |
| TypeScript `tsc --noEmit` | PASS. |
| Backend `npm run build` | PASS. |
| Git whitespace check | PASS. |

The full regression run covered auth, schema baseline, revision/cutover/
reconciliation safety, Overview/Architecture proposal lifecycle, artifact safety,
provider admission and durable daily accounting. It used mocked providers and
synthetic fixtures, with real router authorization tests. Coverage includes
cross-scope conflicts, last-allowance contention, failed generation, saved proposal
tampering, rollback at Apply stages, lost acknowledgements, idempotent recovery,
rejection/replay and Apply/Reject races. An initial test-fixture engine reuse error
was corrected before the passing full run.

The focused PostgreSQL test positively pinned a separate local PostgreSQL 17
cluster by loopback endpoint, non-application port, database, data directory and
system identifier. It used only literal synthetic JSON in a READ ONLY transaction;
no application tables or migrations were read/applied. Actual scoped JSONB node
updates, edge changes and removal/cascade preserved unrelated JSONB and exact
`9007199254740993` extensions. The transaction rolled back and the test-owned
cluster was stopped. An interrupted shell pipe/startup orchestration issue was
resolved without application changes or accessing Supabase.

The two older optional database suites were not rerun. A full real-database
Architecture Preview/Apply transaction integration was not performed in this
slice; engine transaction/concurrency behavior was verified with existing
controlled fixtures and the new storage expression separately on PostgreSQL.
Real-provider behavior, frontend/browser synchronization and deployed endpoints
remain unverified. No live AI calls or real allowance consumption occurred.

## Extension path and remaining scope

The shared lifecycle is complete for Overview and Architecture. A future view
adds a strict scoped validator/provider, validation policy and fixed storage
projection to the small handler registry; it reuses admission, proposal storage,
diff, approval, revision locking, history, artifact freshness and replay.

Tech Stack, Database, Design System and Development Plan will require their own
canonical keys/reference rules. API Contract edits must respect generated-artifact
publication/provenance rather than invent a canonical `MapprSystem` field. All
and JSON must compile requests to allowlisted validated operations, not accept
arbitrary root JSON replacement. These views remain unsupported in this slice
and return `422 unsupported_scope`.

No completed migrations were revisited, no Supabase connection or record was
modified, and no environment flag, dependency, deployment or Git commit/push was
made. The production release interlock remains unchanged. Complete the remaining
view slices and frontend integration before any separately approved deployment
or activation. **STOP for review.**
