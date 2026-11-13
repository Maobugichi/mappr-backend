# MAPPR — S3B PRE-CUTOVER VERIFICATION (READ-ONLY)

## Objective
Verify that the existing **development/testing** PostgreSQL database and backend deployment can safely support the S3A revision-tracking cutover. This is the small, bounded S3B preflight, not another general architecture audit.

**This task is read-only. Do not run migration 013, backfill, write DDL/DML, set the feature flag, deploy new instances, or resume a mixed-version deployment. Stop for review with an actionable cutover checklist.**

## Sources of truth
- `BACKEND_S3A_IMPLEMENTATION.md`
- `BACKEND_S1_SCHEMA_BASELINE.md`
- `BACKEND_CHANGE_CONTRACT.md`
- `src/db/migrations/013_current_revision.sql`
- `src/db/backfillCurrentRevision.ts`
- `src/services/canonicalRevision.ts`
- `src/db/revisionTransaction.ts`
- current backend repository instructions, Git status, and diff

Inspect actual code rather than trusting the report alone. Preserve unrelated work.

## 1. Verify the target and deployment shape
- Confirm which configured database is used by the current development backend, without exposing credentials, hostnames, cookie IDs, or map payloads. Do not assume the S1 database snapshot is still current.
- Determine how many backend instances, development servers, jobs, or scripts might be writing canonical `maps.data`. Identify an executable plan to stop/drain them before migration and keep them stopped until cutover is complete.
- Confirm the target is **not serving production users**. If identity is ambiguous, stop.
- Determine whether a usable backup and recoverable restore procedure exist. Do not claim that a backup exists based on a configuration setting alone. Do not run a destructive restore test against the working database. If there is no confirmed rollback/recovery plan, stop before proposing writes.
- Inspect the application connection's effective transaction isolation; S3A relies on READ COMMITTED. If it is different, identify exactly what change is needed, but do not make it.

## 2. Read-only database inspection
Where authorized read-only connectivity is available, use a READ ONLY transaction, bounded timeouts, and return counts/metadata only:
- Is `public.maps.current_revision` absent, as expected by migration 013?
- Is `public.map_versions` unique on `(map_id, version)`?
- Current map count, maps with no history, maps with history, latest-snapshot/data mismatches, invalid/gapped/nonpositive histories, and any unexpected pre-existing revision values.
- Confirm the relevant tables/columns/indexes from S1 still exist and are compatible with the prepared SQL.
- Confirm any role privileges needed for the planned migration; inspecting privileges is permitted, exercising write privileges is not.
- Check feasibility of the actual coherent history queries / locking assumptions from S3A without changing data. If a real transaction or query plan cannot be checked safely, mark it unverified.

Never output map IDs, anonymous IDs, private descriptions, data payloads, secrets, or raw database connection strings. Report only aggregate counts and actionable blockers.

## 3. Review backfill candidate handling
- Inspect how `backfillCurrentRevisions(verifiedDatabaseHandle, reviewedCandidates)` obtains verified candidate map/owner pairs and how the operator would supply them without Git, logs, or chat disclosure.
- **Do not equate a stored `maps.anon_id` with independent proof of the current user's authorized session.** Identify a concrete way to verify creator/session ownership under the existing anonymous owner model. If some legacy ownership cannot be verified, quantify that issue without identifying maps and stop before a global enablement plan.
- The entire inventory must be accounted for, including maps created since S1. Do not assume the previous count of 38 remains current.
- Validate that repeat execution would be safe and that quarantined/unknown maps cannot be misclassified as ready.

## 4. Review cutover and rollback
- Confirm migration 013 is additive and does no implicit backfill.
- Confirm `MAPPR_REVISION_WRITES_ENABLED=true` is gated on every running writer instance and that no old writer could commit after cutover.
- Identify the **specific** operator commands or entry point needed to apply migration 013 and run reviewed backfill in a later authorized step. Do not use the broken `npm run migrate` command or apply the A1 baseline to an existing database.
- Identify safe post-cutover checks for new-map revision 1, current-map reads, owner iteration, a stale-base 409, and snapshot equality. Distinguish operations that create a test map from checks that only read data.
- Define failure handling: pause writes, preserve data/column/snapshots, stop rather than flipping the feature flag off and allowing legacy writers to resume.

## 5. Tests
Run existing safe offline checks once if useful. Do not execute integration tests that modify the configured database. Clearly distinguish mocked tests from real PostgreSQL verification.

## Deliverable
Write `BACKEND_S3B_PREFLIGHT.md` with:
1. Verified target and environment (without secrets)
2. Current aggregate database readiness
3. Writer/process inventory and quiescence plan
4. Backup/recovery evidence and unverified items
5. Ownership/backfill candidate verification method and unresolved counts
6. Confirmed SQL/transaction assumptions
7. Exact sequence for a separately authorized S3B cutover
8. GO / NO-GO assessment with explicit blockers
9. Safe test results and outstanding checks

**Do not change application files or database records. Stop and send the report for review. Do not start S4.**
