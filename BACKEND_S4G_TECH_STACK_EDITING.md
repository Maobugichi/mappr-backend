# S4G: Tech Stack AI editing

2026-11-12. **Backend implementation and verification PASS. Not deployed or activated.**

Tech Stack Describe a Change now uses the same Preview/Apply engine as Overview
and Architecture. No separate editing lifecycle, dependency or migration was
introduced. The existing release interlock is unchanged; deployment must wait
until all requested Mappr views support AI editing.

## Implemented changes

Inspected the current Git state, canonical schema, Tech Stack generation/read/
render/diff behavior, Architecture handler, shared proposal/provider/admission
services, artifact dependencies, rejection contract and tests before editing.
Recorded a fingerprint baseline of 159 existing project files and preserved all
prior S4/S5 work. No applicable AGENTS.md was found.

| File | Change |
| --- | --- |
| `src/services/changes/techStack.ts` | New scoped operation schemas, prompt, base/candidate validation, complete diff and server summary, saved-proposal revalidation and fixed JSONB storage expression. |
| `src/services/changes/overview.ts` | Registers the `tech-stack` handler beside the existing Overview and Architecture handlers. |
| `src/services/changes/provider.ts` | Tech Stack adapter using the existing shared Gemini/Groq generation, strict validation/correction, fallback, cancellation and sanitized errors. |
| `src/services/changes/engine.ts` | Adds Tech Stack provider/generator dispatch only; proposal lifecycle, Apply, rejection, locks, accounting and persistence remain shared. |
| `tests/changes/tech-stack-changes.test.mjs` | New domain tests and an explicitly isolated read-only PostgreSQL projection test. |
| `tests/changes/overview-preview-apply.test.mjs` | Uses the existing transaction/admission/router fixtures for Tech Stack lifecycle and failure/concurrency tests. |
| `tests/changes/provider-admission.test.mjs` | Tests real shared provider orchestration with mocked transports for Tech Stack. |
| `tests/artifacts/artifact-safety.test.mjs` | Tests selective S5 impacts for an actual Tech Stack replacement/removal. |

Overview and Architecture operation/prompt/policy contracts, current rejection
request/receipt behavior, legacy `/iterate`, authorization middleware, daily
allowance rules, revision helpers, artifact publishers/exports and migrations
were preserved. No frontend files were accessed or modified.

## Canonical model and validation

The actual canonical field is `techStack`, an array of:

```json
{"category":"Database","choice":"PostgreSQL","rationale":"Relational persistence."}
```

There is no technology ID, dependency list, version property or category enum in
`MapprSystemSchema`. Existing diff matching and generated ADR/environment-variable
grounding use the exact `category` string as the natural key. This handler follows
that convention rather than introducing another identity system.

- Categories are exact and case-sensitive, nonblank and at most 128 characters.
  They are not silently normalized, renamed or case-folded. Duplicate/blank or
  oversized existing keys fail before proposal admission or AI work.
- Upserts require all three actual-schema fields, with nonblank string values.
  Unknown operation/item fields, arbitrary paths, full-system replacements,
  duplicate writes to one category and removals of missing categories fail.
- Each proposal has 1–50 operations. An existing category is updated in place;
  surviving order is preserved and new categories append. A category rename is
  an explicit removal plus addition and appears as such in the diff. Removing
  every entry is allowed by the actual array schema.
- Redundant upserts are removed from the normalized proposal. A proposal with
  no actual change returns `422 no_changes`. Rationale-only changes are valid
  and previewed as such.
- The whole base/candidate must pass `MapprSystemSchema`. Apply reconstructs and
  revalidates saved operations, full diff, summary, context, affected sections,
  policy and candidate fingerprint through the existing engine.

The full canonical system is provided as untrusted context to the shared AI
adapter so its rationale can account for product/architecture requirements.
There are no canonical foreign keys from other sections to Tech Stack categories
in this schema, nor a machine-readable software compatibility/dependency model.
Validation therefore does not claim to prove that two technologies are mutually
compatible. A `tech_stack_only` warning explicitly requests review of architecture,
database, features and development plan. Those canonical sections are preserved.

Generated ADR `subjectId` and environment-variable `techStackCategory` references
can become obsolete after a category removal/rename. Their saved content is not
silently edited; existing S5 fingerprints mark dependent outputs stale and
current-only export protection remains authoritative.

## API contract

All requests use the existing signed owner session, credentialed browser request,
trusted Origin checks, positive expected revision and strict request schemas.
Shared-link read access does not authorize edits. No new route is necessary.

### Preview

`POST /maps/:id/changes/preview`

Required header: `Idempotency-Key: <UUID>`.

```json
{
  "instruction": "Replace PostgreSQL with SQLite and explain the reason.",
  "context": {"activeView":"tech-stack","selectedTarget":null},
  "expectedBaseRevision": 7
}
```

Use **`tech-stack`**, including the hyphen, as the view identifier. The canonical
field/collection remains **`techStack`**. `tech_stack` is not an alias. This slice
supports only `selectedTarget:null`; existing feature/entity/architecture-node
targets are not Tech Stack selectors and return `422 unsupported_scope`.
Category-specific requests can name their category in the instruction.
The existing trimmed instruction limit remains 1–2000 characters.

