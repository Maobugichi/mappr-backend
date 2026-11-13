# Mappr S4D PostgreSQL integration verification

2026-11-11. **PASS for isolated PostgreSQL 17 integration. Production release
remains blocked.** No Supabase connection, application-database migration,
billable AI call, deployment, frontend change or S4 activation occurred.

## Isolation and preservation

Inspected Git status/diffs/index, repository instructions, S4D handoff and the
retained local recovery setup before execution. No applicable AGENTS.md was
found. All existing S4A/S4C/S4D/S5A implementation was retained.

Reused the existing private PostgreSQL **17.11** cluster, initially stopped, on
**127.0.0.1:54130**. Before local DDL, independently matched actual server
address/port, data directory, major version and cluster system identifier to
the retained private isolation evidence. No application connection URL or pg
environment fallback was used. The application URL was parsed privately only
to exclude its database name; it was never connected.

Created fresh, uniquely named `mappr_s4d_synthetic_*` databases from `template0`,
with no public relations, an explicit synthetic-purpose marker and separate
non-login test roles. Neither existing recovery database was selected as a
test target. No backup was restored, recreated or modified. Existing restored
records and private review/configuration inputs were not used as test fixtures.

Initial provisioning returned an unclassified client error after CREATE
DATABASE. A local catalog check confirmed one new database and its two intended
roles, no remaining setup session, correct ownership and an empty public schema.
Creation was **not blindly repeated**; only that verified new database was marked
and used. The precise initial client-error cause was not retained and is not
asserted as a PostgreSQL defect.

The first test run found fixture problems described below. The clean rerun used
a second fresh empty database; the first synthetic database was preserved. Final
catalog checks retained all **five pre-existing database identities/owners**.
Protected local target/restore-proof file hashes were unchanged. Original backup
and recovery files were never overwritten.

## Executed migrations and actual role model

In each fresh synthetic target, executed the reviewed consolidated baseline,
then `013_current_revision.sql` solely to prepare its revision schema. Added
synthetic pre-migration map/history/usage/README rows, then applied in order:

1. `014_change_proposals.sql`
2. `015_artifact_provenance.sql`
3. `016_daily_generation_admission.sql`

All executed successfully. Original synthetic canonical and usage row text was
equal before/after migration, apart from deliberately added nullable columns.
Historical usage retained NULL attempt identity. No historical attempt or
artifact provenance was invented.

Application SQL ran as a new **non-superuser, non-BYPASSRLS table-owning role**
using the local bootstrap connection's SET ROLE facility. A separate untrusted
role could not read proposals under default grants. Even after explicit table
SELECT/INSERT grants, RLS hid the three protected 015/016 tables and denied
insertion. Backend-owner access succeeded. This tests local SQL permissions;
it does not certify Supabase roles/default grants or production login setup.

## Verified behavior

New reusable suite: `tests/db/s4d-postgres-integration.test.mjs`.

It requires an explicit private configuration and confirmation, a loopback-only
PG17 target, the pinned cluster/data directory, a synthetic database name and
marker, and an **empty public schema** before any migration. It has no application
database fallback. Application pooling is replaced with this verified local pool;
the shared AI client returns allowlisted synthetic outputs. HTTP fixtures use
temporary loopback listeners. The production availability guard is never removed;
only the test-injected changes router bypasses it for lifecycle exercises.

| Check | Actual result |
| --- | --- |
| Baseline + 013 + ordered 014/015/016 DDL | PASS |
| CHECK/FK/unique enforcement | PASS: invalid state/lease, mismatched actor, missing attempt/base revision and duplicate usage were rejected by PostgreSQL. |
| All 13 AI entrypoints | PASS: generation, Architecture, ten artifacts and Overview preview used actual SQL reservations/publication with mocked AI. |
| Artifact current reads and all six backend exports | PASS after actual generation/provenance attachment. |
| Concurrent mixed-operation actor/global last-unit admission | PASS: one provider admitted; competing request received 429/503; existing successful usage counted. |
| Same-key preview concurrency/replay | PASS: in-progress observation, immutable replay and changed-body conflict, without another provider/usage unit. |
| Apply and receipt replay | PASS: one revision/snapshot, no additional usage; exact oversized JSONB extension value retained by summary-only Apply. |
| Preview versus Architecture revision | PASS: real shared map-lock/revision discipline; stale preview failed and only Architecture consumed a unit. |
| Actual SQL error during usage insertion | PASS: attempted success/ready changes rolled back together; durable expiry recovery was idempotent. |
| Lost admission/ready/Apply acknowledgement | PASS: error injected after actual COMMIT; real durable proposal/usage/receipt determined outcome without regeneration or duplicate units. |
| Artifact archival and stale inspection/export | PASS: previous output archived; summary Apply made README stale; owner inspection remained possible and current-only export refused it. |
| Concurrent artifact publication and SQL rollback | PASS: one winning publication/unit; losing hold failed; server-side provenance error rolled back projection, provenance and usage. |
| Expired hold versus late publisher | PASS: recovery failed the attempt; late mutation/usage rolled back. |
| Day rollover/timezone/DST | PASS: captured-day fixture settled without consuming today's capacity; mismatched timezone refused admission; PostgreSQL computed a 23-hour DST day. |
| Failed-attempt throttle | PASS: third attempt refused before mocked provider after two configured failed attempts; zero successful units. |
| Synthetic map deletion/retention | PASS: applied history/proposal cascaded; usage and successful attempt survived with nullable associations. |
| Production release interlock | PASS: still throws `preview_policy_not_configured` with both test flags true. |

