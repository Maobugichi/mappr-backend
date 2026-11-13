# Mappr universal change system: proposed backend contract

Design for review, 2026-11-05. **No functionality in this document is implemented unless explicitly marked Existing.** This design changes no application files, routes, or migrations. Repository source was re-inspected; frontend files and live database definitions were unavailable. No repository `AGENTS.md` was found.

## 1. Endpoint definitions and existing foundations

### Existing behavior confirmed in source

| Area | Confirmed behavior and source |
| --- | --- |
| Canonical data | `maps.data` contains the complete `MapprSystem`: `meta`, `product`, `users`, `features`, `techStack`, `architecture`, `dataModel`, `designSystem`, `developmentPlan` (`src/schema/mapprSystem.ts`). |
| Architecture change | `POST /maps/:id/iterate` accepts `{instruction}` (1-2000 characters), immediately applies a node/edge patch, and returns `201 {mapId, version, summary, patch, data}`. It reads before AI, then locks the map only for version allocation/writes; concurrent requests can overwrite changes (`src/routes/iterate.ts`). |
| AI and application | `generateStructured` provides provider fallback, JSON/schema validation, and retries (`src/services/aiClient.ts`). `generateIteration` changes only architecture; `applyArchitecturePatch` filters references, deduplicates added nodes, and cascades incident-edge removal. It can accept a no-op, and its grounded patch/AI summary need not describe the entire actual diff (`src/services/architectureIteration.ts`, `src/schema/architecturePatch.ts`). |
| History | First iteration lazily snapshots version 1, then writes version 2; snapshots, current map, and successful usage are committed together. `GET /maps/:id/versions` returns summaries; `GET /maps/:id/diff?from=N&to=M` compares snapshots. No restore or single-snapshot endpoint exists. The diff service covers all canonical sections (`src/routes/iterate.ts`, `src/routes/diff.ts`, `src/services/diff.ts`). |
| Read contract | `GET /maps/:id` returns `{id,inputDescription,data,createdAt,updatedAt}` without a revision (`src/routes/maps.ts`). |
| Artifacts | API contract, relational/document schemas, and README use map-version keys; ADRs, environment variables, and deployment use the tech-stack/architecture hash; reviews/traceability have no source revision. POST regenerates independently, without editing the system (`src/routes/apiContract.ts`, `relationalSchema.ts`, `documentSchema.ts`, `readme.ts`, `adr.ts`, `envVars.ts`, `deployment.ts`, `critique.ts`, `requirements.ts`, `traceability.ts`). |
| Identity and authorization | A signed `mappr_anon` cookie supplies `req.anonId`. Map routes do not enforce ownership. CORS permits the configured frontend with credentials (`src/middleware/anonSession.ts`, `src/index.ts`). |
| Database | Tracked migrations are `002` and `007`-`012`. Definitions for several required tables are absent; `package.json` points its migration command at missing `001_init.sql`. Deployed constraints cannot be inferred as present. |

### Proposed endpoints

Both endpoints use JSON, established owner-session credentials, UUID map/proposal IDs, `Cache-Control: no-store`, and the same error envelope below. They edit canonical data; artifact prose and frontend layout are outside this contract.

**`POST /maps/:id/changes/preview`**

- Required header: `Idempotency-Key: <UUID>`, scoped to actor + map + endpoint.
- Required body: `instruction`, `context`, `expectedBaseRevision`. `context.activeView` is a stable backend identifier; optional `context.selectedTarget` is `null` or `{kind:"feature"|"entity"|"architecture_node",id:string}`.
- Trim instruction; require 1-2000 characters. Require a positive integer revision. Strictly reject unknown request properties and invalid discriminators. Selected targets must resolve unambiguously in the captured base snapshot.
- Pilot accepts only `activeView:"overview"`, no selected target, and a product-summary edit. Future canonical view identifiers: `users`, `features`, `tech_stack`, `architecture`, `data_model`, `design_system`, `development_plan`. Recognized but disabled views/operations return `422 unsupported_scope`; active view is context, never an authorization grant.
- Capture data and revision together; generate, deterministically apply, and validate operations on a copy. Compute the actual diff and dependency impacts. Recheck ownership and revision before saving a ready proposal. Preview persists proposal/quota metadata, **never canonical data or a new map revision**.
- `201` returns an immutable proposal with operations, summary, diff, affected sections, warnings, artifact impact predictions, base revision, and expiry. Lifetime is server-configurable; clients use the returned `expiresAt` (section 5). Repeating the same key/body returns the original `201` response without another generation. No streaming or job API is required initially.

**`POST /maps/:id/changes/:proposalId/apply`**

- Body is exactly `{approved:true,expectedBaseRevision:integer}`. The revision must equal the stored proposal's base. `false`, missing approval, submitted operations, or submitted system data are invalid.
- Proposal ID is the application idempotency key: at most one commit per proposal, regardless of client retries. No separate apply key is needed.
- No AI call. Recheck owner, proposal state/expiry, schema/policy version, and current revision; commit the saved candidate and history atomically.
- `200` returns the full authoritative system **at the newly committed revision**, new revision metadata, actual diff, and authoritative artifact freshness. Replays return the same committed receipt, even after expiry or subsequent map edits, with `Idempotency-Replayed: true`. Data in a replay is authoritative for its `revision`, not necessarily the latest map. All successful responses, replayed or otherwise, must pass the client's revision-ordering rules in section 4 before changing canonical state; refetch the map before another edit.

### Proposed error contract

Envelope: `{error:string,message:string,requestId:string,retry:"same_request"|"new_preview"|"refresh_map"|"none",details:object}`. Details may contain field errors, expected/current revision, proposal ID, or expiry; never provider prompts, secrets, or raw model output.

