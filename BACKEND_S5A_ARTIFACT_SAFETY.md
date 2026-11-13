# Mappr S5A backend artifact safety

2026-11-10. **Backend implementation/offline verification PASS. Not deployed;
migration 015 is prepared, not executed. End-to-end S5 remains unverified.**

## Starting point and preserved work

Inspected Git status, diffs, uncommitted files and preceding activity before
editing. Re-read the S5A brief, S4A implementation handoff and change contract.
No applicable AGENTS.md was found. The interrupted S5A pass had inspected source
but left no S5A implementation files; existing S4A work was retained.

HEAD remains `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513`, with an unchanged index.
The existing S4A migration, proposal scope/authorization, TTL, provider interlock,
credit behavior and historical documents were preserved. No live database,
provider, deployed endpoint or Render control plane was contacted in this task.

## Implemented coverage

All ten artifact POSTs retain their existing generator, model validation/grounding,
successful payload shape, cache key and rate-limit checks. Their existing usage
insert remains in the same successful publication transaction. No billing policy,
quota reservation, charge/refund logic or provider wiring was added.

| Artifact / structured GET and POST under `/maps/:id/` | Existing key | Verified generation dependencies | Backend export |
| --- | --- | --- | --- |
| `api-contract` | map/version | Full canonical system | None; frontend exports require guards |
| `relational-schema` | map/version | `dataModel`, including grounding/junction synthesis | `/relational-schema/sql?dialect=postgres\|mysql\|sqlite` |
| `document-schema` | map/version | `dataModel`, including grounding/reference synthesis | `/document-schema/script` |
| `readme` | map/version | Conservatively full system | `/readme/markdown` |
| `adrs` | map/tech-architecture hash | `techStack`, `architecture` | `/adrs/markdown` |
| `env-vars` | map/tech-architecture hash | `techStack`, `architecture` | `/env-vars/file` |
| `deployment` | map/tech-architecture hash | `techStack`, `architecture` | `/deployment/markdown` |
| `critique` | map | Full canonical system | None |
| `requirements` | map | Full canonical system | None |
| `traceability` | map | Full canonical system | None |

README generation still uses its existing prompt inputs: meta, features, tech
stack, architecture and development plan. It does **not** take `product.summary`.
The conservative full-system fingerprint makes summary edits stale, but this
task does not promise semantic propagation into regenerated README prose.

Both finding-dismissal PATCH routes also participate: critique and requirements.
They preserve known source provenance rather than claiming the current map was
the generation source. Editing legacy output never promotes it to verified.

## Files changed

- New `src/services/artifacts/registry.ts`: ten-type table/key/input allowlist,
  compatible legacy storage hash, generator/policy identifiers and serializer.
- New `src/services/artifacts/provenance.ts`: coherent source capture, freshness
  resolver, map/row locks, guarded publication, immutable generation snapshots,
  review edits and read snapshots.
- New `src/middleware/artifactReads.ts`: structured tracked/legacy reads,
  owner-only stale inspection, all six export guards and coherent rendering.
- New `src/db/migrations/015_artifact_provenance.sql`: additive schema only.
- New `tests/artifacts/artifact-safety.test.mjs`: real route/helper/middleware
  tests over synthetic database/provider boundaries.
- All ten existing artifact route modules listed in the matrix: replace only
  source capture and publication boundaries, preserving generators/upserts/usage.
  Critique and requirements PATCHes gain the same preservation/locking boundary.
- `src/app.ts`: mount the read/export guard after S2 authorization and before
  legacy readers; expose generation/revision/render metadata headers through CORS.
- `src/services/changes/artifacts.ts`, `engine.ts`, `overview.ts`: share the new
  inventory for S4 predictions/receipts and version its artifact policy.
- `tests/auth/map-edit-authorization.test.mjs`: mock S5 storage boundaries within
  the existing S2 authorization/legacy-serialization suite. The new S5 suite tests
  actual provenance and export paths. Existing authorization assertions remain.
- `tests/changes/overview-preview-apply.test.mjs`: extend its SQL fixture for the
  actual S5 inventory, preserving the S4 lifecycle assertions.

The S4A change to `canonicalRevision.ts` is still present and unchanged by S5A.
No new artifact platform, queue, scheduler, provider, sharing permission or
canonical change scope was introduced.

## Provenance, preservation and publication

Migration 015 adds an `artifact_generations` table and a nullable `generation_id`
pointer to each existing artifact table. Existing keys/rows remain. Generation
records contain UUID identity, map/type/storage key, origin, retained source
revision, input fingerprint, generator/dependency-policy versions, exact payload
snapshot/fingerprint, optional review-parent identity and publication time.

