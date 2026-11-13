# Mappr S3B final operational readiness

Date: 2026-11-07. **NO-GO for migration, backfill, or revision-write activation.**
The live status check reached the verified development target and found **13
schema-invalid maps**. Recoverability and complete writer quiescence also remain
unverified. Stop for review before any database writes.

## 1. Scope and verified target

Read the final-readiness brief, cutover-preparation report, S3A/preflight handoffs,
and current operator engine/CLI. Inspected Git status/diffs first; no applicable
repository/ancestor AGENTS.md was found. Existing source, migrations, tests,
configuration, and earlier documents were preserved. This report is the only
project file added.

Observed without exposing connection details:

- The app uses the workspace dotenv database URL, with no process-level override.
  Effective local NODE_ENV is development and revision writes remain disabled.
  Development-only use is confirmed by the user.
- The configured endpoint identifies Supabase. A READ ONLY probe matched the
  actual database name to the configured URL database and the effective role
  to the configured Supabase pooler username convention. This independently
  checked the app target before pinning the CLI fingerprint.
- PostgreSQL reports **17.6**, default isolation **READ COMMITTED**, and
  transaction_read_only **on**. Probe timestamp: **2026-11-07 11:50:43 UTC**.
  Local statement/lock timeouts were 10s/1s; the transaction ended with ROLLBACK.
- TLS remains enabled with rejectUnauthorized:false, exactly matching the app's
  effective policy, without URL-option overrides. It was not silently changed.
  The fingerprint detects target mismatches; it does not add certificate trust
  or independently certify the provider account.

The sandbox initially denied connectivity; approved read-only access succeeded.
A private-config write failed with EPERM under the first execution context.
Creating its replacement under the CLI's context succeeded, with restrictive
ACLs verified. No application-file or database permissions were changed.

## 2. Private operator configuration

Created outside Git at:

    C:\Users\HomePC\AppData\Local\Temp\mappr-s3b-final-5c646e43b5b04ec686d93afb05b94a93\operator-status.json

Directory ACL inheritance is disabled; file access is restricted to the current
user. Contents were not displayed. The config explicitly supplies the exact app
connection, unchanged TLS policy, verified expected database/role, pinned
fingerprint, developmentOnly:true, and scope:"all-existing-development-maps".

**No approval object is present.** Developer/backup/writer approval gates still
block write modes. This is explicit configuration, not an application
DATABASE_URL fallback. Keep the file private; Temp cleanup may require its
secure recreation.

## 3. Actual status-only result

Ran the existing CLI once against that private config:

    node --import tsx scripts/s3b-cutover.mjs --mode status --config "<private absolute path above>"

It used READ ONLY / REPEATABLE READ inspection, local statement/lock/idle
timeouts of 10s/1s/30s, and ROLLBACK. Rows were validated privately in memory;
only aggregate results were returned.

| Result | Observed value |
| --- | --- |
| Target pinned / fingerprint matched | true / yes |
| Supported schema compatible | Yes; S1 schema/constraint/index/trigger/RLS and required privilege checks passed |
| columnPresent | **false** |
| Maps / saved history rows | **38 / 6** |
| initialize candidates | **22** |
| match candidates | **3** |
| unchanged | **0** |
| quarantined | **13** |
| Quarantine reason | **invalid_system: 13** |
| readyForBackfill | **false** |
| revisionReady | **false** |
| CLI exit | **1**, readiness failure, not a connectivity or unhandled execution failure |

Opaque target fingerprint:

    20dc1f8b338d57f7bbbd9853d019fd25a2b63e2ddd595a4a09d47bc316114af6

The 22 initializations and 3 matches are classifications, **not writes**.
Thirteen current payloads failed full MapprSystemSchema validation. They must
not be blindly snapshotted or bypassed. Rows failing that first validation step
are not certified for every later history/counter check. No payloads or
identifying map/owner information were printed; no repairs were attempted.

