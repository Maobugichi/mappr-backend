# Mappr S3A: revision-safe canonical writes

Date: 2026-11-07. **Implementation prepared; rollout disabled by default. No
application database connection, schema migration, backfill, or deployment was
performed. Stop for review before S3B.**

## Scope and inspected state

Read `mappr-backend-s3a-revision-safety.md`, the change contract, S1 inventory,
current Git status/diffs, S2/S2.1 code, and relevant writer/history/schema files.
No repository `AGENTS.md` was found. Existing edits and untracked A1/S2 documents,
SQL, and tests were preserved rather than treated as a clean checkout.

The source confirms only two request paths write canonical `maps.data`:
`POST /generate` and `POST /maps/:id/iterate`. Artifact generators update their
own records, not canonical data. The old iteration locks only after AI and can
overwrite another change; the old generator creates no initial history row.
S2's owner/origin guards and S2.1's owner-only no-store eligibility GET remain in
place. Existing history/diff routes use `map_versions.version`.

The S1 report verified PostgreSQL 17.6 and a unique `(map_id,version)` key at its
inspection time. Those observations were not refreshed through a connection in
S3A. The new migration and procedures must still be checked on the actual target
during the separately approved S3B step.

## Changed files

| File | S3A change |
| --- | --- |
| `src/db/migrations/013_current_revision.sql` | Prepared expansion: adds nullable `maps.current_revision integer`, with no default, stronger constraint, data update, or automatic invocation. |
| `src/db/revisionTransaction.ts` | Small SQL transaction helper shared by canonical creation/commit and the operator procedure; releases clients and rolls back on failure, with bounded lock/statement waits. |
| `src/services/canonicalRevision.ts` | Default-off gate; coherent canonical/history reads; initial map/snapshot/usage creation; locked owner/base recheck; immutable snapshot insertion and atomic canonical/usage commit. |
| `src/services/revisionState.ts` | Positive integer revision validation and a pure, no-write backfill classifier. |
| `src/db/backfillCurrentRevision.ts` | Separate export-only S3B operator procedure, taking an explicitly supplied database handle and reviewed candidates. No configured pool import, environment loading, CLI, startup, or npm hook. |
| `src/routes/generate.ts` | Adds the gated atomic revision-1 path and additive successful `revision`. The pre-S3B path stays available when the gate is off. |
| `src/routes/iterate.ts` | Adds coherent base capture before AI, revision-checked commit, typed conflict/not-ready responses, and additive successful `revision` when enabled. Preserves the instruction and architecture-only service behavior. |
| `src/routes/maps.ts` | Adds coherent data/revision reads only when enabled. Existing public read and edit-eligibility authorization semantics remain unchanged. |
| `tests/revisions/revision-safety.test.mjs` | Mocked route/transaction/concurrency tests, migration text checks, and pure backfill-classification fixtures; real database initialization is blocked. |
| `tests/auth/map-edit-authorization.test.mjs` | Explicitly fixes its test-worker rollout gate to false, so the prior S2/S2.1 suite continues verifying the pre-migration contracts independently of shell configuration. |

No existing migration, A1 baseline, database configuration, package script,
authorization middleware, artifact route, AI prompt/service, provider selection,
quota policy, or frontend file was changed. No S4 proposal framework was added.

## Rollout decision and response compatibility

The opt-in is **`MAPPR_REVISION_WRITES_ENABLED=true`**. It is enabled only by that
exact value; absent/other values leave the original development paths active.
No `.env` or deployed configuration was edited. Set and verify the exact value on
every instance during S3B; a misspelled value does not activate the new paths.

With the gate **off**, no new-column query or backfill is invoked. Existing
generation, iteration, and map-read responses keep their old fields, and the
development database need not already have the column. The old lost-update risk
therefore remains until the controlled S3B cutover; S3A does not claim to have
fixed a running database whose gate is still off.

With the gate **on**:

- `POST /generate` retains 201 and `{id,createdAt,updatedAt,data}`, adding
  `revision:1`. It inserts the map with `current_revision=1`, its exact full
  version-1 snapshot, and one successful usage row in the same transaction.
- `POST /maps/:id/iterate` retains `{instruction}` and successful 201 fields
  `{mapId,version,summary,patch,data}`, adding `revision`. `version` and `revision`
  are the same committed number. Patch generation/application is unchanged;
  there is no approval, rebase, automatic AI regeneration, or new quota policy.
- `GET /maps/:id` preserves its existing fields and shared-link permission,
  adding a positive `revision` from the same SQL statement as the returned data.
  The statement also verifies contiguous history, its maximum, and JSONB equality
  of the latest snapshot and current data. It does not independently read a
  revision and then label an older system with it.