| HTTP | Error | Meaning / recovery |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed JSON, missing key/approval/revision, invalid UUID, unknown fields; correct request. |
| 401 | `session_required` | Missing/invalid established session; recover session first. |
| 403 | `origin_not_allowed` | Cookie-authenticated mutation fails origin checks. |
| 404 | `not_found` | Map/proposal absent, map mismatch, or not accessible to actor; do not disclose which. |
| 409 | `revision_conflict` | Preview base or unapplied proposal differs from current revision; refresh and create a new preview. |
| 409 | `idempotency_key_reused` | Preview key reused with different normalized body; never run generation. |
| 409 | `preview_in_progress` | Same preview key is processing; `Retry-After: 2`, repeat same request. |
| 409 | `proposal_mismatch` / `proposal_obsolete` | Apply body revision differs from proposal / validation policy no longer supported; correct body or make new preview. |
| 409 | `invalid_base_system` | Stored system shape or ambiguous identities prevent safe editing; owner-visible diagnostic, no mutation. |
| 410 | `proposal_expired` | Unapplied proposal expired; preserve the diff for inspection, disable approval, and explicitly request a new preview. No automatic renewal or generation charge. |
| 413 | `request_too_large` | Retain the existing 100 KB request ceiling. |
| 422 | `unsupported_scope` / `no_changes` / `change_not_valid` | Request outside enabled handler, empty actual diff, or domain-invalid proposal after bounded correction; no ready proposal. |
| 429 | `daily_limit_exceeded` / `attempt_limit_exceeded` | No new generation admitted; include `Retry-After`. |
| 502 | `change_generation_failed` | Providers exhausted valid structured output; intentional retry uses a new preview key. |
| 503 / 504 | `capacity_exceeded` or `temporarily_unavailable` / `generation_timeout` | Before admission, same preview key is safe; after a recorded terminal generation failure, new preview required. A transient apply failure uses the same proposal/body. `retry` states the applicable action. |
| 500 | `internal_error` | Never infer commit outcome from a disconnected/failed HTTP response; repeat apply to obtain its receipt. |

## 2. Request and response examples

Examples assume map revision 7, saved artifacts with verified provenance, a configured lifetime of 900 seconds, and the dependency-aware policy in section 7. That policy is an enhancement beyond the conservative pilot policy described there; actual impacts always reflect the active server policy. IDs and timestamps are illustrative. Empty collections in the system example are schema-valid, not a recommended generated design.

Preview request (`Idempotency-Key: 46d164ca-f223-4b90-b9df-95f4fde6ae87`):

```json
{
  "instruction": "Clarify that this helps independent coworking spaces manage desk and meeting-room bookings.",
  "context": { "activeView": "overview", "selectedTarget": null },
  "expectedBaseRevision": 7
}
```

Preview response (`201`):

```json
{
  "contractVersion": 1,
  "mapId": "f284391c-a606-4ec9-8cef-344e32a7d98b",
  "proposalId": "0b1128fb-46d5-44e3-a5db-4af613e07483",
  "status": "ready",
  "baseRevision": 7,
  "context": { "activeView": "overview", "selectedTarget": null },
  "createdAt": "2026-11-05T10:00:00Z",
  "expiresAt": "2026-11-05T10:15:00Z",
  "summary": "Updated the product summary to describe coworking desk and meeting-room bookings.",
  "operations": [
    { "op": "set_field", "path": "product.summary", "value": "A booking tool for independent coworking spaces to manage desks and meeting rooms." }
  ],
  "affectedSections": ["product"],
  "diff": {
    "meta": [],
    "product": {
      "summary": [{ "field": "summary", "before": "A workspace booking app.", "after": "A booking tool for independent coworking spaces to manage desks and meeting rooms." }],
      "concepts": { "added": [], "removed": [] }
    },
    "users": { "added": [], "removed": [], "changed": [] },
    "features": { "added": [], "removed": [], "changed": [] },
    "techStack": { "added": [], "removed": [], "changed": [] },
    "architecture": { "nodes": { "added": [], "removed": [], "changed": [] }, "edges": { "added": [], "removed": [] } },
    "dataModel": { "entities": { "added": [], "removed": [], "changed": [] }, "relations": { "added": [], "removed": [] } },
    "designSystem": {
      "colors": { "added": [], "removed": [], "changed": [] },
      "typography": { "added": [], "removed": [], "changed": [] },
      "spacing": { "added": [], "removed": [], "changed": [] },
      "components": { "added": [], "removed": [], "changed": [] }
    },
    "developmentPlan": { "added": [], "removed": [], "changed": [] },
    "hasChanges": true
  },
  "warnings": [
    { "code": "summary_only", "message": "Review whether the existing features and technical design support this wording.", "sections": ["features", "architecture"] }
  ],
  "artifactImpacts": [
    { "artifactType": "api_contract", "action": "invalidate", "reason": "source_changed" },
    { "artifactType": "critique", "action": "invalidate", "reason": "source_changed" },
    { "artifactType": "requirements", "action": "invalidate", "reason": "source_changed" },
    { "artifactType": "traceability", "action": "invalidate", "reason": "source_changed" },
    { "artifactType": "readme", "action": "invalidate", "reason": "source_changed" },
    { "artifactType": "relational_schema", "action": "retain", "reason": "inputs_unchanged" },
    { "artifactType": "document_schema", "action": "retain", "reason": "inputs_unchanged" },
    { "artifactType": "adrs", "action": "retain", "reason": "inputs_unchanged" },
    { "artifactType": "env_vars", "action": "retain", "reason": "inputs_unchanged" },
    { "artifactType": "deployment", "action": "retain", "reason": "inputs_unchanged" }
  ]
}
```

`diff` uses the complete existing `SystemDiff` shape from `src/services/diff.ts`, computed by the backend rather than authored by AI. `affectedSections` uses canonical top-level names and derives from actual differences. Warnings are advisory `{code,message,sections}`; blocking issues return an error. Artifact actions are `invalidate`, `retain`, or `none` (no stored artifact). Preview impact predictions may change if artifacts regenerate before approval; the canonical proposal never changes.

Apply request:

```json
{ "approved": true, "expectedBaseRevision": 7 }
```

Apply response (`200`):

