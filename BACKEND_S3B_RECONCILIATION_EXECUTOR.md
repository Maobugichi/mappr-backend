# Mappr S3B one-use reconciliation executor

Date: 2026-11-07. **Prepared and tested; live execution NOT APPROVED.**
No application database connection, reconciliation write, migration 013, backfill,
revision activation, or S4 work occurred in this task.

## 1. Scope and files

Inspected repository instructions, current Git changes, reconciliation plan,
diagnostics, preparation/final-readiness reports, change contract, and actual
schema/operator/revision/test code. No applicable repository/ancestor AGENTS.md
was found. Existing unrelated changes were preserved.

| File | Change |
| --- | --- |
| scripts/s3b-reconcile.mjs | New explicit validate/execute CLI; no startup or lifecycle hook |
| scripts/lib/s3b-reconciliation-executor.mjs | New one-use planner/executor with private evidence, locked rechecks and exact-result retry handling |
| scripts/lib/s3b-private-evidence.mjs | New restricted external-file checks and exclusive, flushed original-evidence storage |
| tests/revisions/s3b-reconciliation-executor.test.mjs | New focused offline executor tests |
| scripts/lib/s3b-reconciliation.mjs | Exposes its existing strict packet parser; existing validation semantics retained |
| scripts/s3b-cutover.mjs | Extracts/exports its existing outside-repository JSON reader for reuse; existing command behavior retained |
| src/db/s3bCutover.ts | Exports existing target/schema inspection functions for reuse; their behavior is unchanged |
| BACKEND_S3B_RECONCILIATION_EXECUTOR.md | This handoff |

No authorization middleware, public map read, canonical writer, application
schema, migration, package/dependency, environment, flag, deployment, or existing
document was changed. The executor is not imported by application startup.

## 2. Explicit inputs and gates

The new command never loads dotenv or selects an application DATABASE_URL.
It requires explicitly supplied private config and approved review paths outside
the repository. It reuses the existing configuration parser, pinned target and
PostgreSQL 17/READ COMMITTED checks, observed-schema checker, review validator,
source fingerprints, and bounded SQL transaction helper.

Read-only validate is the default mode. It requires a pinned development target,
the exact approved policy and complete node approvals, but does not require or
grant execution approval. Private files/parents must restrict read access to
the current user and trusted local SYSTEM/Administrators on Windows, or owner-only
permissions on other supported environments. No permissions are silently changed.

The one-use scope is deliberately fixed to **13 candidates / 131 task paths /
25 descriptions across 3 Architecture maps**. Different scope, unknown schema,
an existing current_revision column, missing source, stale owner/data/context,
incomplete approvals, or incompatible unrelated maps fail closed.

Execute additionally requires:

- Existing operator-config approval fields developerApproved, backupVerified,
  and writersStopped all true, with nonempty backupEvidence/writerStopEvidence
  references.
- Exact token AUTHORIZE_S3B_RECONCILIATION_WRITE.
- An explicit restricted evidence path outside the repository.
- Complete fresh whole-inventory validation before any DML.

These are operator attestations; code cannot prove backup restorability or that
every remote writer/in-flight AI request has stopped. The developer must review
the evidence and give a separate execution instruction. Approval of descriptions
and this implementation brief do **not** authorize writes. No execution-approved
configuration or real recovery evidence file was created here.

## 3. Read-only validation

The engine acquires one explicitly verified session. Its validate transaction is
READ ONLY / REPEATABLE READ with local 10s statement, 1s lock and 30s idle-transaction
timeouts, ending with ROLLBACK. It reads the whole current inventory and history
within that coherent snapshot.

It validates all reviewed source fingerprints and owners/context using the
existing helper, checks every approved candidate against the unchanged
MapprSystemSchema, and requires no history on selected maps. Other maps/snapshots
must remain structurally valid, with contiguous history and matching latest
snapshots. Unknown/invalid rows cause failure, not partial readiness.

PostgreSQL SELECT expressions project each exact approved JSONB result from
captured raw source text. Legacy descriptions are copied with JSONB path
operators; only approved new description text is parameterized from the packet.
The projected parsed result must also equal the exact approved helper candidate,
not just pass its schema. Unrelated JSONB values, including numeric representations that could change
during JavaScript reserialization, are retained by these SQL expressions.