- Missing schema, unbackfilled/invalid counters, inconsistent history, or invalid
  current system shape fail closed with
  `503 {"error":"revision_not_ready","message":"Revision migration/backfill is not ready for this map."}`.
  No implicit version 1, `MAX(version)` fallback, or live repair is attempted.
- A stale iteration returns 409 with `error:"revision_conflict"`, a message, and
  `details:{expectedBaseRevision,currentRevision}`. It writes no speculative
  history or successful usage, and does not retry AI. Unknown/non-owned maps
  remain 404; S2's missing-session/origin behavior remains unchanged.

Eligibility still discovers owner permission, not migration readiness or future
change-scope capabilities. It may say `canEdit:true` for an owner whose canonical
read/write is temporarily not ready; the client must handle the explicit 503.
`GET /versions` and `/diff` retain their old shapes and the same version sequence.

## Commit safety

Iteration captures canonical data, revision, and history state in one statement,
validates the current system, then runs the existing AI/patch service without a
checked-out client or held transaction/row lock. Only the SQL commit phase checks
out a transaction client.

At commit, the map row is locked first. The code rechecks the stored owner, the
current revision, and JSONB equality with the captured raw base. A changed revision
conflicts before any write. A same-revision data inconsistency fails not-ready.
With the required READ COMMITTED isolation, history is re-read in a **separate statement after acquiring the lock**, so a writer
that committed while this request waited is not evaluated using pre-wait history.
The snapshot, canonical data/revision/timestamp, and usage are then committed
together. Expected one-row writes are checked; ignored/suppressed writes cannot
silently publish partial success.

Version snapshots are inserted, never updated or replaced. The existing unique
key remains a final collision check. This is application-enforced append-only
behavior, not new database-level permission/trigger enforcement. Privileged or
uncoordinated writers outside these paths can still violate invariants.

Row locks are per map, not a global serialization mechanism. Lock timeout is three
seconds and statement timeout ten seconds per transaction. No timeout is treated
as permission to overwrite/rebase. Unexpected enabled-path failures log generic
diagnostics instead of raw SQL, owner IDs, or system data.

## Prepared migration and separate backfill procedure

`013_current_revision.sql` is the next migration after the existing 012 file. It
does not invent `001` or `003`-`006`, install a runner/ledger, replay a baseline,
change foreign keys, or populate any row. Plain ADD COLUMN intentionally refuses
an already existing column rather than hiding an unreviewed discrepancy.

The operator procedure is the exported function:

```text
backfillCurrentRevisions(verifiedDatabaseHandle, reviewedCandidates)
reviewedCandidates: [{mapId, verifiedOwnerId?}, ...]  // keep these private
maximum batch size: 100 distinct valid map IDs
result: initialized/matched/unchanged/missing/quarantined counts + reason counts
```

Importing or executing that module alone performs no operation. It is not imported
by startup, routes, tests, or npm scripts. No configured application pool or
connection URL is selected implicitly. A one-use operator driver and its target
verification require the S3B review; none was created or run in S3A.

For each reviewed candidate, the procedure starts a bounded transaction, locks
and re-reads the map, and reads its snapshots. PostgreSQL, not text serialization,
computes each snapshot's JSONB equality with the current system. The pure planner
validates current/historical system shapes, contiguous positive versions from 1,
the current counter, and a matching reviewed creator identity:

- No history and NULL counter: insert the full current data as truthful version
  1 and set the counter together. The snapshot is labeled as reviewed backfill;
  it does not pretend that this is the unknown historic SQL execution event.
- Matching valid history and NULL counter: set the actual latest version.
- Matching history and already correct counter: no writes; restart is safe.
- Mismatch, gap, invalid system/history/counter, or unknown/different reviewed
  owner: no map/history/owner writes; count the case as quarantined.

It never rewrites past snapshots, changes canonical data, assigns owners, updates
map timestamps to imply a new product edit, generates artifacts, or charges usage.
Quarantine is a no-write classification in the safe summary, not a new persistent
quarantine registry. Preserve the private review input outside logs/Git and stop
the rollout if any case is unresolved. Do not enable the global gate by assuming
that every non-null counter implies reviewed eligibility.

Transactions commit per map. An SQL failure stops the batch, rolls back that map,
and throws a generic error with a count-only partial summary; earlier per-map
commits remain valid. Repeating the same reviewed batch classifies completed maps
as unchanged. Unprocessed/missing/quarantined candidates must be reconciled with
the full database inventory before any final completeness claim.

## Exact S3B enablement order: future, not executed

1. Review S3A and identify the intended development database, all application
   instances/workers, target role, backups and a tested restore method. Obtain
   approval for the controlled upgrade. Refresh the catalog/constraint inventory
   and verify that this role/connection uses READ COMMITTED as its default
   transaction isolation: the helper uses `BEGIN` and relies on fresh statements
   after lock acquisition. A different configured default is a rollout blocker
   requiring an explicit reviewed isolation setting before enablement.
