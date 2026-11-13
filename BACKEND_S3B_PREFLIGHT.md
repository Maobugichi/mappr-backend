# Mappr S3B read-only preflight

Date: 2026-11-07. **NO-GO for migration, backfill, or global revision-write enablement.**
The read-only inspection is complete; stop for review. No migration 013, backfill,
DDL/DML, feature-flag change, deployment, endpoint mutation, or AI call was performed.

## 1. Target, scope, and evidence

Read `mappr-backend-s3b-preflight.md`, `BACKEND_S3A_IMPLEMENTATION.md`,
`BACKEND_CHANGE_CONTRACT.md`, the S1 baseline report, and the actual S3A/S2/S2.1
sources. Inspected Git status, staged/unstaged diffs, and untracked implementation
files first. No applicable repository/ancestor `AGENTS.md` was found. Existing
changes were preserved; this report is the only added project file.

The connection came from the workspace dotenv configuration, with the same
process-environment precedence and TLS behavior as `src/index.ts` and
`src/db/pool.ts`. No process-level database URL override was present.
Effective local `NODE_ENV` was `development`; the revision flag was absent/off.
The user identifies this target as the verified development database. These facts
support the authorized read-only inspection, **not independent proof that every
running deployment uses this configuration or that production traffic cannot
reach it**. Operational confirmation of that boundary remains a cutover blocker;
stop if the target is found to serve production.

The first connection was sandbox-denied (`EACCES`); the approved read-only retry
succeeded. Aggregate/catalog snapshot: **2026-11-07 06:41:46 UTC**. Explicit
transaction-local timeout confirmation and repeated plan inspection:
**06:43:25 UTC**. All queries were inside explicit READ ONLY transactions ending
with ROLLBACK; the catalog/count transaction used REPEATABLE READ for one coherent
snapshot. Application isolation was measured separately using plain
`BEGIN READ ONLY`, without overriding isolation.

Connection-startup timeout/read-only options were not retained by this connection:
observed defaults were read-only off, statement timeout two minutes, lock timeout
zero. Explicit READ ONLY still protected both inspection passes. The first pass
also had a 15-second client query timeout. The second pass explicitly set and
verified local statement timeout **10 seconds** and lock timeout **1 second**
(and set a 20-second idle-transaction timeout). These session-local settings were
rolled back; no application configuration was changed. Only counts/schema/plan
metadata were returned; no IDs, cookies, descriptions, payloads, credentials, or
connection hostnames were disclosed.

## 2. Current aggregate database readiness

| Check | Verified result |
| --- | --- |
| PostgreSQL | 17.6 (`170006`); effective nonimplicit search path `public, extensions` |
| `maps.current_revision` | Absent, as migration 013 expects |
| Pre-existing revision values | Not applicable: the column does not exist; no null/positive-value count is claimed |
| Maps | **38** |
| Maps without history / with history | **35 / 3** |
| Latest snapshot equals current data / differs | **3 / 0**, among maps with history, using PostgreSQL JSONB equality |
| Snapshot rows / orphan snapshot rows | **6 / 0** |
| Histories not starting at 1 | **0** |
| Histories with internal gaps / not contiguous from 1 | **0 / 0** |
| Histories with nonpositive / duplicate versions | **0 / 0** |
| Null stored owners / distinct stored owner values | **0 / 10**; UUID storage is not session ownership evidence |
| Nonobject current JSON payloads | **0**; this is not full Zod validation |

The total matches S1's earlier 38, but these are freshly queried counts, not a
reused inventory. Equal totals do not prove identical membership or absence of
intervening creation/deletion. Freeze and enumerate the complete inventory again
at cutover.

Fresh catalogs show the same 13 ordinary application tables, 78 columns,
36 validated/nondeferrable primary/unique/foreign-key constraints, and 28
valid/ready indexes described by S1. Reviewed types, defaults, nullable columns,
and foreign-key delete rules remain compatible with the prepared code.
In particular:

- `maps`: UUID primary key/owner, JSONB data, description and timestamps.
- `map_versions`: non-null integer version, JSONB data, nullable patch, summary;
  validated `UNIQUE(map_id, version)`, map FK, and descending map/version index.
