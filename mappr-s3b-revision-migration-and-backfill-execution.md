# Mappr Backend — S3B Revision Migration and Backfill Execution

## Authorization and exact scope

The developer explicitly authorizes **applying the existing additive migration `src/db/migrations/013_current_revision.sql` and performing the prepared revision backfill** against the *verified Supabase development database*, **only if all existing safety gates pass**.

This authorization does **not** cover enabling `MAPPR_REVISION_WRITES_ENABLED`, restarting/resuming/deploying Render `mappit`, reopening local or hosted write traffic, editing application code, re-running the 13-map legacy reconciliation, executing S4, or deleting/recreating historical records. Stop for review after migration and backfill verification.

## Source of truth

Before doing anything, inspect current Git status/diffs and the relevant implementation, and read:

- `BACKEND_S3B_RECONCILIATION_EXECUTION.md` (successful 13-map reconciliation)
- `BACKEND_S3B_CUTOVER_PREPARATION.md`
- `BACKEND_S3A_IMPLEMENTATION.md`
- `BACKEND_S3B_FINAL_READINESS.md` (historical only; earlier invalid maps have since been reconciled)
- `BACKEND_CHANGE_CONTRACT.md`
- The actual current CLI `scripts/s3b-cutover.mjs`, engine `src/db/s3bCutover.ts`, backfill implementation, and `013_current_revision.sql`

Do **not** treat historical no-go assessments or counts as current if more recent verified results supersede them. Preserve existing uncommitted and untracked work.

## Required pre-write gates

1. **Target and isolation:** Use the existing explicitly selected, private, pinned S3B operator configuration outside Git; verify its database, role, fingerprint, TLS policy, PostgreSQL version, schema and default `READ COMMITTED` transaction isolation. Never fall back to the app `DATABASE_URL` implicitly or display secrets.
2. **Writer quiescence:** Verify Render service `mappit` remains suspended, the local backend is stopped, Supabase Data API remains disabled, and no other known direct SQL clients, jobs, or other backend instances can write. The developer previously confirmed these states, but prior confirmation alone is not real-time proof. Check any available control-plane evidence, identify any limitations, and establish a credible current stop/drain state, including in-flight AI requests. **If writer containment cannot be established to the operator's satisfaction, STOP without DDL or DML.** Do not silently broaden privileges or alter Data API settings.
3. **Recovery:** Check the existing verified, isolated restore evidence for the public application schema, current recovery artifacts, and evidence from the successfully completed 13-map reconciliation. Preserve its original-data recovery evidence. Since the old archive predates reconciliation, capture a current restricted pre-013 recovery point/snapshot if the approved recovery procedure requires it; verify archive integrity and do not overwrite the existing verified backup. Do not restore into the working database. **If current recoverability is not adequate for this cutover, STOP.**
4. **Fresh, read-only status:** Run the prepared `status` mode against the pinned development target. Require 38 structurally valid current maps and 6 existing history snapshots (or reconcile any verified legitimate change); zero quarantine; consistent existing history, snapshots and owners; and `current_revision` absent. Do not assume earlier results still hold. If already partially migrated, do not repeat DDL; inspect and STOP or follow only an explicitly supported, verified recovery path.
5. **Approval/config:** Build or use a restricted execution-approved private config only after the above pass; meet the current CLI's exact `developerApproved`, `backupVerified`, `writersStopped`, evidence-reference, pinned target and confirmation-token requirements. Do not place secrets or operator config inside Git. Do not bypass the CLI gates.

## Execute ONLY migration and backfill

6. Apply **only** the existing migration 013 using the reviewed `scripts/s3b-cutover.mjs --mode migrate` path and the documented exact authorization token `AUTHORIZE_S3B_DEVELOPMENT_WRITE`. Do not use the broken generic migration runner, A1 baseline, or a hand-written substitute SQL command. Check the result; stop on any discrepancy or uncertainty.
7. With **all writers still stopped** and the feature gate still **OFF**, run the existing `--mode backfill` path against the same pinned target with the same documented authorization gates. Do not create a different operator implementation or silently repair rows. Expected outcome for the previously reconciled 38-map inventory, **if membership and history are unchanged**: 35 maps initialized with truthful version-1 snapshots; three maps matched to their existing valid history (six preexisting history rows); zero quarantined; original history rows preserved. Counts are expectations to verify, not permission to ignore divergence.
8. Run post-operation **read-only status** and independent coherence checks on the actual development database. Verify all maps have positive, coherent `current_revision`, contiguous histories starting at 1, latest snapshots JSONB-equal to `maps.data`, no orphan snapshots, and zero quarantine; `revisionReady:true` if supported. Preserve 38 map records, owners, descriptions, timestamps, artifact records and usage; preserve the six preexisting history rows exactly, and confirm only the intended new snapshots and revision counters were added. Report actual totals and explain differences from expectations. Do not trigger billable AI requests or generate/iterate as a smoke test.

## Failure and interruption handling

- No automated retries if migration or backfill commit outcome is uncertain. Use read-only status to establish whether the step already happened; follow documented idempotent backfill behavior only after reconciliation.
- If any precondition fails, STOP before writing and report a sanitized failure stage.
- If a write step fails or is uncertain, keep every writer stopped, preserve existing partial progress and private evidence, and report what is verified. Do not drop the column, overwrite history, replay migration 013 blindly, or flip the feature gate off and resume old writers.
- Keep secrets, map IDs, owner IDs, source payloads and private backup/recovery artifacts out of logs, Git and the final report.

## Deliverable and stop

Create/update `BACKEND_S3B_REVISION_MIGRATION_EXECUTION.md` with:

- Explicit whether DDL and backfill were **actually attempted and committed**, individually
- Verified target identity (safe fingerprint only), quiescence and recovery evidence references (no secrets)
- Fresh preflight counts, migration result, per-batch backfill summary, final `revisionReady` and consistency counts
- Independent preservation checks, test/check commands actually run, any uncertain outcomes, and remaining steps

**STOP after verification. Do NOT set `MAPPR_REVISION_WRITES_ENABLED=true`, restart Render `mappit`, start local writers, deploy, or begin S4. Revision-write activation is a separate approval and coordinated cutover.**