Successful output contains aggregate counts only: inventory size, 13 validated
candidates, 131 task paths, 25 descriptions, original/already-applied counts,
and zero simulated quarantine. This describes the proposed reconciled state,
not the untouched live database. Validate neither writes PostgreSQL nor creates
an evidence file.

## 4. Execution and preservation

Before the first database update, execute saves all 13 original raw JSONB values,
owners, input descriptions and original timestamps into the explicitly selected
private evidence file. Evidence is bound to target and approved review digest.
Creation is exclusive/non-overwriting, size-bounded, permission-checked, and file
buffers are flushed before DML; parent-directory metadata is also flushed where
supported. A failed/partial evidence save stops before database writes and must
be reviewed privately, not overwritten automatically. This artifact supplements,
and does not replace, a verified backup/restore point.

Each map then uses a separate short transaction, reusing the existing 3s lock and
10s statement timeouts:

1. Reverify target, lock the map, and recheck the schema while holding that lock.
2. Check exact owner/input/timestamp metadata and PostgreSQL JSONB equality plus
   source fingerprint against original or approved-result state.
3. Recheck that selected history remains absent and validate the complete review
   against captured originals plus the newly locked source.
4. Update only approved JSONB paths with nested parameterized jsonb_set calls.
   Each task description comes from the original database string; no full
   JavaScript payload is serialized back to replace canonical data.
5. Require exactly one updated row, full current schema validity, exact approved
   JSONB equality/fingerprint, unchanged non-target data and unchanged metadata
   before COMMIT.

Only maps.data is assigned. IDs, owners, input descriptions, created_at,
updated_at, existing history, artifacts and usage are preserved. There are no
provider calls, quota charges, snapshot inserts or invented product iterations.
Retained artifacts are not newly certified fresh by maintenance.

All engine/CLI errors are sanitized to fixed codes and count-only progress.
SQL values, original records, approved prose, map/owner identifiers, credentials,
and connection details are not logged.

## 5. Deliberate retry/recovery behavior

A successful application changes the old source fingerprint. The executor does
not pretend that it still matches.

The immutable private evidence file allows an authorized retry to reconstruct
the reviewed original sources, revalidate the same approved packet, and compute
the exact expected JSONB result again. For each locked map:

| Current state | Action |
| --- | --- |
| Exact original JSONB and fingerprint; metadata unchanged | Apply approved paths once |
| Exact approved result JSONB and result fingerprint; metadata unchanged | Count already applied; no UPDATE |
| Any other data/metadata/history/schema state | Stop without overwriting it |

Maps commit separately. A failure preserves earlier commits and rolls back the
current transaction where possible. Error progress reports only confirmed
applied/already-applied counts and unresolved remainder. A disconnected COMMIT
can have an uncertain outcome; the next authorized run reconciles all 13 using
the same evidence rather than assuming rollback or blindly repeating updates.

Keep the approved packet and original evidence together and unchanged. A
different review digest/target, missing or malformed evidence, or a missing
selected map stops recovery. A partial run without its evidence is not repaired
by treating the transformed rows as new originals.

After successful execution the engine rechecks the complete inventory, schema,
history and exact selected result states read-only. Unexpected concurrent changes
still stop readiness. No claim of whole-batch atomicity or proven writer
quiescence is made.

## 6. Exact commands: not run in this task

The config and review locations below are previously supplied private paths;
they were not opened or reverified in this implementation task. If the Temp config
has disappeared, securely recreate and independently verify it—never substitute
an implicit URL.

**Read-only validation, before any execution approval:**

    node --import tsx scripts/s3b-reconcile.mjs --mode validate --config "C:\Users\HomePC\AppData\Local\Temp\mappr-s3b-final-5c646e43b5b04ec686d93afb05b94a93\operator-status.json" --review "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\mappr-legacy-reconciliation-review-approved.json"

**Future execution: NOT APPROVED.** Only after separate review, backup/recovery
verification and writer shutdown, provide a new private execution-approved config.
It uses the existing strict config shape plus the approval fields above;
the proposed file below has not been created or verified here.

    node --import tsx scripts/s3b-reconcile.mjs --mode execute --config "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\operator-execution-approved.json" --review "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\mappr-legacy-reconciliation-review-approved.json" --evidence "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\mappr-reconciliation-original-evidence.json" --confirm AUTHORIZE_S3B_RECONCILIATION_WRITE