```json
{
  "contractVersion": 1,
  "mapId": "f284391c-a606-4ec9-8cef-344e32a7d98b",
  "proposalId": "0b1128fb-46d5-44e3-a5db-4af613e07483",
  "status": "applied",
  "previousRevision": 7,
  "revision": 8,
  "appliedAt": "2026-11-05T10:02:00Z",
  "summary": "Updated the product summary to describe coworking desk and meeting-room bookings.",
  "affectedSections": ["product"],
  "data": {
    "meta": { "productName": "Deskspace", "oneLineSummary": "Workspace bookings made simple." },
    "product": { "summary": "A booking tool for independent coworking spaces to manage desks and meeting rooms.", "concepts": ["bookings"] },
    "users": [],
    "features": [],
    "techStack": [],
    "architecture": { "nodes": [], "edges": [] },
    "dataModel": { "entities": [], "relations": [] },
    "designSystem": { "colors": [], "typography": [], "spacing": [], "components": [] },
    "developmentPlan": []
  },
  "artifactFreshness": {
    "api_contract": { "status": "stale", "sourceRevision": 7, "reason": "source_changed" },
    "critique": { "status": "stale", "sourceRevision": 7, "reason": "source_changed" },
    "requirements": { "status": "stale", "sourceRevision": 7, "reason": "source_changed" },
    "traceability": { "status": "stale", "sourceRevision": 7, "reason": "source_changed" },
    "readme": { "status": "stale", "sourceRevision": 7, "reason": "source_changed" },
    "relational_schema": { "status": "fresh", "sourceRevision": 7, "reason": "inputs_unchanged" },
    "document_schema": { "status": "fresh", "sourceRevision": 7, "reason": "inputs_unchanged" },
    "adrs": { "status": "fresh", "sourceRevision": 7, "reason": "inputs_unchanged" },
    "env_vars": { "status": "fresh", "sourceRevision": 7, "reason": "inputs_unchanged" },
    "deployment": { "status": "fresh", "sourceRevision": 7, "reason": "inputs_unchanged" }
  }
}
```

The apply response also includes `diff` with exactly the preview's complete diff; it is omitted from the displayed example only to avoid repeating that object. It is required on the wire. Freshness describes the commit-time state; later artifact regeneration can change it without advancing the system revision.

Conflict response (`409`, no canonical writes):

```json
{
  "error": "revision_conflict",
  "message": "The system changed after this proposal's base revision. Refresh and preview again.",
  "requestId": "be746ee5-247f-4939-9224-129ec0372010",
  "retry": "refresh_map",
  "details": { "expectedBaseRevision": 7, "currentRevision": 8, "proposalId": "0b1128fb-46d5-44e3-a5db-4af613e07483" }
}
```

## 3. Change operation schemas and validation

Operations are a strict discriminated union. They are **server-generated and returned for review**, never accepted in the apply request. A handler registry defines the allowed union and edit scope for each enabled view; unknown operations fail closed. Start with one operation, then enable the following bounded forms as their validators exist.

| Operation | Schema / meaning | Availability |
| --- | --- | --- |
| `set_field` | `{op:"set_field",path:P,value:V}`. Exact allowed scalar paths: `product.summary` (nonblank string, max 4000), `meta.productName` (max 120), `meta.oneLineSummary` (max 240). | Pilot: only `product.summary`; metadata later. |
| `upsert_item` | `{op:"upsert_item",collection:C,value:T(C)}`. Full item of the collection's existing schema; identity inferred from the item. Replace at existing position or append a new identity. | Later. |
| `remove_item` | `{op:"remove_item",collection:C,key:K(C)}`. Remove one existing, unambiguous identity. | Later. |
| `replace_list` | `{op:"replace_list",path:L,value:T(L)[]}`. Exact allowed paths: `product.concepts`, `architecture.edges`, `dataModel.relations`. Full replacement; preserve the relative order of surviving entries in contract v1. | Later. |

Keyed collection registry (not arbitrary property traversal): `users`/`features`/`architecture.nodes`/`dataModel.entities` use `id`; `techStack` uses `category`; `designSystem.colors`/`typography`/`spacing` use `token`; `designSystem.components` uses `name`; `developmentPlan` uses positive integer `phase`. `T` is the corresponding full item in `src/schema/mapprSystem.ts`; key type is string except phase. Renaming an identity requires explicit removal/addition and reference updates. Entity field edits replace that entity item. Arrays without stable keys use `replace_list` rather than positional edits. No root replacement, arbitrary JSON Pointer, prototype keys, SQL, or executable operations are supported.

Validation requirements:

- Maximum 50 operations; deterministic listed order; reject multiple writes to the same item/path, except explicitly supported cross-collection changes. Every operation must be in the enabled handler's scope. Final stored operations describe actual effects; never silently discard invalid model references as successful approval content.
- Validate model output, operation types, and final full `MapprSystem`; reject no-op results. Generate the displayed summary from validated effects or verify AI wording against them. Scope/context/targets and limits are server policy, not model discretion.
- Ordering edits are not supported in contract v1: the existing diff compares collection membership/items and does not describe every reorder. Reject ordering-only requests and changes to surviving entries' relative order; add an ordering-aware diff before exposing that capability. Do not report reordered data as an unchanged diff.
- Enforce unambiguous identities and references, unique edge/relation tuples, feature dependency rules, and development-plan references/order when those domains are enabled. Normalize absent/null optional labels before comparisons. Every deletion's reference cleanup must appear in the preview; do not run hidden apply-time cascades.
- Preserve existing IDs on edits. Selected targets constrain the primary item; necessary edits to related sections must be explicit operations and visible in the diff. Never infer an instruction to regenerate an artifact as permission to rewrite canonical data.
- Legacy maps may already have unrelated semantic defects. Pilot requires a valid full structural shape, reports existing unrelated defects as warnings, and cannot introduce/worsen them. An ambiguous target or invalid touched domain blocks preview. Broader handlers need domain validators before enablement.
- Reuse bounded schema correction/provider fallback, but additionally validate semantic effects. Treat user/model text as untrusted; no tools or code execution. Record model, prompt, operation-schema, and dependency-policy versions server-side.

## 4. Revision, conflict, and snapshot rules