- `generations`: UUID owner and nullable map FK with SET NULL deletion behavior.
- No application triggers or RLS enforcement were observed; history remains
  mutable by the inspected role. Application append-only behavior is not a
  database immutability guarantee.

All 13 tables passed inspected SELECT/INSERT/UPDATE/DELETE privilege predicates;
public schema USAGE/CREATE and an ownership/membership/superuser predicate also
passed. These are catalog evidence, not an exercised ALTER permission test or
approval to use the role for writes. The separately selected migration role,
effective ownership/role activation, and target must still be confirmed.

Full `MapprSystemSchema` validity of current and historical payloads was **not**
tested by exporting rows. Shape-invalid totals therefore remain unknown. The
backfill planner must validate them privately and quarantine failures before any
global activation; clean version counts alone do not establish readiness.

## 3. Writer/process inventory and quiescence

Source inspection finds **two canonical-data request writers**:
`POST /generate` and `POST /maps/:id/iterate`. Each has a legacy/default-off path
and a gated S3A path (`src/routes/generate.ts`, `iterate.ts`,
`src/services/canonicalRevision.ts`). Artifact routes do not write `maps.data`.
The export-only backfill updates the counter and may insert initial history.
No additional scheduled canonical writer or backfill invocation was found in
`src/` or `package.json`; external/direct SQL writers cannot be excluded.

Local enumeration found **two Node processes, zero positively identified Mappr
backend entry points**. After sandbox CIM denial, approved metadata inspection
succeeded: neither command line referenced this workspace or the recognized
source/built backend entry points. They must not be assumed to be Mappr servers
or stopped indiscriminately. This does not enumerate other VS Code environments,
containers, remote deployments, jobs, or parent supervisors.

At the database snapshot: **5 other client sessions, 0 active sessions,
0 idle-in-transaction sessions, 0 visible active canonical DML**, with no
visibility-hidden sessions in that aggregate. An idle database does not exclude
an in-flight AI request that will later acquire a connection. No writer was
stopped or drained in this task.

**Required operator plan:** identify each actual supervisor/service and its
database target; block new generation/iteration requests; stop/drain their
in-flight work; stop every old writer before backfill. For a verified local
`npm run dev` instance, stop its owning nodemon terminal with Ctrl+C and verify
both supervisor and child exited; stopping only a child permits respawn.
For a verified built instance, stop its owning terminal/service and disable
automatic restart. Remote service/job stop/scale commands cannot be specified
truthfully until the deployment inventory is supplied. Confirm all relevant
processes and application DB transactions are gone, not merely idle. Keep them
stopped throughout migration/backfill/configuration replacement. There is no
repository graceful-drain endpoint or signal handler; a lost response during
shutdown requires outcome inspection, not blind retry.

**Blocker:** the complete writer count, service-specific stop commands, and all
running instances' effective targets/flags remain unverified.

## 4. Backup and recovery evidence

No usable backup, restore log, retention/recovery point, or demonstrated recovery
procedure was supplied or verified. A bounded workspace scan found **zero**
backup archive candidates (`.dump`, `.backup`, `.bak`, `.sql.gz`); it cannot
establish whether provider backups exist. No provider backup/deployment access
was available through the connected tools. No dump, restore, or destructive test
was attempted.

Before proposing execution of any writes, operations must identify a completed
backup covering the application schema/data and ownership/history, its recovery
point, the authorized recovery operator, and evidence of a usable restore into
an isolated target. Provider configuration or a scheduled-backup toggle alone
is insufficient. Record how the application would reconnect to a recovered
database. **Unverified backup/recovery is a hard NO-GO.**

## 5. Ownership and reviewed backfill candidates

`src/middleware/anonSession.ts` verifies an established signed cookie.
`mapEditAuthorization.ts` and `GET /maps/:id/edit-eligibility` compare that
verified session identity with stored ownership. Public shared-link reads grant
no edit authority. No cookie was requested, read, logged, or used by this task.

A concrete verification method for a later reviewed operation is:

1. The creator uses their existing browser/session to request the no-store,
   credentialed eligibility endpoint; require an actual 200 owner result.
