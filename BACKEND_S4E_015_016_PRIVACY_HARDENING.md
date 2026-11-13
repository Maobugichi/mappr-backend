# Mappr S4E-Q — migrations 015/016 private-table grant hardening

2026-11-12. **PASS: source hardening and isolated PostgreSQL 17 verification.**
Ready for source review and subsequent focused S4E preflight; **not approval
to execute live migrations**. No Supabase connection, live SQL, backup/restore,
deployment, Render operation, provider call or feature activation occurred.

## Scope and exact changes

Read the S4E-Q brief, current S4E execution report, 014 hardening report and S4D
integration handoff. Inspected Git status/diffs/index, repository/ancestor
instructions, migrations 014/015/016, backend role assumptions and existing
tests before editing. No applicable AGENTS.md or CLAUDE.md was found. Preserved
all earlier uncommitted S4/S5 work and historical reports.

| File | Change |
| --- | --- |
| `src/db/migrations/015_artifact_provenance.sql` | Explicit client revocation and effective-permission guard for `artifact_generations`. |
| `src/db/migrations/016_daily_generation_admission.sql` | Equivalent protection for both `daily_admission_policy` and `generation_attempts`. |
| `tests/db/s4d-postgres-integration.test.mjs` | Extend existing guarded PG17 suite for all-privilege defaults, absent roles, per-table inherited-grant rollback and actual denied client TRUNCATE/CRUD. |
| `tests/artifacts/artifact-safety.test.mjs` | Extend existing static 015 migration assertions. |
| `tests/changes/daily-admission.test.mjs` | Extend existing static 016 migration assertions. |
| `BACKEND_S4E_015_016_PRIVACY_HARDENING.md` | This report. |

**Migration 014 is byte-for-byte unchanged.** No application services, routes,
API contracts, existing-table permission rules, dependencies, billing policy,
frontend code or production interlocks were changed.

## Protection and backend access

Both migrations retain their original BEGIN/COMMIT, timeouts, DDL order and
existing RLS/PUBLIC revocations. Inside those same transactions they now:

1. Look up `anon` and `authenticated` conditionally in `pg_catalog.pg_roles`;
   installations without those roles remain supported.
2. `REVOKE ALL` direct table privileges from each existing ordinary-client role
   on the new private tables only. Existing PUBLIC revocations remain.
3. Use `pg_catalog.has_table_privilege` to check effective **SELECT, INSERT,
   UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN**. PostgreSQL 17's
   MAINTAIN privilege is included, rather than checking only row CRUD.
4. Raise **SQLSTATE 42501** with an artifact/admission privacy error if any
   checked privilege survives through inheritance. The whole migration must
   roll back; no role membership or default-grant rewrite is attempted.

RLS alone does not restrict TRUNCATE or REFERENCES. A private table with no row
policies could still be truncated if default table grants survived. Explicit
revocation closes that path; effective checks reject unexpected indirect grants.

RLS remains enabled with **zero policies and no FORCE RLS**. The table-owning
backend keeps its owner access. A non-owner service needs both reviewed SQL
grants and a reviewed RLS-bypass path; a familiar role name or BYPASSRLS alone
does not confer SQL privileges. Actual hosted role membership/bypass behavior
still belongs to the subsequent live read-only preflight.

No project-wide defaults, existing table ACLs, auth settings or unrelated roles
are changed by either migration. 015's ten artifact links, generation snapshots,
composite FKs and retention model are preserved. 016's policy timezone capture,
attempt/usage constraints and historical NULL attempt IDs are preserved. Neither
migration backfills canonical data, artifacts or usage.

## Fresh isolated PostgreSQL verification

Used the existing verified **PostgreSQL 17.11 binaries** to initialize a
**separate local test cluster**, bound only to **127.0.0.1:54131**, in a new
restricted private Temp directory. The retained recovery cluster on 54130
remained stopped and was not used for SQL. No backup was restored or created.

