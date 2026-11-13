# S4H: Database AI editing

2026-11-13. **Backend implementation and verification PASS. Not deployed or activated.**

Database Describe a Change now uses the existing Overview/Architecture/Tech Stack
Preview/Apply engine. It edits canonical `MapprSystem.dataModel`, not generated
SQL/document artifacts or a physical database. No migration or dependency was
added. The release interlock remains unchanged; deployment must wait until all
requested views support editing.

## Source inspection and changes

Inspected Git status/diffs, the current S4G handlers/provider/engine, canonical
schema, map reads, full-system diff, relational/document generation and grounding,
artifact provenance dependencies and existing tests. No applicable AGENTS.md was
found. Recorded a fingerprint baseline of 162 existing project files and retained
all earlier work. Frontend files are in a separate environment and were not read
or modified; current frontend display/mode behavior is not assumed.

Confirmed source behavior:

- `src/schema/mapprSystem.ts` defines `dataModel.entities` and `.relations`.
  `GET /maps/:id` supplies this canonical section with the coherent map revision
  through `src/routes/maps.ts` and the existing revision reader.
- `src/services/diff.ts` matches entities by ID and compares `name`/`fields`.
  Fields are shown as complete before/after arrays, not a separate field-operation
  API. Relationships have no ID and appear as added/removed values.
- `src/services/relationalSchema.ts` and `documentSchema.ts` generate richer
  representations from `dataModel`, ground entity references, and synthesize
  many-to-many structures. Their table/collection/column properties do not belong
  to the canonical schema.
- Existing artifact routes expose saved/generated relational/document schemas
  and guarded SQL/script exports. They remain independent generation/publication
  flows; a canonical edit must not overwrite their saved outputs.

| File | S4H implementation |
| --- | --- |
| `src/services/changes/database.ts` | Strict canonical operations, prompt, entity/field/relationship validation, selected-entity scope, cascade normalization, actual diff/summary, saved-proposal revalidation and fixed JSONB projection. |
| `src/services/changes/overview.ts` | Registers the Database handler in the existing small allowlist. |
| `src/services/changes/provider.ts` | Database structured adapter using shared Gemini/Groq validation/correction, fallback, cancellation, deadlines and redacted failures. |
| `src/services/changes/engine.ts` | Adds provider/generator dispatch for Database; existing lifecycle, persistence, locks, rejection and accounting are reused. |
| `tests/changes/database-changes.test.mjs` | Domain/selected-target validation and an optional isolated read-only PostgreSQL projection check. |
| `tests/changes/overview-preview-apply.test.mjs` | Extends existing fixtures for Database Preview/Apply/rejection, conflicts, rollback/recovery, quota and HTTP tests. |
| `tests/changes/provider-admission.test.mjs` | Shared provider orchestration with mocked Database transports. |
| `tests/artifacts/artifact-safety.test.mjs` | Actual Database candidate impacts and preservation of generated schemas/provenance. |

Overview, Architecture and Tech Stack contracts/policies, legacy `/iterate`,
rejection schema/routes, authorization middleware, revision helpers, allowance
implementation, artifact publishers/exports, migrations and environment settings
were preserved.

## Canonical scope and integrity

Supported entity shape:

```json
{"id":"user","name":"User","fields":[{"name":"id","type":"uuid"}]}
```

Supported relationship shape:

```json
{"from":"user","to":"post","type":"one-to-many","label":"writes"}
```

Entity/field types follow the actual schema. Entity `name` and field `type` are
strings; relationship `type` is exactly `one-to-one`, `one-to-many` or
`many-to-many`. `label` is optional and nullable. There are no field IDs, explicit
field-level foreign keys, primary-key flags, nullability/default/index properties,
physical tables/collections or SQL operations in this canonical model.

Validation rules:

- Entity IDs and field names are exact, case-sensitive, nonblank strings of at
  most 128 characters. Entity IDs must be unique; field names must be unique
  within their entity. Names and field type strings in proposed upserts must
  be nonblank. No silent identifier normalization or invented type enum is used.
- An upsert contains the entire entity and its final field list, up to 500
  fields. It can rename an entity, add/remove/rename fields or change field types.
  Surviving entity IDs remain stable. Surviving field relative order is preserved;
  a renamed field has a new name identity. New entities append.
- Relationships must reference final entity IDs, including newly added entities.
  Self-relations are allowed. A relationship's identity is its ordered
  `(from,to,label ?? null)` tuple. Omitted/null labels are equivalent; empty and
  nonempty labels are distinct. At most one cardinality is allowed per identity:
  duplicate or conflicting entries are rejected. Distinct labeled relationships
  between the same entities are allowed.