The new internal generation table enables RLS without client policies and
revokes PUBLIC access. Its backend role must be its owner or have an explicitly
reviewed RLS-bypass capability; actual role/grant compatibility remains
unverified. This prevents inherited provider grants from silently exposing a
new raw history/provenance API. Existing artifact tables and HTTP public/shared
read access are unchanged.

Source and payload fingerprints use PostgreSQL JSONB text, avoiding unrelated
numeric-data loss through JavaScript reserialization. Input selection is fixed
server SQL; object keys follow JSONB normalization and meaningful array order is
preserved. Existing tech/architecture storage hashes are not repurposed as proof
of provenance. Policy is `s5a-provenance-v1`; generator versions are explicit
`<artifactType>:s5a-1`. Prompt/grounding/dependency compatibility changes require
a reviewed version bump. Actual fallback model identity is not exposed by the
existing provider wrapper and is not invented here.

Publication sequence:

1. Capture canonical data/revision, owner, dependency fingerprint and target-slot
   token in a bounded READ ONLY / REPEATABLE READ snapshot. Refuse incoherent S3
   history. Release the connection before calling the existing AI service.
2. Begin a bounded READ COMMITTED publication transaction. Lock the parent map,
   recheck owner and coherent history in a fresh statement, and compare the actual
   declared dependencies. No canonical counter or data is modified.
3. Lock existing artifact rows, then re-read them. Compare the captured slot token
   (publication identity plus exact payload) so a newer publication or dismissal
   cannot be overwritten by an older in-flight generation.
4. Before a requested regeneration replaces an unverified projection, archive
   its exact saved payload with unknown provenance. Existing verified generation
   snapshots already preserve their prior values. This is on-demand preservation,
   not automatic source backfill or invented legacy provenance.
5. Run the original upsert/usage callback, snapshot the exact resulting row into
   the generation table, attach its pointer and commit everything together.

The generation table is application-append-only; there is no API update/delete
path. Older version/hash rows remain, and overwritten same-key output is retained
in immutable generation snapshots. No historical browsing/download API was added.
Legacy rows remain unknown until explicitly regenerated; dismissal alone does
not establish a generation source.

Concurrent same-slot generation has one publisher; the loser receives 409
`artifact_publication_conflict`. Changed inputs return 409
`artifact_source_changed`. Both leave the saved artifact/usage unchanged. A
selective artifact may publish for its captured older revision if all its actual
inputs still match; its stored version/source revision is never relabeled newer.

The same internal work UUID can recover a lost COMMIT acknowledgement without
duplicating usage while it is still the matching publication. Existing public
artifact POSTs do not gain client idempotency keys: after an uncertain response,
refetch tracked state before explicitly requesting generation again. There is
no automatic AI retry/regeneration or new refund policy.

## Reads and export protection

Wire status follows the existing change contract: `fresh`, `stale`, `missing`.
`fresh` means current for declared inputs; unknown legacy is `stale` with
`provenance_unknown`, not falsely current. Other reasons are `source_changed`,
`payload_changed`, `generator_changed`, `not_generated` and `inputs_unchanged`.

- `GET <artifact>?freshness=tracked`: public/shared current reads remain allowed.
  Prefer a verified matching row, including a legitimately reusable older source
  revision. Return 200 with existing fields plus provenance/freshness metadata.
  If only saved stale/unknown output exists, return 409 `artifact_stale` with
  metadata and inspection URL, **without artifact payload**. Missing is 404.
- `GET <artifact>?freshness=tracked&includeStale=true`: requires the established
  current owner; 401/404 follows S2 conventions. Prefer current output; otherwise
  return the most recent saved row with `isCurrent:false`, `inspectionOnly:true`,
  source/current revisions and reason. Unknown source revision is null. No read
  regenerates, assigns provenance or consumes usage.
- Legacy structured GETs retain current-version/current-hash/unversioned key
  selection and public sharing, with additive truthfulness metadata and
  `readMode:"legacy"`. They are not a substitute for tracked lookup. A reusable
  older-version schema may be available in tracked mode while legacy mode is 404.
- Every supported export URL is current-only, even without `freshness=tracked`.
  Stale/unverified primary output is 409; missing is 404. `includeStale` is invalid
  on exports, not an escape hatch. Saved inspection is structured JSON only;
  there is no stale SQL/script/Markdown/environment-file download override.

