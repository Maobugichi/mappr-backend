# Mappr S1: verified schema baseline and migration plan

Date: 2026-11-06. Status: **inspection complete; implementation and database changes require review.** Scope follows `mappr-change-system-s1-backend.md` and `BACKEND_CHANGE_CONTRACT.md`. The S1 brief supplies frontend confirmation that the Overview pilot targets `product.summary`; no frontend files were inspected. This report does not authorize universal-change deployment.

## 1. Confirmed repository findings

- Repository/ancestor instruction-file inspection found no `AGENTS.md`. Git's tracked working-tree and staged diffs were empty at entry. Existing untracked files were `BACKEND_AUDIT.md`, `BACKEND_CHANGE_CONTRACT.md`, and `mappr-change-system-s1-backend.md`; they were preserved. This report is the only new file from this task.
- The tracked migration directory contains exactly `002_architecture_reviews.sql`, `007_relational_schemas.sql`, `008_document_schemas.sql`, `009_adrs.sql`, `010_readmes.sql`, `011_env_vars.sql`, and `012_deployments.sql`, all under `src/db/migrations/`. They contain `CREATE TABLE IF NOT EXISTS`, without a migration ledger, checksum verification, or explicit transaction wrapper.
- `001_init.sql` and migration numbers `003`-`006` are absent. A search of available Git history did not recover files in those missing slots. Their intended historical names/content must not be invented.
- The repository lacks DDL for `maps`, `generations`, `map_versions`, `missing_requirement_reviews`, `traceability_reviews`, and `api_contracts`. **These six tables nevertheless exist in the inspected database.** This is a reproducibility/history gap, not evidence that production tables need creating.
- `package.json:10` runs only `psql "$DATABASE_URL" -f src/db/migrations/001_init.sql`. `src/db/pool.ts` uses `DATABASE_URL` and TLS with `rejectUnauthorized: false`; `src/index.ts` loads dotenv for the application. The migration command does not load dotenv itself. No application startup migration runner was found.
- Route queries, rather than inferred schemas, establish the current application dependencies: `src/routes/generate.ts:43` inserts maps and successful usage; `src/routes/iterate.ts:76` locks maps and allocates versions; `src/routes/diff.ts:34` compares snapshots; `src/services/rateLimit.ts` counts all usage rows by anonymous ID/date. Artifact/review queries are inventoried below.

## 2. Verified configured-database findings and limits

Read-only inspection used the existing local dotenv connection configuration, without printing its URL, host, credentials, or cookies. The sandbox initially blocked connection with `EACCES`; the approved inspection outside the sandbox succeeded. One subsequent inspection connection failed without returning findings; a bounded retry succeeded.

Catalog snapshot: **2026-11-06 05:23:39 UTC**. Aggregate/migration-record snapshot: **05:27:29 UTC**. Each successful inspection used `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, session-default read-only mode, statement/lock timeouts, and `ROLLBACK`. Evidence came from `pg_class`, `pg_attribute`/`pg_attrdef`, `pg_constraint`, `pg_index`, `pg_trigger`, `pg_extension`, `pg_policies`, and privilege predicates. No DDL, DML, migration, endpoint call, or AI call was executed.

Verified:

- PostgreSQL server version number `170006` (17.6); current schema `public`; effective nonimplicit search path `public, extensions`.
- `public` has exactly the **13 ordinary application tables** below, not replacement views. There is no `map_change_proposals` table or `maps.current_revision` column.
- Application tables have **78 columns, 36 primary/unique/foreign-key constraints, and 28 indexes**. All inspected constraints are validated and nondeferrable; every inspected index is valid and ready. No application CHECK constraints were found.
- All 13 application tables have RLS disabled; no public RLS policies or noninternal application triggers were found. There is no database trigger enforcing immutable history or automatically updating timestamps. The inspected connection can UPDATE/DELETE `map_versions`; schema does not make snapshots immutable against that connection.
- `gen_random_uuid()` resolves. Installed extensions include `pgcrypto`, `uuid-ossp`, `plpgsql`, `pg_stat_statements`, and `supabase_vault`. Their presence is not a requirement to reproduce every provider subsystem; the application baseline should include only verified application dependencies.
- Migration-record tables exist at `auth.schema_migrations` (82 rows), `realtime.schema_migrations` (89), and `storage.migrations` (74). Only counts were returned. These provider-namespaced records do **not** establish execution history for Mappr's SQL files. No Mappr/public migration ledger was observed; how application DDL was originally applied remains unverified.

This verifies one **configured database**, not every deployment or whether this connection is the intended production target. Environment identity, other branches/databases, backups, operational ownership, and migration privileges for a future deployment role need operations confirmation. No row payloads, descriptions, map IDs, or anonymous IDs were retrieved. The history profile below evaluated JSONB equality inside the database and returned counts only, specifically to assess backfill safety.

## 3. Table-by-table inventory and discrepancies

All listed tables are in `public`. Common observed conventions: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`; timestamps are non-null `timestamptz DEFAULT now()`. Every column is non-null **except** `generations.map_id`, `map_versions.patch`, and `deployments.migrations`. Other columns have no defaults. All artifact/review `map_id` foreign keys reference `maps(id) ON DELETE CASCADE`.

