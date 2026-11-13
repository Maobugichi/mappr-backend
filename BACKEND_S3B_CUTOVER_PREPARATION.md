# Mappr S3B cutover preparation

Date: 2026-11-07. **Preparation complete; NO-GO for live cutover until the remaining
operator prerequisites and separate execution approval are supplied.**
No database connection, migration, live backfill, flag change, deployment, or S4
work was performed in this preparation task.

## 1. Scope, completed work, and preservation

Inspected the current Git status/diffs and untracked work before continuing,
re-read the cutover brief and S3A/preflight/contract handoffs, and reviewed S1,
the existing backfill/planners, canonical writer, migration, and tests.
No applicable repository/ancestor `AGENTS.md` was found. The interrupted work
already contained the maintenance-planner separation and operator entry point;
those were preserved and completed, not restarted.

| File | Preparation change |
| --- | --- |
| `src/services/revisionState.ts` | Adds explicitly named stored-owner maintenance eligibility; shares existing system/history consistency validation while retaining the original externally reviewed-owner planner. |
| `src/db/backfillCurrentRevision.ts` | Adds stored-owner maintenance candidates, checks captured owner metadata again under lock, stops on missing/quarantined rows, and schema-qualifies SQL. Retains the prior reviewed-owner export. Rejects case-duplicate map IDs. |
| `src/db/s3bCutover.ts` | Target/configuration gates, strict observed-schema comparison, full-inventory dry run, and separate guarded migration/backfill orchestration. |
| `scripts/s3b-cutover.mjs` | Explicit CLI with private external configuration, no application URL fallback, count-only output and sanitized failures. |
| `tests/revisions/s3b-cutover.test.mjs` | Focused offline operator, maintenance, preservation, quarantine, and retry tests. |
| `BACKEND_S3B_CUTOVER_PREPARATION.md` | This handoff and conditional operator checklist. |

No route, S2/S2.1 middleware, canonical writer, migration SQL, baseline SQL,
package script/dependency, application environment, or existing audit/contract
document was edited by this task.

## 2. Ownership requirement reassessed

The new brief explicitly confirms that the configured database is exclusively
development/testing and authorizes preparation of a privileged maintenance
procedure. **Browser authorization and schema bookkeeping have different
evidence requirements.**

For bookkeeping, an operator can explicitly select all existing maps in the
verified development target and retain their non-null UUID owner metadata.
`planStoredOwnerRevisionBackfill` validates that metadata and the full current
and historical `MapprSystemSchema`, contiguous positive history, latest-snapshot
JSONB equality, and any existing counter. It does not require every creator to
visit their map. The captured stored owner must still match under each map lock.

This supersedes the preflight's requirement for 38 independent browser-owner
proofs **for maintenance only**. It does not prove who possesses those sessions,
repair lost cookies, establish historical human identity, assign owners, or
grant editing permission. Structurally invalid/conflicting maps remain stop
conditions, not forced initializations.

S2/S2.1 still require an established signed-cookie session matching
`maps.anon_id` for protected editing/eligibility. Shared-link reads remain
unchanged. The original `planRevisionBackfill` still rejects absent/different
externally reviewed owners; no request route uses the new maintenance planner.
Tests cover that separation and the existing owner/non-owner/session behavior.

## 3. Operator process and safeguards

The only CLI entry point is `scripts/s3b-cutover.mjs`. It never loads dotenv or
imports the application pool. Importing the CLI/engine does not connect or run a
migration. Startup/build/npm scripts do not invoke it.

- **status:** explicit READ ONLY, REPEATABLE READ inspection, ROLLBACK on exit;
  local statement/lock/idle-transaction timeouts of 10s/1s/30s. Validates all
  current/historical payloads privately and prints aggregate classifications.
- **migrate:** requires approved/pinned configuration and explicit confirmation;
  refuses an already existing revision column, any quarantined inventory, or
  unrecognized schema. Applies only the verified contents of migration 013.
  It does not automatically backfill or enable writers.
- **backfill:** requires the same write gates and the expected nullable integer
  column. Inspects the entire inventory before any write, then invokes bounded,
  per-map transactions in batches of at most 100 using one verified session.
  Rechecks owner metadata/system/history under lock. Stops on any missing,
  quarantined, or failed map; earlier committed maps remain restartable.
  Re-inspects schema, inventory membership/owners, and readiness afterward.

The supported schema is the observed S1 set of 13 tables, 78 original columns,
36 constraints, and 28 indexes, with only migration 013's precise optional column.
The A1 SQL is parsed as a schema reference, **never executed**. Unknown tables,
columns/defaults, invalid/missing constraints/indexes, RLS, or application triggers
fail closed. Required role ownership/write privileges are inspected, not exercised
by status. The selected connection must report PostgreSQL 17 and default READ
COMMITTED isolation.