2. A separately reviewed, private operator workflow binds that successful check
   to the server-verified established session identity and the same map. Recheck
   against the frozen database inventory when constructing the candidate pair.
   Never synthesize a cookie or copy stored `anon_id` and call it independent
   proof. The eligibility response intentionally does not expose the owner ID.
3. Keep reviewed pairs/evidence in a restricted operator input outside Git,
   stdout, request logs, and chat; print only summary counts. Do not treat a
   fresh visitor cookie, shared link, or usage record as creator-session proof.

**Independently verified by this preflight: 0 of 38 maps. Unresolved review
coverage: 38 maps across 10 stored owner values.** This does not mean 38 owners
are lost or invalid; session evidence was unavailable. Cookie-loss/legacy cases
require a product-approved recovery decision; no automatic reassignment or new
sharing permission exists.

`backfillCurrentRevisions(verifiedDatabaseHandle, reviewedCandidates)` takes an
explicit handle and at most 100 distinct map-ID candidates; missing/unmatched
verified owners quarantine. It has no candidate-discovery mechanism, CLI,
automatic invocation, or default connection (`src/db/backfillCurrentRevision.ts`).
No private reviewed inventory or operator driver currently exists in the repo.

The planner validates current/history shapes, contiguous versions, JSONB
snapshot equality, and counters. Completed candidates classify unchanged on
repeat; each map commits separately. An SQL failure rolls back the current map
and stops the batch with count-only progress; earlier commits remain. Quarantine
is not a persisted ready registry. Reconcile candidate membership as well as
counts, including missing/quarantined/unprocessed maps and maps created since
this inspection. **Any unresolved coverage blocks the global flag.**

## 6. Confirmed SQL and transaction assumptions

- The configured application's effective default and plain-BEGIN isolation are
  **READ COMMITTED**. This meets `src/db/revisionTransaction.ts`'s reliance on
  fresh statement snapshots after the map lock. No isolation change is needed
  for this inspected configuration; recheck every actual writer/driver session.
- `013_current_revision.sql` contains a bounded transaction and one additive
  nullable integer column, without default, backfill, or stronger constraint.
  Plain ADD COLUMN intentionally fails if an unexpected column already exists.
- `readRevisionedMap` captures canonical/history state in one SQL statement.
  Commit locks the map, rechecks owner/base, then reads history in a separate
  statement before inserting snapshot/updating canonical state/usage atomically.
  External AI work occurs before that SQL transaction.
- Read-only **EXPLAIN, without ANALYZE**, succeeded for the coherent canonical
  read and locked-map query after substituting only the missing counter
  projection with `NULL::integer`, plus the actual backfill history query.
  Plans use `maps_pkey` and `map_versions_map_id_version_idx`; the lock plan
  contains LockRows. Synthetic parameters were used; no real identifiers or
  row contents were returned.
- This proves planning compatibility for those pre-column equivalents, not
  execution of the exact post-013 queries. No FOR UPDATE statement was executed,
  no application row lock was taken, and no contention/rollback/commit test ran
  against PostgreSQL. Real concurrent lock behavior remains unverified.
- Source-local gate is off. Flags on remote/running writers were not inspected.
  Enabling one instance while legacy writers remain would invalidate safety.

## 7. Conditional sequence for a separately authorized cutover

**This is a blocked review checklist, not permission or a ready-to-run runbook.**
Do not start its write steps until the target, backup/recovery, owner coverage,
driver, and complete writer-stop plan are approved.

1. Confirm nonproduction target/deployment ownership and all writer settings;
   review backup/restore evidence and establish the maintenance window.
2. Stop/drain all canonical writers and in-flight AI as above; freeze the final
   private inventory. Recheck isolation, absent column, schema, privileges, and
   counts under the selected target/role. Preserve a verified recovery point.