| Table | Verified columns beyond common ID/timestamps | Verified keys / delete behavior | Repository definition and consumer |
| --- | --- | --- | --- |
| `maps` | `anon_id uuid`, `input_description text`, `data jsonb`; both `created_at`, `updated_at` | PK only; `anon_id` has no FK to an account/session table | **DDL missing**. `src/routes/maps.ts`, `generate.ts`, `iterate.ts`; every artifact route reads canonical data here. |
| `generations` | `anon_id uuid`, nullable `map_id uuid`; `created_at` only | PK; map FK **ON DELETE SET NULL**, preserving usage rows; no owner FK | **DDL missing**. AI POST routes and `src/services/rateLimit.ts`. No reservation state, kind, or proposal reference. |
| `map_versions` | `map_id uuid`, `version integer`, `data jsonb`, nullable `patch jsonb`, `summary text`; `created_at` only | `UNIQUE(map_id,version)`; map FK CASCADE; no positive-version CHECK | **DDL missing**. `src/routes/iterate.ts`, `diff.ts`; current-version artifact helpers. |
| `architecture_reviews` | `map_id uuid`, `findings jsonb`; both timestamps | `UNIQUE(map_id)` | `src/db/migrations/002_architecture_reviews.sql`; `src/routes/critique.ts`. Observed structure matches tracked definition. |
| `missing_requirement_reviews` | `map_id uuid`, `findings jsonb`; both timestamps | `UNIQUE(map_id)` | **DDL missing**. `src/routes/requirements.ts`. |
| `traceability_reviews` | `map_id uuid`, `links jsonb`; both timestamps | `UNIQUE(map_id)` | **DDL missing**. `src/routes/traceability.ts`. |
| `api_contracts` | `map_id uuid`, `version integer`, `endpoints jsonb`; both timestamps | `UNIQUE(map_id,version)` | **DDL missing**. `src/routes/apiContract.ts`; README existence checks. |
| `relational_schemas` | `map_id uuid`, `version integer`, `tables jsonb`; both timestamps | `UNIQUE(map_id,version)` | `src/db/migrations/007_relational_schemas.sql`; `src/routes/relationalSchema.ts`. Matches tracked definition. |
| `document_schemas` | `map_id uuid`, `version integer`, `collections jsonb`; both timestamps | `UNIQUE(map_id,version)` | `src/db/migrations/008_document_schemas.sql`; `src/routes/documentSchema.ts`. Matches tracked definition. |
| `adrs` | `map_id uuid`, `tech_arch_hash text`, `adrs jsonb`; both timestamps | `UNIQUE(map_id,tech_arch_hash)` | `src/db/migrations/009_adrs.sql`; `src/routes/adr.ts`. Matches tracked definition. |
| `readmes` | `map_id uuid`, `version integer`, `overview text`, `getting_started jsonb`; both timestamps | `UNIQUE(map_id,version)` | `src/db/migrations/010_readmes.sql`; `src/routes/readme.ts`. Matches tracked definition. |
| `env_vars` | `map_id uuid`, `tech_arch_hash text`, `vars jsonb`; both timestamps | `UNIQUE(map_id,tech_arch_hash)` | `src/db/migrations/011_env_vars.sql`; `src/routes/envVars.ts`. Matches tracked definition. |
| `deployments` | `map_id uuid`, `tech_arch_hash text`, `components/environments/cicd_steps jsonb`, nullable `migrations text`; both timestamps | `UNIQUE(map_id,tech_arch_hash)` | `src/db/migrations/012_deployments.sql`; `src/routes/deployment.ts`. Matches tracked definition. |