All artifact reads/exports set `Cache-Control:no-store` and `Vary:Cookie`.
Metadata includes `sourceRevision`, `currentRevision`, `generationId`,
`sourceFingerprint`, `generatorVersion`, `publishedAt`, `freshness`, `isCurrent`
and `inspectionOnly`. Structured successes also identify tracked/legacy read mode.
Generation and dismissal success payload shapes remain unchanged; clients should
fetch tracked metadata before treating a POST/PATCH payload as a current cache.

The guard is mounted before the existing reader/render handlers and never falls
through to an unchecked export after a recognized-path failure. A route-inventory
test checks all six existing backend export URLs, including case-insensitive
spellings and HEAD requests. Missing provenance schema or
unverifiable revision readiness fails closed with 503; no deployment setting can
select an unsafe export fallback.

README and deployment render from a single READ ONLY / REPEATABLE READ snapshot.
README flags reference only verified current API/schema/ADR artifacts. Deployment
includes only verified current environment variables. Stale/missing optional
support is omitted with an explicit note. Every download is freshly rendered;
support changes at the same canonical revision change its render fingerprint.
Headers expose observed current revision, primary generation UUID and render
fingerprint. These are snapshot observations, not a promise that nothing can
change while the response travels over the network.

## S4 integration

S4 preview resolves impacts against the exact projected candidate JSONB. Apply
resolves against the committed candidate within its map lock; all participating
publishers use that lock. Inventory never rewrites generation records or flips
independently drifting stale flags. Selective verified output can be retained;
unknown or changed output is invalidated conservatively.

Existing response fields remain. Additive `artifactImpactsContext` labels preview
predictions as a proposed-revision snapshot; `artifactFreshnessContext` labels
apply metadata as a transaction snapshot. A replay retains its original receipt,
so frontend clients must invalidate/refetch rather than overwrite newer artifact
cache entries. The artifact validation-policy identifier is bumped; older saved
proposals would require a new preview under the existing policy check.

**S4's production interlock, billing refusal, Overview-only operation and TTL
semantics remain unchanged.** Backend coverage does not remove the frontend and
rollout dependencies; S4 was not enabled.

## Actual verification

Final checks exited 0:

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs tests/artifacts/artifact-safety.test.mjs
```

Result: **290 tests: 289 passed, 0 failed, 1 skipped**. The S5 suite contributes
32 passes, including real router/middleware flows over mocks. The skip is the
optional isolated PostgreSQL integration test; its three opt-in settings were
cleared only in the test process. Experimental module-mock warnings remain.

After adding the prepared generation table's RLS/PUBLIC-access static checks,
the focused S5 suite was rerun: **32 passed, 0 failed**. No TypeScript runtime
source changed after the final build/full regression run.

Coverage includes all ten real POST paths and legacy preservation; relevant and
unrelated source changes; pending-generation HTTP conflict with no held AI-time
DB lease; simultaneous publication; generator/payload drift; rollback at five
stages; uncertain acknowledgement replay; both review edit paths; legacy/current
reads and owner inspection; all six export rejections/successes; missing-schema
refusal; composite dependency regeneration at unchanged revision; coherent read
snapshots; S4 prediction without metadata writes; and existing S2/S3/S4 behavior.

No real SQL, provider calls or production requests ran. Mocked SQL does not prove
PostgreSQL syntax/constraints/FKs, real lock waits/isolation, rollback/COMMIT
behavior, privilege compatibility or deployed performance. Those remain separate
isolated PostgreSQL verification requirements.

File checks preserved earlier reports, S4A migration/authorization/TTL files,
operator tooling and all unrelated project files. `.env`, HEAD and index are
unchanged; configured-secret scan found no matches in new/changed source.
Ignored build output was refreshed. No commit, push, live database mutation,
migration execution, deployment or feature activation occurred.

## Remaining blockers and review boundary

1. Review migration 015, FK/cascade/retention/permissions and runtime source;
   verify them in an explicitly isolated PostgreSQL 17 target under separate
   authorization. No migration execution is authorized by this report.
2. Prepare an approved additive rollout and source release. Preserve recovery
   evidence and prevent mixed unchecked exporters during eventual replacement.
   The S3B operator's fixed schema allowlist would reject 014/015 additions and
   needs its own reviewed status-schema extension before later use. Do not replay
   migration 013, backfill, baseline SQL or the broken generic migrate command.
3. Complete the separate frontend export/cache/inspection changes in
   `FRONTEND_S5_HANDOFF.md`; verify browser credentials and response ordering.
   Backend guards cannot stop client-generated Blob/Markdown/JSON/ZIP exports
   from stale local state. End-to-end S5 is **not** claimed complete.
4. Credits/provider integration and all S4 activation prerequisites remain
   separately blocked. No additional change scope was begun.

STOP for review.