Use **one revision sequence**, reusing `map_versions.version`; no parallel version counter or timestamp-based locking. Add `maps.current_revision`. Proposed `GET /maps/:id` and `/generate` retain their fields and add `revision`; map GET also adds `artifactFreshness` and returns data/revision from the same snapshot. Existing history/diff version numbers mean the same revision.

Every canonical writer, including legacy iteration, must use the same short commit service before universal changes are enabled:

1. Capture `maps.data` and `current_revision` in one read; perform AI outside any open database transaction.
2. For apply, start a transaction and lock the map, then the proposal (consistent lock order everywhere). Reauthorize. Check for an already applied proposal first and return its receipt, before current-revision or expiry checks.
3. For an unapplied proposal, check the stored base against both request and current revision; evaluate expiry using the database clock after lock acquisition. Compare saved candidate hash and supported validation policy. Never rebase or regenerate during apply, even for apparently disjoint edits.
4. Allocate `current_revision + 1`; insert immutable history; update map data/revision/timestamp; compute freshness against the saved candidate and a consistent artifact snapshot; mark proposal applied and save its receipt/reference. Commit together. Failure rolls everything back; no partial canonical/freshness/proposal success.

Two ready proposals from revision 7 may coexist; only one can commit revision 8. The other conflicts. Preview also rejects a changed revision before returning ready. A fresh preview is required for rebase. Artifact-only generation does not advance the system revision.

No provider call runs while holding these locks. Artifact writes use the same parent-map lock while publishing; readers that assemble multiple tables use a short repeatable-read transaction or equivalent single-statement snapshot. An artifact generator captures its inputs and revision together, then verifies its fingerprint against current inputs before publishing as current. A changed unrelated section is acceptable if all declared inputs still match; otherwise return conflict and preserve the previous artifact.

### Required client revision ordering

An HTTP success reports a committed snapshot, not permission to replace newer client state. These rules apply to map reads, new apply responses, apply replays, generation responses, and legacy iteration responses (`version` maps to `revision`):

- Scope canonical caches by map ID and session context. A delayed response for another map/session must not replace the active system. Replace `data` and its revision atomically; never attach a newer revision number to older data.
- Compare the incoming revision with the highest canonical revision already accepted for that map. Retain that revision high-water mark across query invalidation/refetch within the same map/session context. A higher revision may replace canonical data. A lower revision must not change canonical data, the displayed revision, or newer artifact state. An equal revision is the same immutable system snapshot; it must not perform a last-arrival-wins replacement. Unexpected unequal data for the same revision is a protocol error requiring refetch.
- Apply this gate to ordinary successful responses as well as receipts marked `Idempotency-Replayed`. Example: after revision 9 is accepted, a delayed success or replay for revision 8 can confirm that proposal's outcome in the UI but must leave revision 9 intact. Never use request completion order or timestamps as canonical ordering.
- Preview responses never replace canonical data. If a delayed preview's `baseRevision` is behind the accepted revision, mark it obsolete locally and require a new preview. Build `expectedBaseRevision` from the accepted map snapshot; after a conflict, refetch coherent data/revision before retrying. A conflict's `currentRevision` alone is not a new canonical snapshot.
- Apply receipts contain commit-time artifact freshness. Treat it as an invalidation/refetch hint, not as an update to a newer artifact cache. Regeneration can change artifact data at the same system revision: use per-artifact request generations/cancellation to reject superseded reads, and install a tracked result only if its `currentRevision` matches the accepted canonical revision. Otherwise refetch. An artifact's older `sourceRevision` is provenance, never a replacement canonical revision.

These guards are frontend release prerequisites. Backend revision checking protects writes; it does not prevent an out-of-order network response from regressing a client cache.

## 5. Proposal lifecycle, retries, and quota

Persisted lifecycle: `generating -> ready -> applied`, with terminal `failed`, `conflicted`, and `expired` states. Expiry can be evaluated lazily; no scheduler is required. Configure lifetime on the server, for example with `CHANGE_PROPOSAL_TTL_SECONDS`; the suggested initial value is **900 seconds, subject to product approval**, not a fixed protocol guarantee. Validate configuration as a positive duration within approved operational bounds. Each proposal stores an absolute `expiresAt` when it becomes ready; configuration changes affect newly ready proposals, not already issued ones. `createdAt` is ready time in the public response; generation admission time is stored separately. Failed/conflicted requests never create a usable proposal.

Clients must use returned `expiresAt`, not a hardcoded 15-minute timer. A countdown is advisory; the backend clock after lock acquisition decides eligibility. Expose a server clock reference (such as the HTTP `Date` header through CORS) to reduce clock-skew confusion. If approval expires during user review, retain the diff as an expired preview, disable apply, and offer an explicit new preview from the latest revision. Do not silently extend expiry, replay approval, or generate another proposal. A request clicked/sent before expiry can still receive `410 proposal_expired` if the eligibility check happens after expiry; a transaction accepted before expiry may finish afterward. An already committed apply remains replayable after expiry.

Before AI, atomically insert the preview-key reservation, actor/map binding, normalized request digest, captured base revision, and quota reservation. A duplicate key with a different digest returns 409. A duplicate in progress returns 409 plus retry delay; a completed duplicate replays its saved outcome, even when its saved ready response has since expired. Replaying preview does not extend expiry. Identical instructions with a new key are a new generation.

Use a total generation deadline of 120 seconds and a 180-second processing lease. A crashed/expired generation becomes a saved failure on the next read/retry; a late worker cannot publish after losing the lease. Same-key retries never take over and run a second generation. Terminal failures replay their error; intentionally retry generation with a new key. Internal provider retries are part of the same admitted attempt.

Apply's proposal row and unique history association guarantee once-only persistence, including concurrent double-clicks and response loss. An already-applied replay still requires current access and the original `{approved:true,expectedBaseRevision}`; a mismatched body is rejected. Do not delete applied receipts while the map/history exists. Keep failed/expired preview-key tombstones for at least 24 hours; never reuse a key intentionally.

### Preview-generation credits: product policy awaiting approval