- A cardinality change appears as removed/added relationship values, while
  retaining raw extensions for the same endpoint/label identity. Label/endpoint
  changes create a new identity. Surviving relationship order is preserved.
- Entity removal cascades incident relationships. The normalized preview always
  includes the complete resulting relationship list when it changes. An explicit
  replacement containing a removed/missing endpoint is rejected rather than
  silently filtered.
- Duplicate writes to an entity, multiple relationship replacements, unknown
  properties, unsupported operations and ambiguous base data fail validation.
  Full base/candidate structural validation uses `MapprSystemSchema`. Invalid
  base identities/references fail before admission/provider work; no data repair
  is performed. No-op upserts are omitted; wholly unchanged proposals fail.
- Proposals contain 1–50 normalized operations; relationship replacements contain
  at most 500 entries. Empty entity/field/relationship lists are valid where the
  actual canonical schema allows them. Reordering-only edits are not supported.

The shared full-system prompt supplies context for semantic decisions, but schema
validation does not prove domain correctness or execute database migrations.
Other canonical sections have no structural references to these entity IDs in
the current schema. A warning asks users to review architecture, tech stack,
features and development plan; none are silently rewritten.

## Exact API contract

### Preview

`POST /maps/:id/changes/preview`

Header: `Idempotency-Key: <UUID>`. Use the established signed owner cookie,
credentialed requests and configured trusted Origin.

```json
{
  "instruction":"Add an email field to User and make its Post relationship one-to-one.",
  "context":{"activeView":"database","selectedTarget":null},
  "expectedBaseRevision":7
}
```

The stable view identifier is **`database`**; the canonical section is
**`dataModel`**. `data_model`, generated artifact names, and display labels are
not aliases. Instruction remains trimmed and limited to 1–2000 characters.
Unknown request properties are rejected. Expected revision is the existing
positive bounded integer.

Optional entity targeting uses the existing context schema:

```json
{"activeView":"database","selectedTarget":{"kind":"entity","id":"user"}}
```

A selected entity must exist at the captured revision. Entity edits are limited
to that ID and relationship changes to incident relationships. To add another
entity or make whole-model changes, send `selectedTarget:null`. Field or
relationship targets are not supported; `architecture_node`/`feature` contexts
are rejected for this view.

The AI output is strictly `{operations:[...]}` using these allowed shapes:

```json
{
  "op":"upsert_item",
  "collection":"dataModel.entities",
  "value":{
    "id":"user",
    "name":"User",
    "fields":[{"name":"id","type":"uuid"},{"name":"email","type":"string"}]
  }
}
```

```json
{"op":"remove_item","collection":"dataModel.entities","key":"post"}
```

```json
{
  "op":"replace_list",
  "path":"dataModel.relations",
  "value":[{"from":"user","to":"post","type":"one-to-one","label":"writes"}]
}
```

`replace_list` supplies the complete final relationship list. Fields are edited
through a full entity upsert; there is no separate field mutation opcode.
No arbitrary path/root replacement, SQL, code, generated table/collection operation
or extra AI summary is accepted.

The existing immutable `201` response includes:

| Field | Database behavior |
| --- | --- |
| `contractVersion`, `mapId`, `proposalId`, `status` | `1`, map/proposal UUIDs, `"ready"`. |
| `baseRevision`, `context`, `createdAt`, `expiresAt` | Captured revision/context and server timestamps. Current admission policy retains 900-second expiry; use the returned expiry. |
| `operations` | Validated normalized operations, including explicit relationship cleanup. |
| `diff` | Complete existing `SystemDiff`; `dataModel.entities` has added/removed/changed and `dataModel.relations` has added/removed. Other sections are unchanged. |
| `summary` | Deterministic counts of entities added/removed/updated and relationships added/removed. |
| `affectedSections` | `["dataModel"]`. |
| `warnings` | `database_model_only` plus the existing artifact freshness snapshot warning. |
| `artifactImpacts`, `artifactImpactsContext` | S5 predictions with `{asOfRevision:8,semantics:"proposed_revision_snapshot"}` for base 7. |

Entity changes include complete `before`/`after` objects and `changedFields`,
including `fields` when its array differs. For example, this **entity-diff fragment**
shows a field type change and addition:

```json
{
  "before":{"id":"user","name":"User","fields":[{"name":"id","type":"uuid"}]},
  "after":{"id":"user","name":"User","fields":[{"name":"id","type":"string"},{"name":"email","type":"string"}]},
  "changedFields":["fields"]
}
```

