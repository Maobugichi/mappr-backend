# MAPPR — S3B DEVELOPMENT DATABASE CUTOVER PREPARATION

## Context

We are implementing Mappr's universal natural-language change system. S2/S2.1 authorization is implemented; S3A revision-safe canonical writer code and migration `src/db/migrations/013_current_revision.sql` are prepared but disabled. `BACKEND_S3B_PREFLIGHT.md` reported NO-GO for executing the migration/backfill because recovery, writer quiescence and cutover tooling were unverified, and its browser-session proof standard would require checking every legacy map.

The developer confirms the currently configured Mappr database is exclusively for development/testing. We intend to use this existing database for the eventual S3B migration, not recreate the database in Docker.

**This task prepares and tests a safe, minimal S3B cutover procedure. Do NOT apply migration 013, backfill live rows, turn on MAPPR_REVISION_WRITES_ENABLED, or perform any live database mutation in this task.**

## 1. Inspect existing source and state

Read `BACKEND_S3A_IMPLEMENTATION.md`, `BACKEND_S3B_PREFLIGHT.md`, `BACKEND_CHANGE_CONTRACT.md`, S1 baseline report, repo instructions, current Git diff, `src/db/backfillCurrentRevision.ts`, `src/services/revisionState.ts`, `src/services/canonicalRevision.ts`, migration 013, and existing tests. Reconcile paths to the actual repository. Preserve existing changes.

## 2. Reassess backfill ownership requirements pragmatically and safely

The existing S3A planner requires externally reviewed map/owner candidate pairs and the preflight treats all 38 maps as unverified without browser-cookie checks. Distinguish two different purposes:

- **User editing authorization:** Existing S2/S2.1 guards MUST keep verifying the established signed-cookie session against `maps.anon_id`. A map URL or stored UUID alone does NOT grant editing rights. Do not weaken this.
- **Privileged one-time schema bookkeeping:** Initializing `current_revision` and truthful version snapshots can be performed as an explicitly authorized database-maintenance operation for existing development records, provided the operator establishes database identity, schema integrity, map-owner column integrity, and per-map system/history consistency. It must NOT claim that browser ownership has been independently proved, recover lost sessions, change `anon_id`, or grant edit permission.

Assess whether the backfill planner can safely accept explicitly selected records with their existing stored nonnull UUID owner metadata, without requiring 38 browser visits. If yes, make the smallest reviewed separation between operator-controlled backfill eligibility and browser editing eligibility, with clear naming and tests. If no, explain a concrete security/integrity invariant that prevents this and propose a bounded alternative. Never blindly initialize structurally invalid or conflicting maps; report/quarantine them without changing their data or history.

## 3. Prepare an explicit target-safe operator path

Build only the smallest supporting tooling needed to make S3B executable later, or document a precise supported command if existing tools suffice. Requirements:

- Separate READ-ONLY dry-run/status from mutating execution.
- Use an explicitly selected/verified database target; never silently use an application `DATABASE_URL` fallback for a write operation. A write operation requires an explicit operator confirmation and a target-identity check.
- Fail closed on missing credentials, target mismatch, unexpected existing column, unknown schema, incorrect isolation, invalid payloads, noncontiguous history, owner-column problems, or any quarantined map.
- Require application writers to be stopped/drained before migration/backfill. Provide an operator checklist rather than guessing service/process names; do not kill unrelated Node processes.
- Apply *only* migration 013 when later expressly approved. Never run the broken `npm run migrate` or the A1 consolidated empty-database baseline against the populated target.
- Backfill each map in bounded, restartable transactions; preserve map IDs, existing `anon_id`, `maps.data`, original history, artifacts, usage, and timestamps. Print only aggregate counts, never identifiers, credentials or payloads.
- Prevent mixed legacy and revision-aware writers during activation. Do not flip the gate back off after successful backfill and resume legacy writes.
- Do not add new frameworks, migration platforms, or unrelated refactors.

Any runnable write mode must be disabled/fail closed until a separately reviewed backup and writer-stop plan are confirmed and the developer explicitly authorizes execution. Never auto-run on app startup, import, test, or build.

## 4. Backup and writer readiness: make it achievable

Produce a short operator checklist for the existing development environment:

- How to positively identify the database and connected running backend instance(s).
- How to take and verify a recoverable logical backup using an available PostgreSQL client or the verified database provider's tooling. If neither is available, state the exact missing prerequisite; do not invent a completed backup or substitute a local file search for backup proof.
- How to stop/drain ALL canonical writers (`/generate`, `/maps/:id/iterate`, plus any deployment/worker sharing the database), including in-flight AI, and keep them stopped through migration/backfill/flag change.
- How to verify `MAPPR_REVISION_WRITES_ENABLED=true` on all replacement writers before traffic resumes.

The environment is development/testing, so keep this proportionate, but never treat it as authorization to destroy or overwrite existing records.

## 5. Safe tests and handoff

Add focused tests for operator gate/dry run, existing-owner-metadata integrity, valid initial snapshot/backfill, existing matching history, mismatch quarantine, restartability, target mismatch, unapproved write refusal, and no secret/ID leakage. Use mocks/pure tests unless a positively isolated disposable database is expressly configured. **Do not connect for writes to the configured development database in this task.** Read-only database inspection is permitted if necessary and target-verified. Run TypeScript and relevant tests once and report what they actually exercised.

Create `BACKEND_S3B_CUTOVER_PREPARATION.md` with:
1. Files changed and tests run.
2. Precisely what the new operator process can do and what remains blocked.
3. Which preflight blockers were resolved, with evidence.
4. Minimal, exact actions still needed from the developer (backup verification and live writer inventory, etc.).
5. A concise S3B cutover sequence requiring a separate explicit approval before any database write.
6. GO/NO-GO judgment and remaining risks.

STOP after preparation and review. DO NOT run migration 013, alter live database schema or records, enable the feature flag, deploy, or begin S4.