Allowed structured operations:

```json
{
  "op": "upsert_item",
  "collection": "techStack",
  "value": {
    "category": "Database",
    "choice": "SQLite",
    "rationale": "Embedded persistence without a separate database service."
  }
}
```

```json
{"op":"remove_item","collection":"techStack","key":"Database"}
```

An upsert replaces `choice`/`rationale` for an existing category or adds a new
category. No `replace_list`, `set_field` or arbitrary JSON operation is accepted
for this view. Clients do not construct the AI proposal themselves.

The existing `201` response contains `contractVersion:1`, map/proposal IDs,
`status:"ready"`, captured `baseRevision`, context, server timestamps/expiry,
normalized operations, full actual `SystemDiff`, server-derived summary,
`affectedSections:["techStack"]`, warnings and S5 artifact impacts.
For example, the **Tech Stack fragment** of a replacement diff is:

```json
{
  "techStack": {
    "added": [],
    "removed": [],
    "changed": [{
      "before": {
        "category":"Database",
        "choice":"PostgreSQL",
        "rationale":"Relational persistence."
      },
      "after": {
        "category":"Database",
        "choice":"SQLite",
        "rationale":"Embedded persistence without a separate database service."
      },
      "changedFields":["choice","rationale"]
    }]
  }
}
```

Other canonical sections have empty diffs. The summary for this example is
`Updated tech stack: 1 technology updated.` Additions/removals include complete
entry values in their respective arrays. Preview does not modify canonical data
or history. Its `artifactImpactsContext` remains
`{asOfRevision:8,semantics:"proposed_revision_snapshot"}` for base revision 7.

Same-key/body retry returns the original immutable ready response with the replay
header and no new generation. Reusing the key for a different request returns
`409 idempotency_key_reused`. Expiry remains server-provided; the existing admitted
daily policy uses 900 seconds and was not changed.

Provider identity: `tech-stack-operations:shared-ai-v1`; structured response name:
`tech_stack_change`; validation policy:
`{contract:1,operations:3,prompt:1,artifacts:"s5a-provenance-v1",scope:"tech-stack"}`.

### Apply and rejection

`POST /maps/:id/changes/:proposalId/apply`

```json
{"approved":true,"expectedBaseRevision":7}
```

Apply uses the existing owner checks, map-then-proposal locks, database-clock
expiry, revision/fingerprint comparison, policy/context validation and one-use
receipt. It does not accept submitted operations or system data. Only
`maps.data.techStack` is patched by an allowlisted SQL expression with bound
known-field values; existing raw JSONB extensions are merged by exact category.
Unrelated sections and exact numeric extensions are not round-tripped through
JavaScript. Removing a category intentionally removes that entry, while a new
category does not inherit hidden extensions from a different key.

Canonical data/revision, an exact history snapshot and the Apply receipt commit
atomically. The response retains the shared `200` contract: full authoritative
`data`, `previousRevision`, `revision`, `version`, actual diff/summary, affected
sections, warnings and artifact freshness with transaction-snapshot context.
History uses `patch:null` and operations/diff in `change_metadata`. Apply performs
no AI work and consumes no extra daily unit.

`POST /maps/:id/changes/:proposalId/reject`

```json
{"rejected":true,"expectedBaseRevision":7}
```

The unchanged shared rejection contract returns `200` with map/proposal IDs,
`contractVersion:1`, `status:"rejected"`, `baseRevision`, `rejectedAt`. Rejection
is idempotent and changes no canonical revision/history/artifact/usage. Apply
after rejection returns `410 proposal_rejected`. Rejecting an applied/non-ready
proposal returns `409 proposal_not_ready`; Apply/Reject races serialize.

Ready-preview generation consumes the existing daily allowance once. Failed or
invalid generation releases the hold without successful usage; attempt limits
still apply. Replays/Apply/rejection consume no additional unit. Rejected/expired
successful previews are not refunded. Architecture, Tech Stack and Overview use
the same internal migration-016 `overview_preview` admission class; context,
generator and validation policy identify the view. No quota/billing rule changed.

### Errors and retries

The existing `{error,message,requestId,retry,details}` envelope is unchanged.
Important results include `400 invalid_request`, existing authorization errors,
`422 unsupported_scope`/`change_not_valid`/`no_changes`, allowance errors,
`409 revision_conflict`, `410 proposal_expired`/`proposal_rejected` and sanitized
generation/timeout errors.

There is no automatic rebase. Overview, Architecture, Tech Stack and legacy
iteration contend on the same canonical revision. On a lost Apply acknowledgement,
retry the same proposal, which returns its immutable receipt without a duplicate
revision. Replayed data is authoritative for the receipt's revision, not necessarily
the latest revision. Preview replay remains immutable even after Apply/rejection/
expiry and never revives a terminal proposal.

## Artifact freshness and related views

Existing S5 dependency rules apply without artifact rewrites or regeneration:

| Dependency | Effect of a Tech Stack change |
| --- | --- |
| Full system: API contract, README, critique, requirements, traceability | Previously current outputs become stale. |
| Tech Stack + Architecture: ADRs, environment variables, deployment | Previously current outputs become stale, including saved category references. |
| Data model: relational/document schemas | Can remain current when proven inputs are unchanged. |

Missing artifacts remain missing, and unknown legacy provenance is never promoted
to current. Saved stale output remains inspectable through the existing S5 flow;
current-only exports still require valid provenance. Preview impacts are a proposed
snapshot and Apply freshness is a commit-time snapshot, not a permanent claim.

All canonical views read the same saved system. This change does not rewrite
Architecture labels, data-model fields, product summaries or development tasks
to match a technology choice. Their consistency review is explicit in warnings.

## Frontend integration requirements

1. Reuse the existing Describe a Change UI and eligibility/session/Origin flow.
   Send `activeView:"tech-stack"`, `selectedTarget:null`, current accepted map
   revision and a new UUID preview key per distinct request. Retry an uncertain
   preview using the same body/key, not a fresh generation.
2. Render `diff.techStack.added`, `.removed`, and `.changed`. For updates display
   `before`, `after`, and `changedFields`, including rationale-only changes.
   Match entries using the exact canonical category, not choice or array index.
   Show category rename as removal/addition. Render the warning, artifact impacts
   and expiry. Do not install preview data into the canonical cache.
3. Use the unchanged explicit Apply/rejection bodies above. No operations belong
   in those requests. Do not call legacy `/iterate` for technology changes.
   Disable opposing actions while one is pending. Rejection clears proposal UI
   without changing canonical state or implying a refund.
4. Install the complete authoritative Apply `data`/`revision` in the common map
   cache used by every view, especially Tech Stack, Overview, Architecture, All
   and JSON. **Older successful/replayed responses must never overwrite newer
   canonical state.** Enforce revision ordering for map reads and all mutation
   responses, and do not let equal/older receipts regress artifact/UI state.
5. On revision conflict refresh and explicitly create a new preview; do not
   rebase locally. On expiry during review disable Apply and offer a new preview.
   Preserve terminal proposal state so delayed immutable ready responses cannot
   reopen an applied/rejected/expired proposal. Rejection's base revision is not
   a fresh canonical map revision.
6. Refresh/invalidate history and affected artifact caches after Apply. Use
   existing S5 revision/generation/fingerprint metadata to reject obsolete
   responses. Display stale/unknown outputs as inspection-only and retain export
   guards. Do not treat candidate impact metadata as current artifact data.

Frontend confirmation remains necessary for the literal view identifier mapping,
exact category-key rendering, handling all before/after fields, and shared
map/history/artifact cache synchronization. Selected technology targets are not
part of this backend slice. Frontend/browser integration has not been verified
from this separate backend workspace.

## Actual verification

| Check | Result |
| --- | --- |
| Focused Tech Stack + shared Preview/Apply + providers + artifacts | **226 tests: 225 passed, 0 failed, 1 optional PostgreSQL skip.** |
| Authorization + revision + Architecture + daily allowance compatibility suites | **119 tests: 118 passed, 0 failed, 1 optional Architecture PostgreSQL skip.** |
| Tech Stack focused run with isolated PostgreSQL enabled | **25 passed, 0 failed, 0 skipped.** |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS. |
| `npm run build` | PASS. |
| Whitespace/preservation checks | PASS. |

The first sandboxed test launch failed before test execution because `tsx` could
not read Windows user information (`uv_os_get_passwd`, ENOMEM). The same focused
tests passed outside that sandbox; no application fix or test bypass was needed.

Tests cover additions/removals/replacements and exact before/after values,
category identity/renames, extension/order preservation, malformed/out-of-scope
output, ambiguous bases, no-ops, saved-proposal tampering, full lifecycle/HTTP
authorization, cross-view and in-flight-generation conflicts, expiry, atomic
failure rollback, uncertain acknowledgement recovery, concurrent Apply/reject,
idempotency, shared allowance contention and selective artifact invalidation.
Shared provider tests exercise actual correction/fallback/cancellation orchestration
with mocked Gemini/Groq transports; no real AI call was made.

The PostgreSQL test positively verified the existing separate local PG17 cluster
by loopback endpoint, non-application port, database, data directory and system
identifier. It used synthetic JSON literals in a READ ONLY transaction, not
application tables. Actual SQL replacement/addition/removal and empty-stack
projection preserved unrelated JSONB and exact `9007199254740993` extensions.
The transaction rolled back and the owned local cluster was stopped. No migration
or Supabase connection was involved. Full real-database proposal lifecycle
integration, real-provider quality and frontend/browser synchronization remain
unverified; transaction/concurrency lifecycle checks used the existing fixtures.

## Remaining scope and release boundary

Overview, Architecture and Tech Stack are implemented in the shared backend
engine. Database, Design System, Development Plan, API Contract, All and JSON
editing remain subsequent view slices. Unsupported views remain rejected.

No live database, environment flags, payments, migration files, deployment
settings, Git index/commit or remote branch were changed. Existing production
release gates remain in place. **Do not deploy or activate until all requested
views support editing. STOP for review.**