The seven matching definitions agree on columns, types, defaults, nullability, PKs, unique keys, and FK delete actions; this does not prove those exact files originally ran. Preserve all existing records and object names.

Indexes beyond PK/unique-key indexes are also part of the observed baseline:

| Index | Definition / existing use |
| --- | --- |
| `idx_maps_anon_id` | btree `maps(anon_id)` |
| `idx_generations_anon_id_created_at` | btree `generations(anon_id,created_at)`; anonymous daily usage |
| `idx_generations_created_at` | btree `generations(created_at)`; global daily usage |
| `map_versions_map_id_version_idx` | btree `map_versions(map_id,version DESC)`; history/current-version lookups |

Do not drop the descending history index as a cleanup during S1, even if later performance analysis finds overlap with the unique index. No additional artifact-to-`map_versions` FK exists: version 1 artifacts can legitimately predate any history row. `maps.anon_id` being a non-null UUID establishes storage shape, not verified human ownership or a relationship to provider authentication.

Current artifact persistence remains unchanged: version-keyed API/database/README artifacts, hash-keyed ADR/environment/deployment artifacts, and one overwritten review/trace record per map. Their tables have no verified source fingerprint/generator-policy provenance. `src/routes/readme.ts:57` also reads artifact existence; `src/routes/deployment.ts` reads environment variables for rendering. The `techArchHash` implementation is in `src/services/adr.ts:51`. These dependencies must survive baseline reconstruction; new freshness behavior is S5 work.

## 4. Migration runner and reproducibility

The current `npm run migrate` is **not a reproducible bootstrap or upgrade mechanism**:

1. Its sole SQL file is absent, and it never enumerates the seven present files.
2. `psql` and `pg_dump` were not found on this environment's PATH. Neither command nor `npm run migrate` was executed.
3. The script assumes `$DATABASE_URL` expansion and environment provisioning. It does not load `.env` or establish a portable Windows script shell; application dotenv loading does not fix an independent `psql` process.
4. It specifies neither `ON_ERROR_STOP` nor transaction/error-recording behavior. There is no tracked Mappr ledger, ordering/checksum policy, deployment lock, or explicit adoption path for an already populated database.
5. `IF NOT EXISTS` can skip an incompatible existing table; it does not compare nullability, types, FKs, indexes, or constraint definitions. Blindly replaying files cannot verify or repair drift.

A fresh disposable database cannot be reconstructed using the committed migration command/files alone. Conversely, the observed populated database should **not** be bootstrapped as if empty. Baseline adoption and empty-database creation must be separate, explicit operations.

## 5. Safe additive migration and backfill strategy

### A. Reproducible baseline repair: S1 follow-up only

1. Review this inventory and confirm the configured target/environment. Create a consolidated application-only baseline from these verified definitions, keeping all seven existing migration files intact as historical references. Include the six undocumented tables and four additional indexes; preserve nullable usage map references and their SET NULL behavior. Do not copy provider `auth`, `storage`, `realtime`, vault, or role secrets into the application baseline.
2. Test creation only in a positively identified empty disposable database, using the same PostgreSQL major version and a verified `gen_random_uuid()` dependency. Fail on unexpected existing application objects; do not hide drift behind `IF NOT EXISTS`.
3. In a separate reviewed change, add a portable runner using installed `pg`/dotenv, explicit target/mode selection, checksum comparison, transaction/error handling, and one short migration lock. Default inspection/status must be read-only. Never automatically run migrations on application startup.
4. For this existing database, compare the entire application schema to the approved baseline first. Only after review/backup/operations approval may a new `public.mappr_schema_migrations` ledger record an **adopted** baseline. Do not replay table creation, replace tables, rewrite records, or falsely mark historical files as executed. Provider ledgers remain untouched.
5. For a fresh database, record the consolidated baseline as **executed**, then apply only future ordered migrations. For an adopted database, start at the same future boundary. Explicitly document that the consolidated baseline covers the legacy `002`/`007`-`012` structures and the recovered undocumented structures; do not subsequently rerun those legacy files as new migrations. Unexpected drift is a blocker, not an invitation to reconcile automatically.

The application ledger is a proposed new object, not present or created today. Its minimal metadata can be migration identifier, checksum, recorded time, and execution/adoption kind. Environment-specific grants and operational adoption approval require separate review; this report is not a schema dump or a restorable backup.

### B. Revision-related schema and coordinated backfill: S3

Observed aggregate classification, not a payload/ownership validation:

| Check | Verified count |
| --- | ---: |
| Maps | 38 |
| Maps without history | 35 |
| Maps with history | 3 |
| Current data equals latest snapshot (JSONB equality) | 3 |
| Current data differs from latest snapshot | 0 |
| Histories missing version 1 | 0 |
| Histories with nonpositive versions or gaps | 0 |

These counts are point-in-time findings, not migration eligibility guarantees. New writes can change them. Full `MapprSystem` validity, creator-session ownership, and artifact semantic consistency were not checked by retrieving private records.

S3 sequence:

- Add nullable `maps.current_revision integer` as an expansion, without a blanket default of 1. Plan its positive constraint and final NOT NULL enforcement only after validated backfill. Keep `map_versions.version` as the one revision sequence; its unique key already exists.
- Coordinate all canonical writers before relying on the column. Existing generation omits history, and existing iteration increments `MAX(version)` without maintaining a current-revision column. Merely adding/backfilling a column while these writers continue unchanged would immediately allow drift. Deploy the shared revision-aware writer or use an approved write-maintenance window; no route changes belong to S1.
- In bounded, restartable per-map transactions, acquire the map row lock, then re-read canonical data and version rows. If no history exists and structural/ownership prerequisites pass, insert a truthful initial snapshot and set revision 1 together. If valid history exists and the latest snapshot equals current data, set the current revision to that existing maximum without changing its snapshots.
- If data differs, history is invalid/gapped, or identity/shape cannot be trusted, leave the map ineligible for universal editing and record a restricted reconciliation status. **Never set a mismatched map to the newest history number, replace its data to force equality, fabricate missing old versions, or alter old snapshots.** Operations/owner review may later approve preserving current data as a new, explicitly labeled reconciliation revision, or a reviewed restore-as-new-revision. Neither is automatic backfill.
- Recheck zero unresolved eligible maps and equality under the coordinated writer, then validate positive/NOT NULL constraints as an explicit later step. Do not add artifact-version foreign keys until implicit version-1 relationships are reconciled and the need is reviewed.
- Preserve append-only history in the writer. Any later database permission/trigger enforcement must account for the existing intentional `ON DELETE CASCADE` on map deletion. Do not revoke permissions, add auth-user FKs, or invent an owner reassignment during S1.

### C. Later proposal, quota, and provenance work: S4/S5

- S4 depends on S3 and approved credit/expiry policy. Add `map_change_proposals`, map/base-revision references, actor/request binding, unique preview keys, immutable candidate/operations/diff metadata, lifecycle timestamps, and durable apply receipts. Associate at most one history commit with a proposal. New history metadata must be nullable for existing rows. No proposal table needs creating to finish S1.
- Usage reservations require coordinated application changes: today's `rateLimit.ts` counts **every** generation row. Adding failed/reserved rows without updating that shared accounting would change quotas. Plan state/kind/lease/proposal metadata with legacy rows interpreted as successful, but do not manufacture charges, reinterpret old usage, or backfill speculative approval outcomes. Credit decisions remain product-owned.
- S5 can first add nullable source revision/fingerprint/generator-policy metadata to artifact tables and treat old unproven output as stale. Do not label old reviews current or assign their generation to the latest map revision without evidence. Preserve existing payloads, version/hash keys, and inspectability. Narrow input dependencies/reuse can follow the conservative pilot.

Rollback/restore prerequisites for all write milestones: confirm a tested backup/PITR or restore process and ownership of it; rehearse on a disposable clone; record pre-change schema/checksums; use short lock/statement limits and transactions where supported. Prefer additive schema left in place when rolling back application code. Never drop populated history/proposal/provenance tables to simulate rollback. Restoring a backup can discard later writes and requires an explicit operations decision; it is not an automatic down migration. No backup or restore capability was tested here.

## 6. Smallest recommended next code-edit milestone

**A1: reconstruct and test the existing schema offline, with no live adoption or application changes.** Proposed precise files, none created in this task:

| Proposed file | Bounded purpose |
| --- | --- |
| `src/db/baseline/001_existing_schema.sql` | Reviewed application-only consolidated baseline of the 13 observed tables, constraints, defaults, and 28 indexes (including indexes supplied by keys). Only for an explicitly empty disposable target; no S3/S4/S5 columns. |
| `src/db/baseline/README.md` | Evidence date, expected PostgreSQL version/dependencies, schema comparison rules, legacy-file coverage, target safeguards, and separate empty-bootstrap versus existing-adoption procedures. |
| `tests/db/schema-baseline.test.cjs` | Node built-in test harness using installed `pg`; refuse missing/unverified disposable-target configuration, exercise baseline creation only there, and compare catalogs to the approved inventory. No implicit connection fallback to the application's `DATABASE_URL`, live reset, or automatic database deletion. |

