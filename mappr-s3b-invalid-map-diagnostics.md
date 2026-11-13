# MAPPR — S3B READ-ONLY DIAGNOSIS OF 13 INVALID MAPS

## Context

The S3B final readiness check successfully reached the confirmed development/testing Supabase PostgreSQL target, but its status-only validation classified 13 of 38 maps as `invalid_system`. Twenty-two maps were eligible for initial snapshot creation, and three had matching history. Migration `013_current_revision.sql` has NOT been executed. The global revision-writes gate remains off.

The goal of this task is to determine **why the 13 existing maps fail the current `MapprSystemSchema`** and recommend the smallest safe resolution. This is a DIAGNOSTIC ONLY task. Do not assume that invalid records are corrupted or disposable.

## Instructions

1. Read `BACKEND_S3B_FINAL_READINESS.md`, `BACKEND_S3B_CUTOVER_PREPARATION.md`, `BACKEND_S3A_IMPLEMENTATION.md`, and `BACKEND_CHANGE_CONTRACT.md`, when present. Read current repository instructions and inspect Git status/diff first.
2. Inspect the exact Zod `MapprSystemSchema`, the generation/iteration validation path, and the S3B status classifier. Confirm that the diagnostic evaluates the same schema and validation options as the cutover tool; do not create a different definition of validity.
3. Investigate the 13 rejected current payloads in a **read-only** database transaction, using the already established verified development target and current operator safeguards. If existing safe diagnostic capability is insufficient, add only a narrowly scoped opt-in read-only diagnostic tool and tests; do not modify application behavior.
4. For each validation failure, classify its Zod issue code and structural path (for example `features[*].<field>` where appropriate), expected type/constraint, and whether the likely cause is a legacy shape, missing field, invalid relationship, malformed value, or other unknown. Aggregate by failure signature, and count affected maps distinctly. Do not claim a cause without evidence. Suppress actual values, names, descriptions, secrets, owner IDs, map IDs, full JSON payloads, and connection details from reports/logs. If a path/key could expose user-generated/private data, generalize it.
5. Cross-check the current schema against any existing repository history/types or known schema migrations to identify **verifiable** compatibility changes. Do not speculate that a record was generated under a particular release without evidence.
6. Determine whether invalidities affect only current `maps.data` or also the available history snapshots. Avoid false claims of fully checked history if current validation short-circuits. Use count-only summaries.
7. Assess whether there is a safe, deterministic, lossless conversion for each *observed* category. If information is missing or interpretation is ambiguous, mark it for explicit product/developer review. Never propose auto-filling invented content or loosening validators globally just to pass the backfill.
8. Keep revision migration, backfill, authorization, generated artifacts, usage, and current data completely untouched.

## Required deliverable

Create `BACKEND_S3B_INVALID_MAP_DIAGNOSTICS.md` containing:
- Verified total map counts, invalid counts, and whether they changed since the previous check.
- Aggregated validation-signature table: structural path, issue class, affected-map count, and evidence-based explanation. A map with multiple errors may appear in multiple categories; distinguish category counts from 13 distinct invalid maps.
- Confirmed current vs. history validation coverage.
- Cause analysis: confirmed vs. plausible vs. unknown.
- Options for preserving and, only after later explicit approval, reconciling each category.
- Whether existing S3B status/backfill assumptions need narrow changes.
- The smallest recommended **next step** after review, including remaining backup and writer-stop prerequisites.
- Exactly what files (if any) were changed, what checks were actually run, and what remains unverified.

## Strict safety boundary

- **No database writes** of any kind: no UPDATE/INSERT/DELETE/DDL, migration, backfill, repair, reset, or snapshot creation.
- Do not enable `MAPPR_REVISION_WRITES_ENABLED` or start S4.
- Do not connect to another database or use an unverified fallback URL.
- Do not leak private map content, identifiers, credentials, or session data into Git, terminal output, reports, or chat.
- Preserve unrelated working-tree changes.
- If read-only inspection cannot be performed safely, explain the blocker and STOP.
- After reporting the findings, **STOP for review**. Do not implement repairs without a separate approved plan.