The separate cluster was necessary to exercise the exact role-absence branch
without removing `anon`/`authenticated` roles used by retained test databases.
It uses the existing opted-in suite, not a new test platform. A fresh cluster
system identifier was pinned from local control data and independently matched
to actual SQL identity, loopback endpoint, port, PG17 version and data directory.
A new marked `mappr_s4d_synthetic_*` database was created from template0 and
verified to have **zero public relations** before setup. All three initial
vanilla database identities/owners were retained.

Existing suite guards require explicit private configuration, disposable
confirmation, loopback/non-5432 endpoint, system/data-directory pin, synthetic
name/marker and an empty schema. The application database name is excluded by
parsing configuration only; no application connection fallback exists. Providers
are mocked; HTTP fixtures bind to loopback. Only synthetic data was used.

Application DDL and SQL ran as a new **non-superuser, non-BYPASSRLS table owner**.
The separate local bootstrap administrator provisioned roles and selected client
roles for negative tests. Ordinary roles are NOLOGIN/non-superuser/non-BYPASSRLS.

### Actual SQL results

| Case | Verified result |
| --- | --- |
| Vanilla PG17 role-absence path | Both Supabase roles initially absent; exact 014/015/016 DDL bodies succeeded in order inside a transaction, then rolled back. |
| Supabase-like defaults | Database-scoped `GRANT ALL PRIVILEGES` defaults to PUBLIC, anon and authenticated, including TRUNCATE/REFERENCES/TRIGGER/MAINTAIN. |
| Ordered successful execution | Baseline + 013 prepared synthetic schema; unchanged 014, corrected 015 and corrected 016 committed in order. |
| Final protection on all four private tables | RLS **true**, FORCE **false**, policies **0**, PUBLIC table ACL entries **none**. |
| Effective ordinary-client rights | Both roles have **none of the eight checked privileges** on all four private tables. |
| Actual client operations on 015/016 tables | SELECT/INSERT/UPDATE/DELETE and **TRUNCATE ... CASCADE** each failed with **42501** for both roles. Six new-table TRUNCATE attempts were denied by privileges, not row filtering or FK RESTRICT. |
| Existing 014 privacy | Unchanged source remained protected; client TRUNCATE was also denied and existing explicit-regrant RLS tests passed. |
| Inherited dangerous privileges | **12 negative cases**: each of three 015/016 tables × TRUNCATE/MAINTAIN × two roles. Actual guards raised the expected privacy 42501 and all trials rolled back. |
| Rollback completeness | No newly published private table after failures; 015 generation-link columns / 016 attempt link remained absent. 016 policy row and transactional DDL were rolled back. |
| Atomic visibility | Separate connection could not see new 014, 015 or 016 private tables before their successful migration COMMIT. |
| Backend positive access | Owner has all eight privileges and completes real preview/apply/replay, artifact publication, tracked reads, six exports and durable accounting. |
| Defense in depth | Separate untrusted role retaining CRUD grants saw zero rows in populated proposals/artifact generations/attempts/policy through no-policy RLS. |
| Existing S4/S5 behavior | All thirteen AI entrypoints with mocked providers; mixed-operation admission races; source/publication conflicts; stale inspection/export refusal; atomic usage; recovery/replay; retention; timezone/DST checks passed. |

The inherited-grant trials inject only an adversarial grant through another
test role before each actual guard; migration DDL/checks are otherwise unchanged.
They target each table independently, so failure on the policy table cannot
mask a missing attempts-table check. Membership/default fixture changes occur
inside the negative transaction and are rolled back. Existing 014 inherited
TRUNCATE protection also remained passing.

Independent final READ ONLY / REPEATABLE READ verification found **31 synthetic
maps / 37 snapshots**, zero reserved attempts, accounting mismatches, incoherent
maps, unvalidated constraints or invalid indexes. These are synthetic counts,
not current Supabase observations. No other client sessions remained.

The newly owned cluster was stopped: **stop exit 0, status exit 3, no postmaster
PID file**. New local synthetic data/configuration/evidence are retained privately
for review. Original recovery target/proof hashes are unchanged and its cluster
remains stopped. No original archive, evidence or database was overwritten.

## Commands and results

With explicit verified synthetic configuration and disposable confirmation:

```text
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/db/s4d-postgres-integration.test.mjs
```

**20 passed, 0 failed, 0 skipped** (19 subtests plus parent). The populated target
must not be reused for destructive setup; the suite's empty-target guard refuses it.

Focused offline run:

```text
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/artifacts/artifact-safety.test.mjs tests/changes/daily-admission.test.mjs
```

**66 passed, 0 failed**. Its first sandbox attempt failed before loading tests:
the tsx loader's Windows user-information lookup returned
`uv_os_get_passwd ENOMEM`. Approved execution outside the sandbox passed without
any source workaround. The successful PostgreSQL and full offline test runs
also used that execution context. Experimental mock warnings and expected
failure-path generation logs are not failed assertions.

Final offline regression, with both database integration opt-ins cleared:

```text
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs tests/artifacts/artifact-safety.test.mjs tests/changes/provider-admission.test.mjs tests/changes/daily-admission.test.mjs tests/db/s4d-postgres-integration.test.mjs
```

**362 tests: 360 passed, 0 failed, 2 skipped.** The old optional baseline PG
suite and opted-in integration parent skipped in this offline process; actual
PG integration was separately enabled and passed above.

The following also completed successfully, exit 0:

```text
node --check tests/db/s4d-postgres-integration.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
git diff --check
```

Compared all **154 pre-existing project files**: only the five intended SQL/test
files above changed. Migration 014, baseline/013, runtime source, earlier reports,
`.env`, Git HEAD and the empty index were preserved. Ignored build output was
refreshed. No Git commit or push was made.

## Migration hashes and return to S4E

SHA-256 of exact working-tree bytes used for successful verification:

```text
014_change_proposals.sql — unchanged
3a35ce92c423f72fc69af8bd862e9b5e9df7cc38126605b1a856a4117af47064

015_artifact_provenance.sql — hardened
cbf0d75e98a6f167c66bad5d10b131db5dee871fb9b62544b1f358c9a0e81d03
Previous: 4a263b86683d05f8190bbed0facf4bf98416b4b8c4546afd0af11be0d90f167e

016_daily_generation_admission.sql — hardened
23f961952e7e73b5ec2bf822684b4c3c57a98711592549ec4cbe7f888e74e818
Previous: c498e50ffb15a6d5838fe26e4977991e245b8ef3034820ab05327c637c794747
```

Historical manifests/approvals pinned to the old 015/016 hashes are stale.
Recompute hashes from the actual reviewed release checkout, including any Git
line-ending normalization. No private live approval or production schema
allowlist was silently updated. Historical S4E execution findings remain intact.

The retained private S4E preflight currently treats 015/016's projected defaults
as surviving PUBLIC-only revocation. A subsequent focused check must recognize
the corrected per-role revocations on **each** private table and fail on residual
effective privileges, including MAINTAIN, rather than accepting raw ACL presence
or relying solely on RLS. Retain role membership/SET/bypass, target, schema,
transaction, data-integrity and containment checks. Do not broaden a production
allowlist to make it pass; derive reviewed post-migration expectations from the
approved source.

**GO for source review; NO-GO for live execution until remaining gates pass:**

1. Resume focused **read-only S4E** target/schema/privacy/revision/preservation
   checks using reviewed hashes. Retain accepted writer attestations unless new
   contradictory evidence appears; recheck available local/activity evidence.
2. Establish actual hosted backend role, effective grants/bypass and session
   timezone equivalence with the pinned migration connection. Prior UTC
   observation does not certify Render's effective pool settings.
3. Create a **current pre-014 backup** under containment and independently prove
   its restoration into a new positively isolated empty PG17 target, comparing
   complete source rows and relevant schema. This source task did neither.
4. Review final source hashes, schema/permissions allowlist and recovery evidence;
   obtain **separate explicit live-migration authorization** before any 014→015→016
   execution. Keep writers stopped and S4/daily admission inactive.

No live permissions, configuration, records, billing or feature settings changed.
No Supabase SQL, backup/restore, deployment, Render resume, live AI calls or new
change scope occurred. **STOP for review.**
