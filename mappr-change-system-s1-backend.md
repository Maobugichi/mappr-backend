# MAPPR — UNIVERSAL CHANGE SYSTEM
## Backend milestone S1: Database schema inventory and safe migration baseline

**Environment:** Backend VS Code repository only. The frontend is in a separate VS Code environment.

**Context:** The frontend and backend audits are complete. `BACKEND_CHANGE_CONTRACT.md` contains the proposed universal-change protocol. The frontend compatibility audit confirms the Overview pilot targets `product.summary`, but the new API is not implemented. This task is the first bounded backend foundation milestone, NOT authorization to deploy the universal change feature.

## Objective
Establish a verified, reproducible database schema baseline and a safe, concrete migration plan for the new revision/proposal system, without disturbing working production data or current Mappr endpoints.

## 1. Inspect current state

Read repository instructions, `BACKEND_CHANGE_CONTRACT.md`, the current Git status/diff, migration scripts, `package.json`, DB connection utilities, and relevant route/service queries. Trace existing tables and indexes used by:

- Maps and anonymous map ownership.
- Initial generation and usage accounting.
- Map versions / iteration / diffs.
- Existing reviews, API contracts, relational/document schemas, ADRs, README, environment variables, and deployment.

Distinguish **observed repository definitions** from **inferred deployed schema**. Do not presume that the absent `001_init.sql` implies the live database is missing its tables.

## 2. Verify deployed schema safely where already authorized

If this backend environment provides legitimate database inspection access, run **read-only** schema inspection (for example, catalog/`information_schema` queries), including table definitions, primary and unique keys, foreign keys, indexes, nullability, and existing migration records. Never print connection strings, credentials, cookies, secrets, or private record content.

Do not run DDL/DML or apply migrations yet. Do not read user-generated map payloads merely for convenience. If database access is unavailable, mark deployed details as unverified and list the exact read-only evidence needed; continue with the repository inventory.

## 3. Reconcile migration history

Identify:

- Tracked migration files, ordering, and missing baseline files.
- Migration command behavior and whether it can recreate a fresh development database.
- Potential discrepancies between tracked migrations and observed deployed tables.
- Safe additive migration/backfill prerequisites for `maps.current_revision`, immutable version snapshots, and later proposal tables.
- Handling of legacy maps whose saved `data` does not match the newest stored version snapshot; never silently relabel mismatched histories.
- Dependencies and rollback/restore considerations for planned schema migrations.

## 4. Plan the smallest safe S1 implementation

Propose a dependency-ordered set of separately reviewable changes. Clearly distinguish:

A. Repairs needed to obtain a reproducible baseline.
B. Revision-related schema changes for S3.
C. Proposal, quota-reservation, and artifact-provenance schema work for S4/S5.

Avoid creating speculative replacements for existing live tables. Preserve all existing records and API behavior. Do not broaden scope into preview/apply routes, AI logic, authentication changes, or frontend implementation.

## 5. Deliverable

Create `BACKEND_S1_SCHEMA_BASELINE.md` containing:

1. Confirmed repository findings with file paths.
2. Verified deployed schema findings, or explicit access limitations.
3. Table-by-table migration inventory and discrepancies.
4. Current migration runner behavior and reproducibility issues.
5. Safe migration/backfill strategy, including handling of existing data and inconsistent histories.
6. Smallest recommended next code-edit milestone with precise files.
7. Tests and acceptance gates before any migration is applied.
8. Blockers, unknowns, and required product/operations decisions.

**Do not modify application code, migrations, or the database in this task.** Do not expose secrets. Stop after the S1 report so the migration plan can be reviewed before code or production database changes.