**The following is a proposed billing/free-credit policy, not an approved entitlement or existing behavior. Product approval and matching UI wording are required before implementation or release.** The recommended accounting unit is one successfully saved ready preview; preview itself performs paid provider work even when nothing is applied.

| Event | Recommended credit treatment (pending approval) |
| --- | --- |
| Admitted preview generation | Reserve one credit atomically before AI. A reservation temporarily reduces available credits; it is not a finalized charge. |
| Validated ready proposal saved | Finalize exactly one credit, regardless of provider fallback or internal correction/retry count. |
| Invalid request, denied access, stale base, quota rejection before generation | No credit consumed and no lasting reservation. |
| Provider error, timeout, invalid/no-op output, or revision conflict before ready publication | Release the reservation; zero finalized preview credits. Provider cost may still exist and is recorded separately. |
| User declines, closes the UI, abandons, or lets a ready proposal expire | Keep its one finalized preview credit. No automatic refund under this recommendation. |
| A ready proposal later conflicts at apply | No additional charge; its already finalized preview credit remains consumed. |
| Same-key preview retry/replay, including replay of an expired ready response | No new reservation or credit. A replay does not renew approval. |
| Explicit new preview with a new key, including after expiry or failure | A new generation attempt; consumes another credit only if a new ready proposal is saved. Explain this before user confirmation. |
| Apply, apply retry/replay, rejection of an apply, or artifact invalidation | Zero preview-generation credits; no AI work. Artifact regeneration is separate: retain its existing accounting unless product approves a change. |

On a lost preview response, repeat the same key/body first to learn its outcome; do not infer failure and immediately spend through a new key. Failed attempts and successful previews are distinct: retain failed-attempt records and a separate abuse/attempt-rate cap, without treating each internal provider call as another user credit. Expire abandoned *processing reservations*; that is different from refunding an abandoned *ready proposal*.

The shared quota helper must serialize admission briefly, count successful plus active reservations, and settle/release each reservation once. Any AI routes sharing the same daily budget must participate, including legacy routes, before claiming a strict shared limit. Product must choose/approve the charge point, failure refunds, abandonment/expiry treatment, and whether a replacement preview after expiry/conflict should receive any allowance. If that decision differs from this recommendation, revise this table, errors, and UI copy together; the preview/apply idempotency guarantees remain unchanged.

## 6. Authorization and security requirements

- Proposed minimal editing rule: `maps.anon_id === established signed-cookie anonId`, provided the stored creator ownership is verified. This is possession of the original anonymous browser session, not a person/account identity. No accounts/roles/ACL framework is required for the pilot. Missing/invalid session is 401; an established non-owner sees 404 on protected editing/proposal paths. Creating a new anonymous cookie does not grant access to an old map.
- Bind proposals to map **and requesting owner identity**. Check ownership at preview admission/publication, apply, replay, new protected snapshot recovery, and artifact mutations. Existing history/read authorization follows the explicit sharing decision below. Proposal IDs and UUID map IDs are identifiers, not capabilities.
- Apply the same editing guard to legacy `/iterate`, artifact generation, and finding dismissal before launch; otherwise unauthorized modification remains possible. Proposed new proposal/receipt, stale-inspection, and future snapshot-recovery access is owner-only for the pilot. Changes to existing shared map/artifact/history read access require an explicit product decision; this document does not silently privatize those reads or grant new sharing rights.
- Require credentialed HTTPS and a strict configured-origin check for cookie-authenticated mutations; reject untrusted/missing origins in the browser contract. Keep secure/HttpOnly cookie settings and explicitly verify SameSite behavior for the separate frontend origin. CORS alone is insufficient authorization. No alternate service-auth mechanism is introduced here.
- Bound request/output sizes, operation count, generation deadline, and attempt rate; use parameterized SQL. Return structured field errors without echoing sensitive instructions. Render summaries/diffs as text in clients, and restrict logs/retention for prompts and full system snapshots. Do not accept actor, revision allocation, expiry, artifact status, or candidate data from clients/model output.

### Anonymous ownership and existing links

Existing code allows map-ID-based reads and modifications without checking the creator, but that is not evidence of an intended collaborator permission model. The proposed owner check deliberately closes unrestricted mutation. Agree on rollout messaging and frontend edit affordances before enabling it.

| Situation | Proposed editing behavior / unresolved product boundary |
| --- | --- |
| New map or legacy map with a verified creator ID matching the current signed session | Creator can preview/apply and use legacy mutation routes. Being legacy does not itself remove ownership. |
| Existing shared link opened in another browser/session | Link possession alone grants no new edit right under the proposed guard. Existing read-link behavior is preserved pending the explicit sharing decision; do not infer that links should become private or editable by collaborators. |
| Cookie lost, cleared, expired, or not sent from the separate frontend origin | Original ownership is not recovered by opening the map URL. Mutation stays unavailable; product must decide whether/how anonymous recovery or account claiming will work. Check cookie delivery before labeling this as lost ownership. |
| Legacy map with missing, inconsistent, or unverified stored ownership | Do not assign it to the first visitor or overwrite its owner during backfill. Exclude it from mutation until a reviewed migration/recovery policy establishes ownership. Handle reads under the agreed existing-link policy. |
| Shared editing, ownership transfer, account linking, or map duplication | No permission or claim/clone workflow is invented here. Each requires a separate product decision and explicit authorization contract. |

Do not expose raw anonymous identifiers to let the frontend guess ownership. Agree on a server-provided edit-capability signal or equivalent UI handling. Resolving every historical ownership case is not a pilot prerequisite: uncertain maps may remain ineligible for editing while verified-owner maps enter the pilot. The read-access rollout and lost-session support experience remain product decisions.

## 7. Artifact freshness and invalidation rules

Introduce one dependency registry and freshness resolver over existing artifact tables, not a new artifact-generation platform. A fingerprint covers normalized declared inputs plus generator/prompt policy version. Sort object keys; preserve meaningful array order. Keep existing `techArchHash` storage keys unchanged for compatibility; the new fingerprint has a separate purpose.

