# Mappr S3B current backup restore verification

Date: 2026-11-08. **PASS: the existing current pre-013 archive was restored once
into a separate empty local database and verified against its recorded source
baseline. The local cluster is stopped. No Supabase connection was made.**

## Scope and earlier failure diagnosis

Read `mappr-s3b-local-restore-verification-recovery.md`, the migration execution
report, private failed-recovery record, existing restore instructions, retained
local configuration and relevant server logs. Inspected Git status/diffs and
repository instructions first; no applicable AGENTS.md was found. Existing
application/executor/migration work and private artifacts were preserved.

The earlier record exposed only `verify_isolated_cluster` /
`isolated_recovery_failed`, without the underlying exception or SQLSTATE. Its
server log proves successful startup. The only FATAL message followed the fast
shutdown request:

```text
terminating connection due to administrator command
```

That message is a cleanup effect and does not establish the original cause.
The retained cluster had no pre-013 restore database and the earlier helper had
not created its target service/password files. No archive restore was invoked
in that attempt. These facts bound the earlier failure but cannot distinguish
bootstrap authentication, preliminary identity/catalog reads, or a failed/
uncommitted database-creation step. **The precise earlier cause and underlying
SQLSTATE are not recoverable from the retained generic error.**

A bounded local diagnostic at **13:14:10–13:14:29 UTC** separately verified:

| Local step | Result |
| --- | --- |
| PostgreSQL startup | **PASS** |
| `pg_isready` | **Exit 0** |
| TCP and SCRAM/SASL authentication | **PASS, including SASL-final and ready-for-query** |
| Bootstrap role/database verification | **PASS** |
| Actual loopback host, port, data directory and cluster system identifier | **All matched the retained local pin** |
| Preliminary READ ONLY SQL and local database inventory | **PASS** |
| Diagnostic shutdown | **Verified stopped** |

The earlier failure did not reproduce. No credential, role, authentication-rule,
port or server-configuration repair was necessary. The local verification
procedure added explicit readiness checks and separate stage/error capture;
no application or executor code was changed. The diagnostic performed no local
DDL and no restore.

## Controlled restore and target isolation

One controlled restore verification ran from **13:16:38 to 13:17:23 UTC** using
the existing PostgreSQL **17.11** tools and existing private local credentials.

Before local DDL or restore, the actual server's loopback endpoint, configured
port, data directory, version, role and system identifier were matched to the
previously verified private recovery cluster. Its listener was loopback-only.
A newly generated database name was checked for absence and created from
`template0`. A separate authenticated connection then verified that exact
database and confirmed an empty public schema. The earlier recovery database
was retained; it was never selected as the restore destination.

The archive's schema was decoded successfully. Its public-schema creation was
handled by dropping only the empty default schema in the new test database.
The local restore service explicitly supplied every target connection field;
no application URL or implicit database fallback was used. The existing archive
was neither overwritten nor recreated.

Redacted command/action sequence:

```text
pg_ctl -D <pinned local data directory> status
pg_ctl -D <same local directory> -l <new private log> -o <loopback-only listener> -w -t 30 start
pg_isready --host <loopback> --port <pinned port> --username <local role> --dbname <bootstrap database> --timeout 5
CREATE DATABASE <new unique local test database> TEMPLATE template0
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname=service=<private isolated service> <existing current archive>
pg_ctl -D <same local directory> -m fast -w -t 30 stop
pg_ctl -D <same local directory> status
```

The actual paths, local connection fields and logs remain private outside Git.
There was **one archive restore invocation**, exit **0**, with no restore retry.

## Verified restored database

The unchanged archive is **203,636 bytes**. Its recorded SHA-256 matched before
and after verification. Its source preservation snapshot is dated
**2026-11-08 12:46:07 UTC**, after the successful legacy reconciliation.

Independent READ ONLY / REPEATABLE READ verification in the restored database
used UTC rendering and checked every table's row count and sorted row-hash
digest against that recorded source baseline:

| Check | Actual result |
| --- | --- |
| Application tables / complete rows compared | **13 / 185** |
| Exact table parity against recorded source baseline | **PASS for all 13 tables** |
| Maps / structurally valid maps | **38 / 38** |
| Existing history rows / history-bearing maps | **6 / 3** |
| Contiguous histories and latest-snapshot JSONB equality | **PASS** |
| Original columns | **78** |
| Validated constraints | **36** |
| Valid, ready indexes | **28** |
| Foreign keys checked / orphan references | **12 / 0** |
| Read-only readiness classifications | **35 initialize, 3 match, 0 quarantine** |
| `current_revision` in the restored copy | **Absent, as expected before 013** |
| Earlier local recovery database | **Preserved** |
| Prior private artifacts and archive | **Unchanged** |
| Final local cluster state | **Stopped; status exit 3 and no postmaster PID file** |

Complete row parity covers the saved canonical payloads, owners, input
descriptions, timestamps, history, artifacts and usage records. Readiness
classification was pure planning on the local copy; no revision backfill was
performed.

Restore scope is the **public application schema and data**. `--no-owner
--no-acl` deliberately uses the isolated local owner. This does not certify
recovery of Supabase roles/grants, Auth, Storage or the entire hosted project.

The archive, original failure evidence, new detailed diagnostics, local target
configuration, native logs and successful verification record were retained
privately. Earlier evidence was not overwritten. The new successful record
supersedes the earlier recovery failure for this archive; it does not rewrite
that historical record.

## Remaining S3B prerequisites and stop boundary

The current archive's public-schema recoverability gate is now demonstrated.
This task made **zero connections to the working Supabase database**, so it
does not establish that the live database remains identical to this recovery
point or refresh source writer-quiescence observations.

Before any later migration/backfill, repeat the prepared read-only status and
preservation checks against the pinned source target within the maintenance
window. Confirm membership/history/schema and continued correspondence with the
verified recovery point. Obtain current writer containment/stop-drain evidence:
remote Render `mappit` suspension and Data API disablement still rely on developer
confirmation, with no independent control-plane verification here. Earlier local
backend and source-session observations are historical. Idle database sessions
alone cannot exclude in-flight AI requests or reconnecting clients.

Only this project report was added. No application code, migration, credentials,
source configuration or existing report was edited. No new backup was created,
and no restore or other command was sent to the source database. No migration 013, revision
backfill, revision-write activation, deployment, Render restart, reconciliation
rerun or S4 work occurred. No offline suite was rerun; verification used the real
isolated PostgreSQL database and existing archive.

**STOP for review. Keep all known application writer paths stopped.**