The rollover case moves **synthetic stored timestamps**, not the machine clock.
Acknowledgement loss is deliberately simulated after a real successful COMMIT;
it is not a physical network-partition test. No real provider cancellation,
provider billing or browser/frontend behavior was tested.

## Confirmed defects and fixes

**No application or migration integration defect was confirmed. No application
source or migration was changed.** Changes are the new integration suite and
this report only.

The first run exposed test-fixture defects: a deliberately oversized integer
caused the existing Architecture round-trip safety guard to refuse iteration;
an expected SQLSTATE was wrong because CHECK enforcement preceded FK checking;
and that assertion path failed to roll back its test transaction. Routine
fixtures now use representable numbers, the oversized-value check remains on
Overview's SQL-preserving Apply, rollback runs in finally, and deferred mocked
AI is released before asserting the competing writer's result. These changes
preserve the existing backend safety guards. The failed run is not reported as
a product failure or counted as successful verification.

## Actual commands and final results

Opted-in integration command, using a fresh verified private synthetic target:

```text
MAPPR_S4D_PG_TEST_CONFIG=<private synthetic-only configuration path>
MAPPR_S4D_PG_TEST_DISPOSABLE=I_ACCEPT_SYNTHETIC_LOCAL_DATABASE_ONLY
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/db/s4d-postgres-integration.test.mjs
```

**17 tests passed, 0 failed, 0 skipped** (16 integration subtests plus parent).

Final TypeScript no-emit and `npm.cmd run build` both exited 0. The existing full
S2/S3/S4/S5 regression command from the S4D handoff, with the new integration
file included and both sets of PostgreSQL opt-ins cleared, exited 0:
**362 tests: 360 passed, 0 failed, 2 skipped**. The skips are the separate optional
baseline integration test and this opt-in suite in the offline run; they do not
negate the separately completed real integration run. Experimental module-mock
warnings and static expected failure logs remain.

Final independent READ ONLY / REPEATABLE READ checks in the successful target:

| Synthetic-target inventory/invariant | Actual result |
| --- | --- |
| Public tables / constraints / foreign keys | **17 / 94 / 32** |
| Indexes / invalid or unready indexes | **43 / 0** |
| Unvalidated constraints | **0** |
| Maps / history snapshots / artifact snapshots | **30 / 35 / 13** |
| Successful usage / succeeded attempts / failed attempts | **26 / 24 / 11** |
| Reserved attempts / accounting mismatches | **0 / 0** |
| Noncontiguous or latest-snapshot-mismatching maps | **0** |
| Captured local quota timezone | **Africa/Lagos** |
| Other local client sessions before shutdown | **0** |

These counts describe synthetic fixtures, **not the live Mappr database**.
The two historical NULL-attempt usage rows explain usage exceeding succeeded
attempts. All successful attempts had exactly one corresponding usage row.

Returned the owned local cluster to its original **stopped** state: pg_ctl stop
exit 0, status exit 3, no postmaster PID file. Both synthetic targets and private
setup/catalog/final-integrity evidence were retained outside Git for review.
Configurations contain local credentials and must remain private. Current
reproduction needs another freshly provisioned empty target; the suite rejects
rerunning migrations over either populated test database.

## Remaining release blockers

- Review this evidence and the source/migrations before a separately authorized
  live schema/source rollout. None of 014/015/016 was executed against Supabase.
- Verify actual provider-side backend ownership/RLS/grants, inherited privileges
  and effective timezone. Local Africa/Lagos does not establish Supabase's
  timezone. Confirm captured-day rollover and provisional attempt-cap rollout
  values; this requires no payments or paid-credit implementation.
- Coordinate all budget-sharing backend writers and durable-mode configuration;
  mixed legacy/durable writers do not provide strict shared quotas. Retain the
  existing default-off mode and unconditional S4 release interlock until an
  explicitly approved activation task.
- Complete cross-repository browser verification of cookies, cache/revision
  ordering, preview approval/expiry and S5 frontend export protection. Supplied
  frontend implementation status is not a browser verification performed here.

All 147 pre-existing project files, local `.env`, Git HEAD and index were
preserved. No commit/push, production database request, deployment, activation,
payment work or frontend edit occurred. **STOP for review.**