The column's absence and revisionReady:false are expected before cutover.
The **nonzero quarantine is an additional substantive blocker**. Earlier counts
of 35 maps without history were structural observations, not evidence that all
35 were eligible. This live result supersedes that assumption.

Maintenance eligibility remains separate from S2 editing authorization.
Browser proof per legacy map is not required for privileged bookkeeping;
signed-cookie owner guards and shared-link behavior remain unchanged.

## 4. Backup/recovery evidence and missing prerequisite

Supabase is identified from the configured endpoint. No connected provider
control-plane tool, completed backup/recovery record, private backup artifact,
or demonstrated restore result was available. **This does not establish that
provider backups do not exist; recoverability remains unevidenced.**

No psql, pg_dump, or pg_restore was found on PATH or in the bounded checks of
conventional PostgreSQL/pgAdmin versioned bin locations. The Node driver provides
status/migration execution, not logical backup export. No dump/restore ran,
and no local file search was substituted for backup proof.

The developer must provide either:

- Access to the correct Supabase project's completed backup/recovery facility,
  a usable recovery point, and credible restore verification; or
- Compatible PostgreSQL 17 pg_dump/pg_restore clients, private connection
  configuration, a completed logical archive outside Git, and successful
  restore verification in a positively isolated target.

A backup setting, scheduled task, or successful archive listing alone is
insufficient. Never test restoration on the current application database or
replace it with a disposable database.

## 5. Writer inventory and executable stop plan

Approved read-only process/socket inspection found:

| Scope | Actual observation |
| --- | --- |
| Local backend/supervisor positively identified from this workspace | **0** |
| Listening sockets on configured app port 4000 | **0** |
| Other database client sessions at the identity probe | **5** |
| Active other sessions / idle-in-transaction sessions | **0 / 0** |
| Visible active canonical DML / sessions with unknown visibility | **0 / 0** |

Only matching backend/supervisor classifications were considered; no unrelated
process IDs or raw command lines were printed. No process/service was stopped.
These observations do not exclude remote writers, alternate-port instances,
relative-command launches, jobs, or in-flight AI. The five idle database sessions
were not assigned to invented services.

Canonical request writers remain POST /generate and POST /maps/:id/iterate.
The developer must identify every actual terminal/service/worker sharing this
target and its supervisor/stop action. Before cutover, block new requests and
stop/drain those identified writers, including in-flight AI and restart-capable
parents. Verify no old request/transaction can commit later; idle SQL alone is
insufficient. Keep writers stopped through final backup, migration, backfill
and replacement configuration. Verify the exact enabled flag on every replacement
writer before reopening traffic. Do not indiscriminately stop Node processes.

## 6. Decision and smallest next actions

**NO-GO for execution.** Target/configuration and real status-only access are now
verified. Remaining requirements are:

1. Privately review a reconciliation policy for the **13 schema-invalid maps**.
   Repairs or legacy-schema accommodation require separate review/authorization.
   Do not force counters, omit quarantine from global-readiness claims, rewrite
   data/history, or assign owners.
2. Supply actual backup/recovery evidence through one supported path above.
3. Confirm the complete writer inventory and executable stop/drain plan.
4. Repeat status after approved reconciliation and within the maintenance
   window; require zero quarantine and a verified target.
5. Obtain a separate explicit execution instruction before migration 013,
   backfill, or activation. No such approval exists in the private config.

On a later failed cutover, preserve column/snapshots/progress and keep writes
paused; do not disable the gate and resume legacy writers after backfill.

No offline suites were rerun because no application code changed. These results
come from real read-only PostgreSQL identity/status checks, process/socket
metadata, client availability, ACL verification, and Git integrity checks.
They do not prove real DDL/commit/restore behavior.

**Migration 013 was not executed. No database records were modified, backfill
run, revision writes enabled, application code changed, or S4 work started.
Stop for review.**