Relationship modifications are explicit removed/added values, not an invented
relationship-ID update. Entity removal previews include all cascading removals.
No canonical state or history changes during Preview.

Generator ID: `database-operations:shared-ai-v1`; shared structured response name:
`database_change`; policy:
`{contract:1,operations:4,prompt:1,artifacts:"s5a-provenance-v1",scope:"database"}`.

### Apply and rejection

`POST /maps/:id/changes/:proposalId/apply`

```json
{"approved":true,"expectedBaseRevision":7}
```

Apply uses the existing map-then-proposal locks, fresh ownership/coherence checks,
database-clock expiry, base revision/fingerprint and saved context/policy checks.
It reconstructs/revalidates the saved candidate, operations, actual diff and
summary; clients cannot substitute operations or canonical data.

Only `maps.data.dataModel` is patched. A fixed server-authored JSONB expression
uses bound known-schema values and merges existing raw model/entity/field/
relationship extensions by their validated identities. Exact numbers in unrelated
or retained extension data do not round-trip through JavaScript. Deleted entities/
fields/relationships intentionally disappear; new identities do not inherit hidden
extensions from deleted identities.

Canonical data/counter, an exact history snapshot (`INSERT SELECT`) and the durable
receipt commit atomically. History retains `patch:null` with operations/diff in
`change_metadata`. The shared `200` Apply response returns full authoritative
`data`, `previousRevision`, `revision`, `version`, timestamps, summary/diff,
affected sections/warnings and S5 freshness with transaction-snapshot context.
It performs no AI call, physical database DDL or additional allowance consumption.

`POST /maps/:id/changes/:proposalId/reject`

```json
{"rejected":true,"expectedBaseRevision":7}
```

The unchanged rejection receipt contains `contractVersion:1`, map/proposal IDs,
`status:"rejected"`, `baseRevision` and `rejectedAt`. Rejection is owner-bound,
idempotent, and changes no canonical data/history/artifact/usage. Apply after
rejection returns `410 proposal_rejected`. Rejecting an applied/non-ready proposal
returns `409 proposal_not_ready`; Apply/Reject races serialize and the first
committed outcome wins.

### Shared safety, allowance and errors

All prior safeguards remain shared, including:

- Signed ownership and Origin protections; public shared-link reads grant no
  editing permission.
- Same preview key/body replays the immutable response; changed intent with the
  same key fails. Concurrent same-key generation never starts another provider.
- Successful ready publication consumes one shared daily allowance unit once.
  Failed/invalid generation releases its hold without successful usage; abuse
  attempt limits remain. Apply/rejection/replays consume no additional unit.
  Rejected/expired successful previews are not refunded. Migration-016 accounting
  retains internal operation `overview_preview` for all canonical proposal scopes;
  context/generator/policy identify Database. No payment/billing policy changed.
- All supported views and legacy iteration share one revision sequence. No silent
  rebase is attempted. Lost Apply acknowledgements are resolved by retrying the
  same proposal and reading its immutable receipt.
- The existing `{error,message,requestId,retry,details}` envelope remains.
  Important errors include `400 invalid_request`, authorization errors,
  `422 unsupported_scope`/`change_not_valid`/`no_changes`, `409 revision_conflict`/
  `proposal_obsolete`, `410 proposal_expired`/`proposal_rejected`, quota/capacity
  failures and sanitized generation/timeout errors.

Ready preview responses remain immutable even after application/rejection/expiry;
replay never revives the proposal. Apply receipts can also replay after a newer
canonical revision exists. Client revision/terminal-state ordering is mandatory.

## Generated artifacts and S5 preservation

The existing dependency registry determines impacts for a data-model edit:

| Artifact group | Previously current output after Database change |
| --- | --- |
| Relational/document schemas (`dataModel` inputs) | Stale. |
| API contract, README, critique, requirements, traceability (full-system inputs) | Stale. |
| ADRs, environment variables, deployment (`techStack` + `architecture` inputs) | Can remain current when proven inputs are unchanged. |

Saved artifacts, generation history, payloads and provenance are not rewritten or
regenerated. Missing remains missing and unknown provenance is never promoted to
current. Stale saved schemas remain inspectable through S5; SQL/script and other
exports retain current-only guards. Regeneration remains a separate explicit
artifact action with its existing source capture, publication and accounting.
Preview impacts predict a proposed snapshot; Apply freshness reflects its commit
snapshot, not permanent validity.

