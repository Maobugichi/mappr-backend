# Mappr S3B — Unblock current backup restore verification

## Context

The developer has separately authorized **migration 013 and revision backfill only**, subject to every existing cutover safeguard. The latest S3B execution attempt stopped without running either database write because verification of a **local, isolated PostgreSQL 17 recovery cluster** failed at `verify_isolated_cluster`, before the new archive was restored. The verified development Supabase database has 38 schema-valid maps, 6 existing snapshots, 35 initialize candidates, 3 match candidates, 0 quarantine. The post-reconciliation pre-013 backup already exists, was generated with `pg_dump`, and passed SHA-256 and `pg_restore --list` checks.

## Task — narrow operational recovery check

1. Inspect `BACKEND_S3B_REVISION_MIGRATION_EXECUTION.md`, the most recent private failed-recovery record and restore instructions, and relevant existing local PostgreSQL tool/cluster configuration. Preserve Git work and all private artifacts. Do **not** repeat schema audits or rewrite migration/executor code.
2. Determine which exact **local** step failed: starting PostgreSQL, `pg_isready`, TCP connection, authentication, role/database verification, creating/selecting the isolated empty restore database, or a preliminary SQL probe. Report the precise stage and sanitized native error/SQLSTATE if present. The prior `isolated_recovery_failed` code is too broad to diagnose.
3. Before any local DDL or `pg_restore`, positively establish that the target is an isolated **loopback** PostgreSQL 17 cluster, not the application Supabase endpoint. Pin the actual local host/port/data directory and test database identity; refuse ambiguous configuration. Never create/drop databases or restore on the Supabase application target or an existing backup-recovery database.
4. If the issue is local setup or authentication and can be corrected without changing the application or existing protected data, make the smallest adjustment to the **isolated test environment only**, then perform **one controlled restore verification** of the already-created, current pre-013 archive to a new empty isolated test database. Use the existing PostgreSQL 17 tools and private credentials. Do not overwrite the earlier restored database or the archive.
5. Verify restore exit status, 13 application tables, 38 maps, 6 history rows, constraints, indexes, foreign-key/orphan and snapshot consistency, and compare the restored backup against the recorded **post-reconciliation source preservation baseline** as supported by the retained evidence. If any part fails, stop with an exact sanitized blocker; do not infer success from `pg_restore --list`.
6. Preserve the backup, checksums, evidence and logs privately. Stop the isolated restore cluster afterward. Report only safe aggregate counts and outcome.
7. If the current backup's restore verification succeeds, perform only a concise status of remaining S3B prerequisites: what writer containment is independently verified, what still relies on developer confirmation, and whether fresh read-only status must be repeated. **Stop for review.** Do not automatically proceed with a source-database write from this task.

## Strict boundaries

- No writes, DDL, restores, credential changes, or table permission changes on the working Supabase development database.
- Do not invoke migration 013, revision backfill, feature-flag activation, deployment, Render restart or S4.
- Do not rerun the prior 13-map reconciliation; it is complete.
- Do not create another backup unless the saved archive has been proven unusable, in which case report and stop first.
- Keep the current known writer paths stopped; do not claim to have verified remote Render or Data API settings without control-plane evidence.
- Avoid exposing hostnames, connection strings, database credentials, map/owner IDs or original private map content.

## Report

Write `BACKEND_S3B_CURRENT_RESTORE_VERIFICATION.md` with the precise earlier failure cause if established, commands/actions performed (redacted), restore result and aggregate parity checks, any remaining blockers, and confirmation no source database write was performed. Stop for review.