Explicit configuration pins the observed database/role and an opaque SHA-256
fingerprint incorporating the configured endpoint and observed database identity.
Status can discover that fingerprint; an operator must independently compare the
private endpoint/database/role with the confirmed development configuration or
provider account before pinning it. A fingerprint copied from an unverified
connection is not independent target proof. Each write run rechecks it, retaining
one checked-out connection throughout the operation.

Current CLI credentials must be in a restricted JSON file **outside the
repository**; symlink-resolved in-repository paths are rejected. No application
`DATABASE_URL` or PostgreSQL credential fallback is used. The URL must explicitly
include credentials, endpoint and database, with no URL options overriding
connection/TLS settings. TLS verification is an explicit configuration choice;
the target fingerprint is an operational mismatch guard, not a replacement for
trusted connection configuration.

Write modes require all of:

1. A pinned target and `developmentOnly:true`, with explicit
   `scope:"all-existing-development-maps"`.
2. An approval object with `developerApproved:true`, `backupVerified:true`,
   `writersStopped:true`, and nonempty backup/writer-stop evidence references.
3. The exact command-line confirmation `AUTHORIZE_S3B_DEVELOPMENT_WRITE`.

Missing/malformed approval fails before connection acquisition. **No approved
configuration was created and no write command was run.** Approval fields are
operator attestations: the tool cannot independently prove a backup is restorable,
all external writers are stopped, or that a human granted approval. They must be
set only after the separate developer review; this task is not that approval.

Outputs contain counts/reason codes and the opaque target fingerprint, not map
IDs, anonymous IDs, payloads, credentials, hostnames, or raw database errors.
Private row data exists only in memory for schema validation and backfill.
The tool never changes `anon_id`, canonical data, existing snapshots, original
timestamps, artifacts, or usage. Only counters and truthful missing initial
snapshots are written in a later authorized run.

## 4. Exact supported commands and private configuration

From the repository root, with a real private absolute path substituted:

```powershell
node --import tsx scripts/s3b-cutover.mjs --mode status --config "C:\Private\mappr-s3b.json"
```

The path above is illustrative, not an existing configured file. Its JSON shape
is below; replace placeholders privately and omit `approval` for preparation.
This example is deliberately unapproved.

```json
{
  "connectionString": "<complete explicitly verified PostgreSQL URL>",
  "sslRejectUnauthorized": true,
  "expectedDatabase": "<verified database name>",
  "expectedRole": "<verified effective role>",
  "developmentOnly": true,
  "scope": "all-existing-development-maps"
}
```

Review status, independently verify the target, then add
`expectedTargetFingerprint` with its 64-character digest. Exit 0 means the
structural/maintenance inventory has no quarantine; it does **not** authorize
execution. `columnPresent` and `revisionReady` distinguish pre-migration,
partially backfilled, and structurally ready states.

**Only after separate execution approval**, the same private config additionally
needs the approval object described above. The later write commands are:

```powershell
node --import tsx scripts/s3b-cutover.mjs --mode migrate --config "C:\Private\mappr-s3b.json" --confirm AUTHORIZE_S3B_DEVELOPMENT_WRITE
node --import tsx scripts/s3b-cutover.mjs --mode backfill --config "C:\Private\mappr-s3b.json" --confirm AUTHORIZE_S3B_DEVELOPMENT_WRITE
node --import tsx scripts/s3b-cutover.mjs --mode status --config "C:\Private\mappr-s3b.json"
```

Never use `npm run migrate` or execute the A1 baseline on this populated target.
After an interrupted/uncertain migration, run status first: do not blindly repeat
migrate. A valid existing column permits the separately authorized backfill mode;
an unexpected column/schema or any quarantine requires review.

## 5. Remaining developer actions: proportionate readiness checklist

1. **Confirm the exact target and writer inventory.** The brief resolves the
   earlier production-separation uncertainty for this target. Privately match
   the configured application's connection with the provider/project and
   operator config. Identify every terminal, nodemon parent/child, built server,
   deployed instance and job sharing it. Supply the actual stop/restart actions;
   the tool does not guess names or kill unrelated Node processes.
2. **Obtain a recoverable backup.** No completed backup, restore evidence, or
   usable recovery procedure was verified here. `Get-Command` found no
   `pg_dump`, `pg_restore`, or `psql` on this shell's PATH. The existing Node
   PostgreSQL dependency now supplies migration/backfill execution; it does not
   supply a logical backup utility. The remaining prerequisite is compatible
   PostgreSQL 17 backup/restore clients with private credentials, **or** access
   to the verified provider's actual export/restore tooling and recovery evidence.