The minimum pilot may conservatively fingerprint the full canonical system for every artifact, plus generator/policy version. Any canonical edit then makes older output stale; output without verified provenance is also stale. New generation must capture/verify that declared input snapshot before being marked fresh. This costs reuse efficiency but prevents false freshness. The table below is the dependency-aware enhancement; enable each narrower dependency only once its provenance and generator behavior are verified. The active dependency-policy version is shared by preview, apply, reads, and generation and saved with proposals. Examples in section 2 show this enhanced policy, not a promise of minimal-pilot reuse.

| Artifact type | Proposed dependency-aware generation inputs | Existing difference / rollout |
| --- | --- | --- |
| `api_contract`, `critique`, `requirements`, `traceability` | Full canonical system, conservatively | Already receive the full system; add provenance/freshness. |
| `relational_schema`, `document_schema` | `dataModel` | Already use this input; stop treating unrelated map revisions as stale in the new resolver. |
| `adrs`, `env_vars`, `deployment` | `techStack`, `architecture` | Same inputs; add source revision/provenance. |
| `readme` | `meta`, `product.summary`, `features`, `techStack`, `architecture`, `developmentPlan` | **Proposed enhancement:** include `product.summary` in its AI prompt. Current prompt omits it (`src/services/readme.ts`); bump generator version before enabling this dependency-aware policy. It can follow the Overview pilot; until then, do not promise that README regeneration incorporates the new summary. |

Freshness is `fresh` when a saved artifact's verified fingerprint matches current inputs and supported generator version; `stale` when saved content exists but does not match or provenance is unknown; `missing` when none exists. Return `{status,sourceRevision,reason}` for every registered type; `sourceRevision` is null if missing/unverified. Reasons include `source_changed`, `generator_changed`, `provenance_unknown`, `inputs_unchanged`, and `not_generated`. A fresh artifact may have an older source revision. Missing stays missing after a change; stale data is preserved for inspection, never relabeled as regenerated.

Apply atomically advances canonical revision; resulting freshness is derived from that revision and saved artifact provenance, not an independently drifting stale boolean. Recompute artifact impacts at apply because artifact availability may change after preview. No AI regeneration is hidden inside apply. Clients explicitly invoke existing artifact POSTs; failures leave saved content stale/missing and cannot roll back a committed system edit.

### Current reads versus saved-artifact inspection

Introduce `?freshness=tracked` on structured artifact GETs for new clients. Current-mode lookup returns verified fresh content with `200`, existing payload fields, `sourceRevision`, `currentRevision`, `freshness:{status,reason}`, `isCurrent:true`, and `inspectionOnly:false`. If no fresh content exists but saved output does, return `409 artifact_stale` with metadata and the permitted inspection URL, without presenting its payload as current. With no saved output, return `404 not_found`. Stored `version` remains the generation's source revision, not a fabricated current version.

**Saved stale output is retrievable:** on the same structured JSON endpoint, an authorized owner explicitly requests `?freshness=tracked&includeStale=true`. Prefer a matching fresh record; otherwise return the most recently saved record (stable `updated_at`/ID tie-break), including stale content, with `200`. A stale response must include `isCurrent:false`, `inspectionOnly:true`, its known `sourceRevision` (null if unverified), the observed `currentRevision`, and the stale reason. `includeStale` requires tracked mode; it neither changes provenance nor approves/regenerates anything. Reading does not consume generation credits. There is no arbitrary historical-artifact browsing guarantee or new sharing permission.

Example saved critique inspection after a map edit (`200`; findings abbreviated only by using a schema-valid empty list):

```json
{
  "mapId": "f284391c-a606-4ec9-8cef-344e32a7d98b",
  "findings": [],
  "createdAt": "2026-11-05T09:00:00Z",
  "updatedAt": "2026-11-05T09:00:00Z",
  "sourceRevision": 7,
  "currentRevision": 8,
  "freshness": { "status": "stale", "reason": "source_changed" },
  "isCurrent": false,
  "inspectionOnly": true
}
```

Clients must label this saved result as out of date, show its source revision when known, and keep it in an inspection cache distinct from current artifact data. It must not satisfy current completeness/traceability checks or overwrite canonical data. For README/deployment inspection, return saved structured fields only; never splice them into current graph/labels/environment variables to imply a coherent current document. Use `Cache-Control: no-store` on tracked inspection responses, with cache keys distinguishing map, session, read mode, and provenance.

### Export safeguards and compatibility

Exports are **current-only**: SQL, mongosh scripts, Markdown, and environment files must use verified fresh source data and coherent supported render dependencies. Stale or unverified primary output returns `409 artifact_stale`; absent output returns `404`. `includeStale=true` is invalid on export endpoints (`400 invalid_request`), not an override. Do not offer current-looking stale downloads or mix stale optional dependency data into an otherwise fresh export. Optional unavailable/stale supporting artifacts may be omitted with an explicit note; a required stale dependency blocks export. An archival export would need a separately reviewed, clearly historical contract and is outside this pilot.

Legacy structured GETs retain their key-selection behavior during transition; especially reviews, they are not a freshness contract. Universal-change clients must use tracked reads/inspection. Before exposing the pilot, apply the current-only export guard to existing export URLs even when the tracked query is omitted. Successful URLs/formats remain compatible; the additional stale/unverified rejection is an intentional safety restriction requiring frontend handling. This closes the gap without removing access to saved stale JSON for review.

README exports also depend on current canonical rendered sections and the availability of verified fresh API/schema/ADR artifacts. Deployment exports additionally depend on current node labels/connections and verified fresh environment-variable output when included. Read these coherently and render afresh; supporting-artifact changes require rerender/refetch, not another AI charge for unchanged prose. These render dependencies are separate from generation fingerprints. Source matching guarantees provenance, not semantic completeness.

## 8. Database changes and migrations required

These are proposed definitions, **not migration files**. First inspect and reconcile deployed schema; do not invent or overwrite existing table definitions from route assumptions.

