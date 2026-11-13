# Mappr S3B revision migration and backfill execution

Date: 2026-11-08. **PASS: migration 013 and revision backfill committed and were
independently verified. All 38 maps are revision-ready. Revision writes remain
disabled; all known writer paths must remain stopped pending review.**

## Authorization, target and evidence

The developer's existing authorization covered only the prepared migration 013
and revision backfill. The developer supplied a current operator confirmation
that Render `mappit` remains suspended, the local backend is stopped, the
Supabase Data API remains disabled, and no additional direct writer or scheduled
Mappr job is known. That current confirmation cleared the previously unresolved
hosted-writer gate when combined with the independent checks below.

Provider-side verification was **not** performed. Remote containment relies on
the current operator confirmation; local processes and database activity were
checked independently. Idle SQL sessions alone were not treated as sufficient
writer-containment proof.

Current Git changes, execution reports, instructions and actual CLI/migration/
backfill code were inspected first. Existing work was preserved. The prior
version of this report and all earlier operational evidence were retained
privately. No application, executor, migration file or dependency was modified.

Verified development target fingerprint:

```text
20dc1f8b338d57f7bbbd9853d019fd25a2b63e2ddd595a4a09d47bc316114af6
```

The configured database/role/fingerprint, PostgreSQL major 17, default
READ COMMITTED isolation, schema and privileges passed verification. The
explicit private target matches the application configuration; credentials,
endpoint and TLS policy were unchanged. No implicit DATABASE_URL fallback was
used.

The existing current pre-013 archive and successful isolated-restore proof
passed integrity checks again: 13 tables, 185 rows, 38 valid maps, six history
rows and exact source-baseline parity. The archive remains hash-identical and
its recovery cluster remains stopped according to the retained verification
record. The original reconciliation recovery evidence remains unchanged.
No new backup or restore was needed.

Restricted evidence records retain the current operator confirmation, recovery
proof reference, fresh preflight, each command attempt/result, intermediate
migration verification, and final independent verification. Paths, credentials,
map/owner identifiers and recovery payloads are omitted here.

## Pre-write gates

Fresh local observation at **14:13:23 UTC** found zero backend/supervisor
candidates, zero port 4000 listeners and zero existing operator write processes.
The database snapshot at **14:13:42 UTC** found six other sessions and zero
active sessions, open transactions, prepared transactions, same-role sessions
or unknown-visibility sessions. No `pg_cron` or `pgagent` extension was present.

The prepared read-only status returned exit 0. Independent READ ONLY /
REPEATABLE READ checks confirmed all 13 tables and 185 rows still exactly
matched the verified recovery point. Serialization used by the backfill was
PostgreSQL JSONB-equal for all 38 maps, with zero mismatches.

| Before migration | Verified value |
| --- | --- |
| Maps / structurally valid maps | **38 / 38** |
| Existing history rows | **6** |
| Initialize / match / unchanged classifications | **35 / 3 / 0** |
| Quarantine | **0** |
| Revision column | **Absent** |
| `revisionReady` | **false**, expected before migration |
| Revision-write feature gate | **Disabled** |

Only after these gates passed, a restricted private execution configuration was
created with the existing exact approval fields: `developerApproved:true`,
`backupVerified:true`, `writersStopped:true`, plus references to the successful
current restore proof and current writer evidence. The source configuration was
preserved. No CLI gate was bypassed.

## Commands actually executed and commit outcomes

The existing `scripts/s3b-cutover.mjs` status entry point was used before and
after the write steps. Each write mode was invoked once as the existing CLI:

```text
node --import tsx scripts/s3b-cutover.mjs --mode migrate --config <restricted approved configuration> --confirm AUTHORIZE_S3B_DEVELOPMENT_WRITE
node --import tsx scripts/s3b-cutover.mjs --mode backfill --config <same approved configuration> --confirm AUTHORIZE_S3B_DEVELOPMENT_WRITE
```

Actual absolute paths and native stdout/stderr logs remain private outside Git.
No generic migration runner, baseline SQL replay or substitute backfill
implementation was used.