3. **Make backup verification concrete.** With compatible clients, use a private
   PostgreSQL service/passfile to select the same verified development target:
   `pg_dump --dbname=service=mappr_dev_backup --format=custom --file=<private-backup.dump>`.
   Require successful completion, preserve the archive/checksum and recovery
   point, then inspect it with
   `pg_restore --list <private-backup.dump>`. Listing alone does not establish
   restorability. Verify restoration into a separately authorized, positively
   isolated empty restore target and check application schema/counts/history
   there. Never restore onto the working database for this test. Alternatively,
   document equivalent completed provider backup/recovery evidence. Service
   names here are proposed, not configured or verified. Do not recreate the
   existing application database or introduce Docker as its substitute.
4. **Stop/drain writers before the final backup/cutover.** Block new
   `/generate` and `/maps/:id/iterate` requests, stop their identified supervisors
   and all other canonical writers, and account for in-flight AI requests.
   An idle database does not prove AI has drained. Verify parent/child processes
   cannot respawn and no old transaction/request can commit later. Keep writers
   stopped through final status, backup, migration, backfill and activation.
   Prefer stopping the development backend entirely during this short window.
5. **Review the frozen dry run and approve execution separately.** Require zero
   quarantine and reconcile the full inventory. The preflight's 38 maps,
   including 35 without history, are historical observations, not fresh results
   from this task. No live full-schema validation total is claimed here.
6. **Activate consistently after successful backfill.** Verify
   `revisionReady:true` and zero quarantine. Configure the reviewed S3A code and
   exact `MAPPR_REVISION_WRITES_ENABLED=true` on every replacement writer before
   reopening traffic; inspect each actual launch/service environment.
   No old/off writer may remain. This is an operator checklist, not an automated
   flag change or deployment performed by the tool.

On failure keep writes paused and preserve the column, snapshots and partial
progress. Re-run read-only status and review the outcome. Per-map restarts
classify completed work unchanged. Do not flip the gate off and resume legacy
writers, drop records/columns, rewrite history, or restore over newer writes
without an explicit recovery decision.

## 6. Verification actually run

```text
node node_modules/typescript/bin/tsc --noEmit
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs
```

TypeScript: **PASS**, exit 0, run once, no emitted build.
The combined test run reported **132 passed, 1 failed, 0 skipped**. All 84 prior
S2/S2.1/S3A tests passed; one new test incorrectly expected a simulated external
owner change to disappear. The fixture was corrected to preserve that independent
change and assert maintenance performs no writes, then **only the affected S3B
suite** was rerun:

```text
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/revisions/s3b-cutover.test.mjs
```

Focused rerun: **49 passed, 0 failed, 0 skipped**. No production TypeScript
changed after its successful check. The existing suites were not repeated.
Tests used in-memory database/transaction mocks; real PostgreSQL construction is
blocked in their workers. SQL, including migration text, was interpreted only by
the mock, not submitted to a database. Local HTTP servers exercise existing
routers. Tests ran with approved sandbox escalation because the TypeScript
loader's OS lookup was previously blocked. Node reports its experimental
module-mocking warning.

Coverage includes explicit target/config/approval refusal, READ ONLY dry run,
owner-metadata integrity without browser proof, schema/column/isolation mismatch,
invalid payload/history and snapshot quarantine before writes, initial snapshots,
matching existing history, preservation of original records/history/artifacts/
usage/timestamps, SQL-failure rollback with prior progress retained, restart
without duplicate snapshots, locked owner recheck, and sanitized CLI output.
No configured/disposable PostgreSQL integration test, real migration/backfill,
backup/restore, or browser smoke write was run. Actual provider connectivity,
real DDL/row-lock/commit behavior, and browser cookie/revision ordering remain
unverified.

## 7. Review decision

**GO for review of the prepared tooling and maintenance ownership distinction;
NO-GO for execution or activation.** The browser-per-map proof burden is removed
for privileged bookkeeping, the development-only boundary is confirmed by the
brief, and an explicit Node-based operator path replaces the missing runner.
S2 editing authorization is unchanged.

Remaining blockers are a verified backup/recovery procedure, complete live
writer inventory and stop plan, private target configuration plus a fresh
zero-quarantine status, and separate explicit developer execution approval.
Operational attestations, strict schema assumptions and real PostgreSQL behavior
must be checked before trusting the mock-tested procedure on existing records.

**Stop for review. Do not execute S3B or begin S4.**