1. **Restore reproducible baseline:** define `maps`, `generations`, `map_versions`, `missing_requirement_reviews`, `traceability_reviews`, and `api_contracts`, plus required UUID support, keys, timestamps, JSONB columns, foreign keys/cascade behavior, and indexes. Reconcile with tracked `002`, `007`-`012`; supply an ordered, recorded migration runner instead of the missing single-file command.
2. **Revision invariant:** add positive non-null `maps.current_revision`; ensure `UNIQUE(map_id,version)` in `map_versions` and immutable full snapshots. Backfill unversioned maps as revision 1. For existing history set current revision only after verifying its latest snapshot equals current data; quarantine mismatches for reconciliation instead of silently declaring them equivalent. New generation writes map and version 1 atomically. Preserve original input description.
3. **History metadata:** add nullable proposal ID with a unique constraint, base revision, actual operations/diff, actor identity, change kind (`generation`, `legacy_iteration`, `proposal`, later `restore`), and internal model/prompt/schema provenance. Retain legacy `patch` and `summary`. Version rows reference their map; proposals reference a retained base snapshot.
4. **`map_change_proposals`:** UUID ID, map/actor IDs, preview idempotency key and digest, state, admission/ready/expiry/lease times, base revision, instruction/context, validated operations, candidate JSONB/hash, deterministic diff/summary, warnings, policy versions, quota reservation reference, terminal error, applied revision/time, and durable apply receipt. Enforce unique `(actor_id,map_id,preview_key)`, one history entry per proposal, valid states/timestamps, and map foreign key. Index owner/map/state/expiry lookups. State transitions use locks/conditional updates.
5. **Artifact provenance:** add nullable `source_revision`, `input_fingerprint`, and `generator_version` to each artifact table (or reuse its existing version column with an equality invariant), with the effective dependency-policy version represented in fingerprint metadata. Keep existing version/hash uniqueness. Existing rows lacking evidence remain unverified, not automatically backfilled as fresh. The pilot can use conservative inputs; cross-version matching indexes/reuse and narrower dependency policies can follow. Shared helpers distinguish fresh current data from the most recent saved stale inspection result.
6. **Quota reservations:** extend `generations` with usage kind, unique proposal reference where applicable, reservation state (`reserved`, `succeeded`, `failed`), and lease deadline; legacy rows default to succeeded. Short admission transactions coordinate user/global counts; all AI routes use the same helper. Failed rows remain auditable but do not consume the proposed free quota.

The apply receipt may store immutable response metadata plus a reference to its history snapshot instead of duplicating system JSON. It must reconstruct the original response even after newer changes; retention must preserve that snapshot. No queue, distributed lock service, event bus, or separate revision store is required.

Recovery plan: retain canonical snapshots indefinitely with the map. A later owner-only `GET /maps/:id/versions/:version` can expose `{mapId,version,data,summary,createdAt}`. A later restore action must create a reviewed proposal from that snapshot and apply it as a **new** revision, with the same conflict/freshness rules; never decrement current revision or overwrite history. Restoration is not part of the first two-endpoint pilot. Existing same-key artifact regeneration still overwrites that artifact; canonical recovery does not promise historical artifact-prose recovery.

## 9. Compatibility with existing endpoints

- Keep `/iterate` available with its existing instruction body, architecture-only scope, immediate-apply behavior, successful status/fields, and grounded legacy patch. Internally route its result through the shared owner/revision/commit service. A conflict returns 409 instead of overwriting; no automatic AI retry. Success `version` equals `maps.current_revision`.
- Legacy iteration must capture its base before generation and compare it at commit. It writes the same snapshot sequence and invalidates tracked artifact dependencies. Do not leave the old independent writer active while claiming concurrency safety.
- Legacy immediate apply cannot provide proposal-based retry idempotency without a request identity. Offer optional `Idempotency-Key` for upgraded callers; older callers must refetch after an uncertain response rather than blindly repeat. This limitation does not weaken the new apply endpoint's guarantee.
- Additive map/generation `revision`, baseline version 1, and tracked artifact reads enable the new frontend without renaming existing routes or changing `MapprSystem`. Keep existing history summary/diff structures and legacy artifact default reads until coordinated migration.
- Legacy structured reads and shared-link read access are distinct from editing authorization. Preserve existing-link reads pending the product decision in section 6; owner checks intentionally restrict mutation. Export URLs/formats remain, but the current-only stale guard applies before pilot exposure. New clients explicitly handle `409 artifact_stale` and use saved JSON inspection rather than an export bypass.
- Universal pilot does not reuse the old `IterationResultSchema` as its response: that schema requires `createdAt`, while today's iteration response omits it. New response schemas must be explicit. Ownership enforcement is an intentional access correction, not an optional compatibility bypass.

## 10. Recommended staged implementation plan

Each milestone is independently reviewable. Keep universal editing disabled until the safety gates below pass; completion of a schema task alone does not expose a new writer. This is a dependency order, not one large foundation implementation.

| Milestone | Depends on | Bounded deliverable / release gate |
| --- | --- | --- |
| P0: product/frontend decisions | Contract review | Confirm pilot field/view mapping, owner-only mutation rollout and existing-link read treatment, approved credit policy, configurable expiry default/UX, and revision-ordered cache behavior. No sharing/credit entitlement is inferred by engineering. |
| S1: schema inventory and minimal migration baseline | P0 | Compare deployed definitions with repository omissions. Reconcile required map/history/usage tables and existing artifact tables safely; establish ordered migration records. Do not recreate or silently adopt unknown production schema. Broader schema cleanup can wait. |
| S2: verified-owner mutation guard | S1 | Guard new and legacy mutation paths, validate frontend cookie/origin delivery, and identify pilot-eligible maps. Unknown-owner legacy maps stay edit-ineligible; a universal claim/recovery system is not required. Read-access changes follow P0 rather than a blanket privacy migration. |
| S3: one coherent revision sequence | S2 | Backfill eligible maps safely, add current revision to reads/generation, snapshot new generation at revision 1, and route legacy iteration through revision-checked atomic commits. Reconcile or exclude history/data mismatches. Prove no competing canonical writer can bypass the check. |
| S4: minimal durable preview/apply | S3 and approved credits/expiry | Enable the single product-summary operation behind a release gate; persist immutable candidates, expiry, preview key reservations, apply receipts, and atomic history/map/proposal commits. Add only the shared admission/settlement needed for the approved budget and retry guarantees, including participating legacy callers. No other view handlers. |
| S5: minimum artifact safety | S3; integrated with S4 | Conservatively mark changed/unverified output stale, publish proven source metadata for newly generated output, expose current versus saved-inspection reads, and reject stale exports. Ensure all artifact publishers/readers honor the captured snapshot. Narrow fingerprints and maximum artifact reuse are not prerequisites. |
| P1: Overview integration and pilot release | S4 + S5 + frontend gates | Confirm `product.summary`/`overview`, show before/after, warnings/impacts and expiry, require explicit approval, apply, and synchronize every view using the section 4 revision gate. Handle stale inspection, regeneration, and exports distinctly. Release only for verified-owner maps. |