The evidence directory must already exist with restricted permissions. The file
is created once before first DML and reused unchanged on retries. It must never
be uploaded, printed, committed, or overwritten with a new source snapshot.

**Read-only validation after a partial/uncertain run** must supply that evidence:

    node --import tsx scripts/s3b-reconcile.mjs --mode validate --config "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\operator-execution-approved.json" --review "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\mappr-legacy-reconciliation-review-approved.json" --evidence "C:\Users\HomePC\AppData\Local\Mappr-Private\reconciliation\mappr-reconciliation-original-evidence.json"

No automatic migration or backfill follows any of these commands. Reconciliation
must precede migration 013 and truthful initial-snapshot backfill, with all writers
kept stopped. The executor deliberately refuses post-013 schemas; subsequent
cutover/recovery requires its separately reviewed tools/instructions.

## 7. Verification actually performed

Initial checks, each run once:

    node node_modules/typescript/bin/tsc --noEmit
    node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs

TypeScript passed with no emitted build. **110 tests passed, 0 failed, 0 skipped**:
49 existing cutover tests, 24 existing pure reconciliation tests, and 37 executor
tests including nested cases. Runtime tests exercise the new JavaScript helpers;
those files are outside the src-only TypeScript compilation.

Final review added an exact-approved-value projection guard and its regression
test. Only the affected executor suite was rerun afterward:

    node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/revisions/s3b-reconciliation-executor.test.mjs

That targeted run reported **38 passed, 0 failed, 0 skipped**. No TypeScript source
changed after that successful check; the other 73 tests were not repeated at that stage.

On continuation, Git status/diffs, uncommitted implementation files, the brief,
plan and previous Codex results were reviewed first. The implementation was
already complete and was preserved. The full three-suite command above was run
once more against the final code: **111 passed, 0 failed, 0 skipped** (49 cutover,
24 pure reconciliation, 38 executor tests). TypeScript was also rerun and passed.
Only this handoff was updated during continuation; no additional code or private
files were created or changed.

Coverage includes complete read-only validation, approval/token/evidence gates
before connection, stale source/owner/context, malformed packets/unknown targets,
schema/history/column surprises, quarantine before DML, row locking and rechecks,
task bytes/order and non-target preservation, metadata/row-count verification,
rollback with prior commits retained, evidence-save failure, uncertain COMMIT,
exact-result no-op retries, third-state refusal, sanitized output and no import
connection side effects.

All database operations, including execute-mode updates, ran only against
in-memory mocks. Real PostgreSQL construction is blocked in test workers.
Recovery evidence was an in-memory test store; no real private packet/config
or original-data evidence artifact was read, written or logged. Tests ran with
approved sandbox escalation for the TypeScript loader; Node emitted its existing
experimental module-mocking warning.

The supplied prior validation at 2026-11-07 15:25:13 UTC reported 13 valid candidates,
131 tasks, 25 approved descriptions and zero simulated quarantine. It is prior
evidence, **not** a new executor run. No application database interaction occurred
here, including no read-only execution of this new command.

Real PostgreSQL execution/planning of the new patch expressions, lock contention,
native permission checks and crash/disk durability remain unverified by these
mock tests. A fresh read-only validate run is required before any later execution;
filesystem evidence is not a database transaction receipt or substitute backup.

## 8. Remaining prerequisites and review boundary

**GO for code review; NO-GO for live writes.** Remaining prerequisites are:

1. Verified usable backup and recoverable restore evidence for the exact target.
2. Actual inventory and executable stop/drain plan for every legacy writer,
   supervisor, deployment and in-flight AI request sharing it.
3. Fresh target/schema/review validation with zero simulated quarantine and
   verified private-file permissions. Current unreconciled data is not claimed
   to have zero quarantine.
4. Separate explicit developer execution approval and reviewed private
   execution config/evidence path.

Only after authorized reconciliation and zero-quarantine status may a separately
approved S3B migration/backfill proceed. Verify all replacement writers use the
reviewed revision-aware code and exact enabled flag before traffic resumes.
On failure keep writes paused and preserve evidence/data; do not flip the gate
off and resume legacy writers after backfill.

**STOP for review. No live writes, migration 013, backfill, revision activation,
deployment, or S4 work was performed.**