2. Pause **all canonical writes and drain/stop in-flight generation/iteration AI
   work**, including every older instance. A request captured under the legacy
   path must not commit after backfill. Keep writers stopped through the switch.
3. Take/verify the approved backup and record the pre-upgrade schema/state. Apply
   only `013_current_revision.sql` with explicit target selection and fail-on-error
   handling after checking that the column is absent. Do not use the still-broken
   `npm run migrate` or apply A1's consolidated baseline to this database. No A2
   adoption/ledger operation is authorized here.
4. Prepare private reviewed map/creator candidate batches covering the complete
   inventory, and an explicitly verified database handle. Agree on what evidence
   establishes legacy creator ownership; UUID storage alone is not the review.
   Run the separate operator procedure only under S3B approval. Inspect only safe
   summary counts in logs; do not print candidate IDs, payloads, or raw errors.
5. Re-run full readiness/completeness verification: no unresolved/null/invalid
   current revisions, no gaps, current data equals the matching latest snapshot,
   all payload validation/owner-review prerequisites met, and counts reconcile
   with the preserved inventory. Any quarantine/mismatch is a stop condition,
   requiring a separate reconciliation decision, not forced relabeling.
6. Set the exact gate value `true` on **every** coordinated writer instance and
   restart with the reviewed S3A code before resuming writes. Verify the active
   configuration; do not run mixed legacy/revision-aware writers. Perform only
   separately approved owner/readiness smoke checks, then resume traffic.
7. A later separately reviewed positive CHECK/NOT NULL step is safe only after
   this coordinated writer is active and all eligible rows are verified. Such
   constraints and migrations are not included or applied by S3A.

**Rollback precaution:** do not simply flip the gate off and resume legacy writes
after successful backfill. Legacy generation/iteration would stop maintaining
`current_revision`, causing drift again. On a failed cutover, keep writes paused,
preserve the additive column/snapshots, and choose a reviewed recovery/reconciliation
plan. Never drop records or overwrite history as a shortcut. Database restore can
discard newer writes and requires explicit operations approval.

## Checks actually performed

Ran once for the completed code:

```text
node node_modules/typescript/bin/tsc --noEmit
node --experimental-test-module-mocks --import tsx --test tests/auth/map-edit-authorization.test.mjs tests/revisions/revision-safety.test.mjs
```

TypeScript passed. Node reported **84 passed, 0 failed, 0 skipped** across the
existing S2/S2.1 tests and new S3A tests. The mocked HTTP tests ran outside the
sandbox with approval because the TypeScript loader's OS user-info call was blocked
there in prior stages. Node emits its existing experimental module-mocking warning.
No real database or provider initialization is permitted by these test workers.

Coverage includes atomic generation/version-1/usage; forced failures at map,
snapshot, update, usage, and commit stages; one winner/one conflict for same-base
requests; no loser writes or AI retry; independent map commits; no held connection
or lock during tested AI calls; owner recheck after AI; coherent map/history/diff
responses; missing-column/unbackfilled/inconsistent-state refusal; and 14 pure
backfill planning fixtures, including JSONB key-order evidence and unknown owners.

The migration was read as text for expansion-only checks, **not executed**. The
operator backfill procedure was neither imported nor invoked by tests; its pure
classification helper was tested instead. Actual PostgreSQL DDL, row-lock/wait
behavior, query plans, transaction rollback, full backfill orchestration, lock
timeouts, and real target/data eligibility remain unverified until S3B. A1's
previously skipped disposable PostgreSQL test was not rerun or claimed complete.
The zero skips above describe these mocked suites, not a PostgreSQL integration run.

## Residual risks and review boundary

- The live development database is unchanged and the default-off legacy path
  remains unsafe against concurrent iteration until coordinated cutover.
- The original creator/session correspondence and current full inventory still
  need review; no stale S1 count is used as a backfill success claim.
- New history validation adds indexed aggregate reads; their real query plan,
  latency, timeout behavior, and required READ COMMITTED configuration have not
  been measured/confirmed on the target. Nondefault isolation can turn a
  competing commit into a database serialization failure rather than typed 409;
  verify the precondition before enabling the gate.
- A connection failure around COMMIT can leave its outcome uncertain. Legacy
  iteration is not made idempotent by S3A: refetch before a user retries an
  uncertain response. Durable proposal receipts remain S4 work.
- Frontend revision-ordering gates, browser cookie integration, artifact freshness,
  and full CSRF policy remain separate work. An older HTTP success/replay must
  never replace newer client state, but no frontend files were changed here.

Review the code, expansion, operator procedure, and cutover plan before authorizing
S3B. No S3B, S4, S5, migration runner, database adoption, or universal-change rollout
was started.