**Safety-critical prerequisites:** owner checks on every mutation route; coherent revision reads and all canonical writers; durable proposal/idempotency/atomic history; configured expiry; approved credit accounting with safe retries; conservative artifact freshness/export guards; and frontend response ordering. These cannot be deferred while the pilot claims their guarantees.

Pilot verification must cover: preview leaves canonical state unchanged; decline/expiry adds no revision; applied summary survives reload; history/diff shows only that edit; duplicate apply commits once; response-loss replay is safe; revision 8 arriving after revision 9 cannot regress any canonical view; concurrent legacy iteration conflicts safely; non-owner/cross-origin writes fail; expired approvals never auto-renew; failed AI/transactions settle according to approved credit policy; stale JSON is inspectable but not exported as current. Require frontend integration confirmation, not only backend tests.

**Enhancements after a safe pilot, in dependency order:**

1. Refine artifact dependencies and indexes per generator so unchanged inputs can reuse older-revision output; this depends on S5 provenance and resolver coverage. Include the proposed README `product.summary` input and generator-version bump when that propagation is approved. Until enabled, summary edits do not promise synchronized README wording; present the scope warning.
2. Add owner-only historical snapshot inspection and reviewed restore-as-new-revision on top of S3/S4. Canonical snapshot retention already exists at pilot launch; a recovery UI/API can follow.
3. Add Architecture preview/apply, then other canonical view handlers only after their domain validation and frontend identifiers are agreed. Legacy immediate iteration continues working during this migration.
4. Add ownership recovery, account claiming, or collaboration only under separately approved product permissions. Historical maps do not need automatic reassignment to complete the Overview pilot.
5. Retire legacy immediate iteration and untracked structured reads only after consumers migrate. Artifact revision archives, advanced quota reporting, streaming, and live push synchronization remain optional enhancements; no WebSocket/event bus is required for cross-view synchronization in the pilot.

Cross-view synchronization means all canonical views consume the same **accepted, revision-ordered** system snapshot, not independent patches. Invalidate/refetch affected artifact/history/export queries after a commit; inspection data remains separate. Other sessions refresh before editing and conflict safely if stale. No frontend files have been inspected or changed by this design.

## 11. Open questions requiring frontend agreement

- **Pilot field:** does Overview display `product.summary`, `meta.oneLineSummary`, or both? Confirm that approving this pilot edits only `product.summary`, its labels, and where the actual before/after appears. No automatic metadata/feature edit is implied.
- **View/target identifiers:** approve `overview` and the proposed canonical identifiers; confirm exact mappings to frontend tabs and selected-target kinds. Are related-section edits allowed from a selected item? Which derived views should link back to canonical editing?
- **Canonical cache synchronization:** identify the one per-map canonical cache and confirm higher/equal/lower revision handling across GET, apply, replay, and legacy iteration. Agree on session/map isolation, artifact request ordering, history/export invalidation, and preservation of unsaved graph positions. Older receipts can confirm an outcome but cannot replace newer state.
- **Stale inspection and exports:** confirm `includeStale=true` JSON inspection, separate cache/visible stale labels, unknown source-revision display, and current-only download controls. Can all export callers handle the new stale rejection while legacy structured reads migrate?
- **Anonymous ownership and sharing (product decision):** approve the mutation restriction and edit-capability UI. Explicitly decide whether existing map/artifact/history read links remain accessible, whether any shared editing is intended, and how cookie-loss/unknown-owner maps are explained. No claim, transfer, or collaborator permission is defined here. Verify actual frontend origin and cookie delivery.
- **Credits (product approval required):** select the charge point, failed-attempt treatment, abandoned/declined/expired proposal treatment, and replacement-preview allowance after expiry/conflict. The section 5 table is a recommendation; agree on user-visible reservation/charge/refund wording before implementation.
- **Expiry (product/UX decision):** select initial configured TTL and operational bounds. Confirm server-derived countdown behavior, expired-diff inspection, disabled approval, and explicit new-preview consent; never hardcode the example's 15 minutes or silently incur a new credit.
- **Semantic propagation:** approve whether/when to add the README summary input and other dependencies beyond the conservative pilot. Which content should regenerate from a summary edit rather than just display a scope warning?
- **Compatibility:** confirm additive `revision` fields, complete `SystemDiff` consumption, advisory warnings, new 409 legacy iteration conflicts, immutable apply receipt handling, and coordinated migration to tracked artifact reads.

## Frontend Compatibility Review Checklist

- [ ] Confirm Overview edits `product.summary` and agree on active-view/selected-target identifiers.
- [ ] Use one map/session-scoped canonical cache; reject older revisions and never let replays regress newer state.
- [ ] Keep preview data and saved stale-artifact inspection separate from current data; label provenance and freshness.
- [ ] Handle current-only exports, tracked reads, explicit regeneration, and artifact/history/export cache invalidation.
- [ ] Confirm anonymous owner detection, existing shared-link read behavior, and messaging for lost/unverified ownership.
- [ ] Obtain product approval for preview credits, failures, abandonment/expiry, and new-preview retries; match UI copy.
- [ ] Read server-configured `expiresAt`; disable expired approval and require explicit new preview/approval.
- [ ] Verify legacy Architecture behavior, conflict handling, out-of-order responses, and cross-view synchronization end to end before pilot release.