| Operation | Actual result |
| --- | --- |
| Migration 013 | **Attempted once; committed; CLI exit 0** |
| Migration interval | **14:14:52–14:15:03 UTC** |
| Post-migration verification | **PASS at 14:17:11 UTC** |
| Backfill | **Attempted once; all 38 per-map transactions completed; CLI exit 0** |
| Backfill interval | **14:17:11–14:18:02 UTC** |
| Automatic write retries / uncertain commit outcomes | **0 / 0** |

Migration applied only the existing additive `current_revision integer` column.
Intermediate independent inspection verified it was nullable and had no default,
all 38 counters were NULL, and every existing row still matched the pre-013
baseline after excluding the new column. All six history rows remained intact.
Writer-activity checks again found no active/open/prepared transaction or
same-role session. Only then was backfill invoked.

The existing CLI processed one batch of 38 candidates (within its 100-map batch
limit). Its final output is a readiness classification. The following actual
batch outcomes were independently confirmed from the frozen before-state and
the resulting counters/history:

| Batch | Candidates | Initialized | Matched existing history | Already unchanged before backfill | Missing | Quarantined |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **38** | **35** | **3** | **0** | **0** | **0** |

All 35 inserted snapshots are version 1, have NULL patches, carry the existing
reviewed-backfill summary, and are JSONB-equal to current canonical data. They
record the now-valid current system; no unknown historic generation event or
timestamp was fabricated. Existing snapshots were not updated or replaced.
Backfill commits per map; no whole-batch atomicity is claimed.

## Final read-only status and independent verification

The prepared final status returned exit 0 with:

```text
columnPresent: true
readyForBackfill: true
revisionReady: true
maps: 38
snapshots: 41
initialize: 0
match: 0
unchanged: 38
quarantined: 0
```

A separate READ ONLY / REPEATABLE READ inspection completed at
**2026-11-08 14:20:33 UTC**, ending with ROLLBACK. It verified:

| Independent check | Actual result |
| --- | --- |
| Structurally valid maps / coherent positive counters | **38 / 38** |
| Counter distribution | **35 at revision 1; 3 at revision 2** |
| Total snapshots / maps with histories | **41 / 38** |
| Original history rows preserved exactly | **6 / 6** |
| Intended new version-1 snapshots | **35 / 35** |
| Histories contiguous from 1, with latest version equal to counter | **PASS for all 38** |
| Latest snapshot JSONB-equal to canonical data | **PASS for all 38** |
| Actual quarantine | **0** |
| Canonical fields, owners, input descriptions and timestamps | **Preserved for all 38 maps** |
| Other artifact/usage/review tables | **11 tables / 141 rows unchanged** |
| Foreign keys checked / orphan references | **12 / 0** |
| Schema | **Only the approved nullable integer column added; constraints/indexes preserved** |
| Recovery archive, original evidence and protected source/private inputs | **Unchanged** |
| Revision-write feature gate | **Disabled** |

Map preservation compared complete row hashes after excluding only
`current_revision`, plus separate metadata hashes. Every old history row was
matched by its retained identity and complete row hash. New-history membership,
versions, NULL patches, summaries and JSONB payloads were checked individually.
All remaining table row counts and sorted row-hash digests matched the saved
baseline. These are actual PostgreSQL results, not expectations or simulations.

The final activity snapshot found six other sessions and zero active sessions,
open/prepared transactions, same-role sessions or unknown-visibility sessions.
No billable AI request, generation/iteration endpoint, artifact regeneration,
credit/usage update or application traffic restart was performed.

## Preservation and review boundary

Only this project report was updated. Application/executor/migration files, other
reports, source configuration, credentials, approved review material, archives
and recovery evidence were preserved. Existing uncommitted work remains intact.
No offline suite was rerun because code did not change; verification used the
real prepared CLI and independent read-only PostgreSQL checks.

Recovery proof remains scoped to public application schema/data, not Supabase
roles/grants, Auth, Storage or full hosted-project recovery. Known hosted writer
containment remains operator-confirmed; no independent control-plane action or
verification is claimed.

**Migration and backfill are complete. STOP for review.** Do not enable
`MAPPR_REVISION_WRITES_ENABLED`, resume/redeploy Render, start the local backend
or begin S4. The flag was not enabled and no deployment or restart occurred.
Keep known writer paths stopped. Any later activation requires separate
coordinated review of every writer's revision-aware build/configuration before
traffic resumes; no legacy/off writer should be resumed after this backfill.