Keep `package.json`, `src/db/pool.ts`, `src/db/migrations/002*` and `007*`-`012*`, application routes/services, authentication, and AI logic unchanged in A1. Do not restore a guessed `001_init.sql` just to make the old command run.

**A2, separately reviewed after A1:** propose `scripts/db-migrate.cjs`, a documented `public.mappr_schema_migrations` definition under `src/db/baseline/`, updates to `src/db/baseline/README.md`, runner tests, and the `package.json` migration entry. The runner must explicitly distinguish read-only status/check, empty bootstrap, existing-baseline adoption, and future migration application. No existing-database ledger insertion is authorized by this report. Only after A2 validation and operations approval should any target database change be scheduled.

## 7. Tests and acceptance gates before applying migrations

No migration/bootstrap tests or application tests were run during this read-only task. Required future gates:

1. **Scope/target:** approved A1/A2 diff, migration checksum manifest, environment confirmation, positively isolated disposable test configuration, and explicit operations approval for any real target. Missing credentials/target labels must fail closed, not fall back to the working application database.
2. **Fresh reproducibility:** build all 13 tables from the consolidated baseline on disposable PostgreSQL; compare types, defaults, nullability, PK/unique/FK definitions, delete actions, index validity, and extension/function requirements. Confirm no provider schemas are created or changed.
3. **Drift/adoption:** exact-match existing clone is eligible for explicit adoption without record changes; missing columns, incompatible nullability/FKs, modified checksums, or unexpected objects stop the runner. Never accept a table solely because its name exists. Record adoption as adoption, not historical execution.
4. **Failure/retry:** injected SQL failure yields no successful ledger entry or half-applied transactional migration; two runners cannot apply concurrently; rerunning an already recorded unchanged migration does not execute it again. Show lock timeouts and partial-failure recovery rather than retrying unsafe DDL blindly.
5. **Record preservation:** synthetic/approved-sanitized fixtures retain map IDs, anonymous IDs, timestamps, data, snapshots, artifact keys, and successful-usage counts. Confirm map deletion cascades artifacts/history while usage `map_id` becomes NULL and usage rows remain. Verify unique constraints support every current `ON CONFLICT` clause.
6. **Later S3 gate:** fixtures cover unversioned, matching, mismatched, gapped, invalid-shape, and ownership-unverified maps. Backfill resumes safely, changes no existing snapshot, quarantines problems, and preserves consistency under concurrent generation/iteration. JSONB equality is required, not text serialization/key ordering or timestamps alone.
7. **Operational recovery:** known restore owner, backup/PITR evidence, rollback compatibility rehearsal, maintenance/lock budget, post-migration catalog comparison, and agreed endpoint smoke tests. No real AI calls are needed for schema tests. Do not test destructive restore procedures on the configured working database.

## 8. Blockers, unknowns, and decisions for review

**Before any implementation/adoption:** approve the consolidated-baseline approach and future migration boundary; confirm the configured database's environment and whether other deployments differ; establish operations ownership, backup/restore evidence, isolated test access, and migration-role privilege policy. Missing historical SQL/execution records are not recoverable merely from matching catalogs. A complete historical schema dump, grants/default privileges, ancillary functions, and changes outside this configured application schema have not been independently reconstructed.

**Before S3:** re-run aggregate classification at cutover; confirm structural-validation and per-map reconciliation procedures, writer-coordination strategy, and ownership eligibility. Zero observed mismatches today does not remove the required mismatch path. The 35 unversioned maps need truthful baseline snapshots before a fully populated revision invariant; no write backfill happened here.

**Before S4/S5:** product must approve credits/refunds/abandonment/retries, expiry defaults, and anonymous/shared-link recovery/read permissions. The S1 brief confirms `product.summary`; view identifiers, cache synchronization, and any README prompt dependency still need their appropriate later reviews. These unresolved feature decisions do not block documenting/testing the current schema, and they do not authorize auth, API, or frontend implementation in S1.

**Review outcome requested:** accept or revise the verified baseline and A1 scope before code edits. No application code, migration file, existing document, or database record was changed. Stop here for review.