## Frontend integration requirements

1. Use the existing Describe a Change UI, edit eligibility, credentialed cookie
   and trusted Origin flow. Send literal `activeView:"database"`, canonical map
   revision, a new preview UUID key and `selectedTarget:null` or an existing
   canonical `{kind:"entity",id}`. Generated table/collection IDs and frontend
   diagram IDs are not canonical entity IDs.
2. Preview the complete entity and relationship diff. Show entity additions/
   removals/name edits and full field arrays before/after; compare field names
   within the entity to display additions/removals/type changes. Render relation
   removed/added pairs and all deletion cascades, summary, warning, artifact
   impacts and expiry. Do not apply preview changes to canonical state.
3. Send only the existing approval/rejection bodies. Require explicit approval,
   disable opposing actions while one is pending, and do not route Database edits
   through legacy Architecture `/iterate` or artifact POST endpoints.
4. On success install the complete authoritative `data`/`revision` in the common
   map cache for Database, Overview, Architecture, Tech Stack, All, JSON and other
   canonical readers. **Older successful or replayed responses must never
   overwrite newer accepted canonical state.** Equal/older receipts must not
   regress newer artifact/UI state. Rejection's base revision is not a canonical
   map snapshot.
5. Invalidate/refetch history and generated database/full-system artifact caches
   after Apply. Keep canonical `dataModel` separate from saved generated schema
   state. Order artifact responses using S5 revision/generation/fingerprint
   metadata, label stale/unknown artifacts visibly, and keep export safeguards.
   Proposed artifact impact metadata must not be installed as current freshness.
6. Retry uncertain requests using the same preview body/key or same Apply
   proposal. On conflict refresh and explicitly preview again; do not rebase
   locally. On expiry during review disable Apply and request a fresh proposal.
   Rejection clears proposal UI without changing canonical state/refunding usage.
   Delayed immutable ready responses must not reopen terminal proposal UI.

Frontend confirmation remains necessary for the `database` identifier mapping,
canonical entity selection, field/relationship diff presentation, logical-model
versus generated-schema modes and shared cache synchronization. Browser/cookie/
CORS and actual multi-view synchronization require verification in the separate
frontend environment.

## Actual verification

| Check | Result |
| --- | --- |
| Combined focused and compatibility offline run | **422 tests: 419 passed, 0 failed, 3 optional PostgreSQL skips.** |
| Database run with explicitly isolated PostgreSQL enabled | **35 passed, 0 failed, 0 skipped.** |
| TypeScript `tsc --noEmit` | PASS. |
| Backend `npm run build` | PASS. |
| Whitespace and source-preservation checks | PASS. |

The offline run covered Database domain/provider/lifecycle tests, existing
Overview/Architecture/Tech Stack behavior, router ownership/rejection, revisions,
daily admission and artifact safety. Database cases include field/entity edits,
cardinality/label/self-relations, selected targets, malformed physical-schema
output, duplicate/dangling/conflicting references, cascade previews, no-ops,
tampering, expiry, conflicts with every supported view and legacy iteration,
in-flight generation conflicts, atomic stage rollback, uncertain-ack recovery,
concurrent Apply/rejection and allowance contention. Providers were mocked; no
live AI request or real allowance consumption occurred.

The isolated PostgreSQL test positively matched the existing separate local PG17
cluster's loopback endpoint, non-application port, database, data directory and
system identifier. It projected only synthetic JSON literals inside READ ONLY
transactions, not application tables. Actual nested SQL preserved exact
`9007199254740993` extensions at root/model/entity/field/relationship levels during
entity/field/cardinality edits, cascades and empty-model projection. The transaction
rolled back and the owned cluster was stopped. No Supabase connection or migration
was involved. The optional Architecture/Tech Stack PostgreSQL checks were not
repeated; their domain/lifecycle regressions passed.

Full real-database proposal lifecycle integration, live-provider output quality,
frontend/browser behavior and deployed endpoints remain unverified. Lifecycle
transaction/concurrency tests used the existing controlled fixtures; the new
storage expression was verified separately on real PostgreSQL.

## Remaining scope and stop point

Overview, Architecture, Tech Stack and Database now have backend handlers in the
shared engine. Design System, Development Plan, API Contract, All and JSON editing
remain subsequent slices; unsupported contexts still fail closed.

No completed migration/release preparation was repeated. No live database,
frontend, environment flag, migration file, deployment, Git index/commit or remote
branch was changed. Complete all requested views and frontend integration before
any separately approved deployment/activation. **STOP for review.**