3. Apply **only** `src/db/migrations/013_current_revision.sql`. The intended
   explicit entry point, once a verified private connection service and client
   exist, is:
   `psql -X --no-password --set=ON_ERROR_STOP=1 --dbname=service=mappr_s3b_verified_dev --file=src/db/migrations/013_current_revision.sql`.
   The service name is a proposed private configuration, **not an existing
   verified service**. Store connection credentials outside argv/history.
   `psql`, `pg_dump`, `pg_restore`, and `docker` were not found on this shell's
   PATH; provisioning a reviewed client/service is an outstanding prerequisite.
   Do not use broken `npm run migrate` or A1's empty-database baseline.
4. Use a separately reviewed private operator driver to import
   `backfillCurrentRevisions` from `src/db/backfillCurrentRevision.ts` and pass
   the explicitly verified pool plus reviewed candidate batches. Such a driver
   must verify the target/isolation, protect inputs, report counts only, and
   stop on any failure/quarantine. **It does not yet exist; running the export
   file alone does nothing. There is no executable backfill command to claim.**
5. With writers still stopped, verify full inventory coverage, payload validation,
   positive counters, min=1/max=count=current revision, and snapshot equality.
   For the present structurally clean inventory the potential split is 35
   initializations and 3 matches, **conditional on ownership/shape review**;
   these are not approved candidates or promised backfill outcomes.
6. Configure every replacement writer with the reviewed S3A code and exact
   `MAPPR_REVISION_WRITES_ENABLED=true`; verify each instance before allowing
   traffic. No old/off writer may remain or resume. Run separately approved
   smoke checks, then reopen writes; retain read-only shared-link semantics.
7. On any failure keep writes paused, preserve column/snapshots and partial
   progress, and inspect/reconcile or use the reviewed recovery plan.
   **Do not flip the flag off and resume legacy writes.** An uncertain legacy
   commit/HTTP outcome requires refetch/history inspection; S4 durable apply
   receipts do not exist yet. Do not drop the column or rewrite history as an
   automatic rollback.

## 8. GO / NO-GO assessment

**NO-GO for any write/cutover.** Compatible schema, READ COMMITTED, clean
structural history counts, and viable plans are positive evidence, but they do
not clear these blockers:

1. No independent operational confirmation of production separation and the
   complete running deployment/writer inventory or service-specific stop plan.
2. No confirmed usable backup and recoverable restore procedure.
3. **38/38 maps lack independently reviewed session-owner evidence here**;
   private candidate membership and full current/historical payload validation
   remain outstanding.
4. No reviewed executable backfill driver/private target service; no PostgreSQL
   CLI found in this shell.
5. Exact post-column query execution and real PostgreSQL transactional/concurrent
   write behavior remain unverified. Perform those write tests on an explicitly
   isolated disposable database first, or seek separate approval for narrowly
   scoped development smoke writes after all prerequisites are met.

No automatic repair, migration, enablement, or S4 work should follow this report.

## 9. Verification results and remaining checks

**Run in this task:** `node node_modules/typescript/bin/tsc --noEmit` once:
**PASS**, exit 0, no emitted build. Read-only PostgreSQL catalog/count/isolation
queries and nonexecuting plan checks succeeded as described above. Process
metadata inspection succeeded after approved escalation. No configured-database
integration tests or live write endpoints were run.

The S3A report records 84 combined mocked auth/revision tests passing. Those
tests were not rerun here and are not real PostgreSQL evidence. Full schema
validation and actual backup, migration, backfill, concurrent commit, and
HTTP/browser behavior remain unverified.

Later **read-only** checks: catalog confirms the new column; aggregate SQL
reconciles counters/history/equality; existing-map GET returns coherent
data/revision; history/diff and owner eligibility GETs retain contracts; shared
links remain readable. Do not use these GET successes as proof a write committed.

Later **mutating, separately approved** checks: create a disposable test map
(`POST /generate`, AI/quota use), verify revision/snapshot 1; iterate as its
established owner, verify one new revision/snapshot and canonical equality.
A controlled concurrent pair must capture the same base before either commit:
one succeeds and the other returns 409 with no extra snapshot/usage. This is
not obtained by adding an unsupported revision field to the legacy request.
These tests can commit data and consume AI credits and were not performed.
Verify frontend revision ordering, credential delivery, conflict handling, and
cache synchronization in the separate frontend/browser environment.

**Stop for review.**

