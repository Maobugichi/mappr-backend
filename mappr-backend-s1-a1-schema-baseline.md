# MAPPR — BACKEND S1 / A1: RECONSTRUCT EXISTING SCHEMA BASELINE

## Context and goal

Read `BACKEND_S1_SCHEMA_BASELINE.md` and `BACKEND_CHANGE_CONTRACT.md` first. Both were prepared in this separate backend VS Code environment. The S1 inventory confirmed that the configured PostgreSQL database has **13 existing application tables**, while the source repository lacks several definitions and its current `npm run migrate` targets a missing file.

**Implement A1 only:** a reviewed, reproducible **application-only SQL baseline**, its instructions, and a safely isolated test. This is **not** permission to migrate, adopt, repair, or modify any existing database. Universal AI change endpoints and all S2–S5 work remain out of scope.

## Inspect before editing

1. Inspect relevant repo instructions, the Git status/diff, tracked `src/db/migrations/` files, `package.json`, route SQL, and the S1 inventory. Preserve all existing and unrelated changes.
2. Treat the actual inspected catalog and S1 report as evidence of the current schema, **not evidence that the historical missing migration files ran**. If important catalog details are insufficient, perform only strictly read-only verification against the same configured connection if available, and report precisely what was verified. Never print credentials, connection strings, private row data, map IDs, or anonymous IDs.
3. If database target identity cannot be established confidently, do not run any statements that change that target. You can still prepare source files and report test limitations.

## Implement only these files

### 1) `src/db/baseline/001_existing_schema.sql`

- Reconstruct the **13 verified `public` application tables** with the observed columns, types, nullability, defaults, timestamp conventions, PK/UNIQUE/FK constraints, delete actions, and indexes, including separately created indexes.
- Keep exact existing application object names where verified; preserve `generations.map_id ON DELETE SET NULL`, nullable `map_versions.patch`, nullable `deployments.migrations`, and existing artifact key constraints.
- Include only application dependencies needed to create the schema. Do not replicate provider-owned `auth`, `storage`, `realtime`, vault, security roles, secrets, data rows, or unrelated PostgreSQL objects.
- Do not invent historical `001_init.sql` or `003`–`006` files; the consolidated baseline is a new documented boundary, not a reconstruction of unknown migration history.
- Make it **fail closed** if the application tables already exist. Do not use `CREATE TABLE IF NOT EXISTS` to conceal drift or allow accidental replay on a populated schema.
- No S3 revision column, S4 proposal table, S5 provenance columns, migrations ledger, or speculative new constraints in this file. Preserve observed behavior rather than improving the schema during A1.

### 2) `src/db/baseline/README.md`

Document:
- Source/evidence and limitations of the 2026-11-06 S1 catalog inspection; expected PostgreSQL baseline and `gen_random_uuid()` dependency.
- Which 13 application tables are represented and which legacy migration files are covered.
- Difference between **empty disposable bootstrap** and **existing-database baseline adoption**; A1 authorizes neither live adoption nor live migration.
- Required schema comparison checks, safety guardrails, expected index/constraint behavior, and future A2 migration-ledger/runner boundary.
- How to execute isolated tests, what configuration they require, and how to interpret skipped tests.
- No documentation of private DB connection strings, credentials, user content, or production identifiers.

### 3) `tests/db/schema-baseline.test.cjs`

- Use Node's built-in test runner and existing `pg` dependency. No new dependency unless demonstrably necessary.
- Tests that execute SQL must require a **separately configured, explicitly designated disposable database**, never `DATABASE_URL` as a fallback. Require a positive isolation marker/configuration and verify that the target has no existing application tables before DDL.
- Never drop, truncate, reset, or modify the currently configured Mappr application database. Do not automatically delete a test database. Test only inside an approved isolated context and fail closed if target identity/isolation is uncertain.
- Validate the resulting catalog against the S1 inventory: all 13 tables; expected column types/defaults/nullability; primary/unique/foreign keys and delete actions; expected index presence/validity (including the four standalone indexes); and required UUID function.
- Where safe and practical in a clearly disposable environment, verify key relationship semantics (especially ON DELETE SET NULL versus CASCADE) without touching real records.
- If an isolated database is not available, perform non-destructive static checks and report that live schema reproduction was **not** verified. Never quietly redirect testing to the working `DATABASE_URL`.

## Strict scope boundaries

- Do not edit `package.json` or `src/db/pool.ts` in A1.
- Do not modify existing `src/db/migrations/002*` or `007*`–`012*` files.
- Do not run the broken `npm run migrate` command.
- Do not create a migration runner/ledger or adopt the baseline into the populated database (A2 later).
- No writes to existing database objects, data, history, quotas, reviews, or artifacts. No change to routes, AI prompts, services, frontend, authorization, or deployment.
- No new revision/backfill changes and no universal change implementation.

## Verification and report

1. Run appropriate, bounded offline/static checks once. Run actual schema creation/comparison **only** against a positively identified empty disposable PostgreSQL target; if unavailable, say so, do not improvise.
2. Review the Git diff for only the three A1 deliverable files. Never report an unexecuted test as passed.
3. Report: files added; table/column/constraint/index coverage versus S1; commands actually executed; test results; limitations; anything still needing live catalog verification; and the exact A2 handoff.
4. **STOP for human review.** Do not move on to A2/S2/S3/S4/S5, do not apply/adopt SQL anywhere, and do not expose universal editing.

## Acceptance criteria

A reviewer can inspect a faithful, application-only baseline for the previously observed 13-table schema and a safe, independently configured test plan. The existing Mappr database and app behavior remain untouched. Any missing confidence or inability to test is documented, never disguised by a production fallback.
