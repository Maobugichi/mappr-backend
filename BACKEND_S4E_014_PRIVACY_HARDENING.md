# Mappr S4E-P migration 014 privacy hardening

2026-11-11. **PASS: source hardening and isolated PostgreSQL verification.**
GO to review and resume focused S4E preflight afterward; **NO-GO for live
migration execution until the remaining operational gates pass**. No Supabase
connection or SQL was performed in this task. STOP for review.

## Scope and starting state

Read the hardening brief from the repository's
`mappr-s4e-014-proposal-privacy-hardening (1).md`; it is hash-identical to the
requested filename in Downloads. Read the S4E execution report and inspected
Git status/diffs/index, migration 014, related transactions/routes, 015/016 and
existing integration tests before editing. No applicable AGENTS.md was found.
Preserved all earlier uncommitted S4/S5 implementation and historical evidence.

The prior Supabase preflight is the evidence for the defect: ordinary roles
inherit new-table CRUD grants, while the unexecuted 014 lacked explicit privacy
protection. It was a prospective exposure, not an observed data leak. That
historical report was not rewritten to imply live remediation.

## Exact changes

| File | Change |
| --- | --- |
| `src/db/migrations/014_change_proposals.sql` | Enable proposal-table RLS, revoke PUBLIC and present ordinary-client role grants, and reject remaining dangerous inherited privileges inside the original transaction. |
| `tests/db/s4d-postgres-integration.test.mjs` | Reproduce Supabase-like defaults in a fresh synthetic target; test absent roles, atomic visibility/rollback, effective ACLs, actual CRUD attempts, defensive RLS and backend lifecycle access. Existing S4/S5 checks remain. |
| `tests/changes/overview-preview-apply.test.mjs` | Extend the existing static migration assertions for RLS/revocation and absence of client policies, FORCE RLS or default-grant rewrites. |
| `BACKEND_S4E_014_PRIVACY_HARDENING.md` | This report. |

No runtime service/API/schema contract, payment/allowance policy, frontend file,
dependency, migration 015/016, baseline/013 or production interlock changed.

### Object-level protection

Only `public.map_change_proposals` permissions change:

- Explicit `ENABLE ROW LEVEL SECURITY`, with **zero client permit policies**.
- `REVOKE ALL` from PUBLIC and from `anon` / `authenticated` when those roles
  exist. Conditional role lookup preserves vanilla PostgreSQL compatibility.
- A post-revocation effective-privilege check covers SELECT, INSERT, UPDATE,
  DELETE, TRUNCATE, REFERENCES and TRIGGER. If inheritance still supplies one,
  the migration raises 42501 and rolls back. It does not rewrite unrelated role
  memberships or database-wide default privileges. TRUNCATE is checked because
  RLS alone does not constrain it.
- No FORCE RLS. A table-owning backend retains its PostgreSQL owner access.
  A non-owner backend instead needs **both** appropriate SQL grants and a
  reviewed RLS-bypass capability; BYPASSRLS alone grants no table permission.
  No actor/JWT-based client policy was introduced.

Other established server-role grants are not revoked indiscriminately. A
privileged service role is not treated as an ordinary browser client; its actual
production trust/grants still require review before execution.

The UUID primary key uses the existing built-in generator, not a new sequence.
014 creates no persistent view or routine that projects proposal payloads. Its
anonymous DO block is not a stored RPC. Existing history association/metadata
columns and their storage contract remain unchanged. Existing public history/
diff handlers select version/summary/time or canonical snapshots; no new public
join to proposal instructions, preview responses or apply receipts was added.

### Atomicity and integrity

Creation, RLS, revocations, effective-grant checks, indexes and history additions
remain within 014's original BEGIN/COMMIT. Tests held that transaction open and
confirmed another connection could not see the table before COMMIT. An
inherited-TRUNCATE failure rolled back creation rather than publishing an
inadequately protected table. The normal migration's other constraints/indexes,
columns and ownership model were preserved.

Working-tree SHA-256 of migration 014:

```text
Previous: aa56a2a5df041516f25de7b87ea1b6e9fa3fd8d070b4ec97057a43f8f122b8d4
Hardened: 3a35ce92c423f72fc69af8bd862e9b5e9df7cc38126605b1a856a4117af47064
```

This records the exact file bytes used for this verification. Any operator
manifest/approval pinned to the old hash is stale for this source. Review and
pin the actual approved release checkout's SQL before live execution; do not
silently substitute source under an old approval. No private approval, schema
allowlist or migration executor was modified here.

## Fresh isolated PostgreSQL verification

Reused only the previously pinned local PostgreSQL **17.11** cluster, initially
stopped, at **127.0.0.1:54130**. Independently matched actual cluster system ID,
data directory, version and loopback endpoint before creating a **new empty,
marked `mappr_s4d_synthetic_*` database from template0**. None of the seven retained
databases was selected for setup, reset or restore.

All records/providers were synthetic. App pooling was replaced with the verified
local pool. Real application SQL ran as a new **non-superuser, non-BYPASSRLS
table owner**, not as the bootstrap superuser. Ordinary test roles are NOLOGIN,
non-superuser and non-BYPASSRLS, separately selected for SQL privilege tests.

Applied baseline/013, corrected 014 and unchanged 015/016 in order. Two explicit
014 rollback trials preceded its successful commit: the absent-Supabase-role
path, and rejection of residual inherited TRUNCATE. Their schema changes were
confirmed rolled back before proceeding. Supabase-like PUBLIC/anon/authenticated
CRUD defaults were simulated **only in this disposable database**; the migration
itself does not change defaults.

| Verified case | Actual result |
| --- | --- |
| RLS enabled / FORCE RLS / proposal policies | **true / false / 0** |
| PUBLIC proposal-table ACL entries | **None** |
| `anon` / `authenticated` effective listed privileges after migration | **All denied** |
| Direct client SELECT/INSERT/UPDATE/DELETE SQL | **42501 denied for each role/operation** |
| Explicit CRUD regrant plus matching actor/JWT claims | SELECT returned zero rows; UPDATE/DELETE affected zero rows; valid attempted INSERT failed RLS with 42501 |
| Unrecognized ordinary role retaining inherited CRUD | RLS hid populated proposals and the 015/016 private tables |
| Backend owner create/read/state transitions | **PASS without superuser or BYPASSRLS** |
| Non-owner HTTP/Apply requests | **404 denial preserved**, no additional provider work |
| Preview key replay and apply receipt replay | **PASS**, once-only accounting/revision behavior preserved |
| Existing S4/S5 lifecycle | All thirteen AI paths and six current exports, stale inspection/export refusal, concurrency, rollback/recovery and release interlock remained passing |
| New public sequences / views / stored routines | **None** |

Final independent read-only verification found **31 synthetic maps / 37 history
snapshots**, zero reserved attempts, accounting mismatches, incoherent maps or
unvalidated constraints. Even with retained CRUD permissions, the untrusted
test role saw **zero rows** in proposals, artifact generations, attempts and
daily policy. These are synthetic counts, not fresh Supabase observations.

All seven pre-existing database identities/owners and protected local target/
restore-proof hashes were retained. After zero other client sessions were
observed, the owned local cluster was returned to **stopped**: stop exit 0,
status exit 3, no postmaster PID file. The fresh synthetic database, NOLOGIN test
roles and restricted evidence/configuration are retained locally for review.
No archive or existing recovery record was overwritten.

## Commands and actual results

With explicit fresh synthetic configuration and disposable confirmation:

```text
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/db/s4d-postgres-integration.test.mjs
```

**19 passed, 0 failed, 0 skipped**: 18 integration subtests plus parent. The
opt-in target guards require the pinned local PG17 server and an empty synthetic
database; rerunning setup over this now-populated target is refused.

Focused Overview suite: **75 passed, 0 failed**. Final checks exited 0:

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs tests/artifacts/artifact-safety.test.mjs tests/changes/provider-admission.test.mjs tests/changes/daily-admission.test.mjs tests/db/s4d-postgres-integration.test.mjs
```

Offline regression: **362 tests: 360 passed, 0 failed, 2 skipped**. Both database
opt-in sets were cleared in that process, so the separate baseline PG suite and
this integration parent deliberately skipped there. The actual integration run
above was separately enabled and passed. Experimental module-mock warnings and
static expected-failure logs remain.

Compared all 152 pre-existing project files: only 014 and the two intended test
files changed. Earlier reports/briefs, migrations 015/016, runtime source, private
recovery inputs, `.env`, Git HEAD and index were preserved. Ignored build output
was refreshed. No commit/push was made.

## Continuation review — 2026-11-12

Re-read the brief and historical S4E report and inspected the current Git state,
source changes and this already-created report before continuing. The tests and
build above were completed in the preceding work; they were not rerun. Saved
restricted setup/final evidence confirms a new empty local PG17.11 target,
zero source-database connections, the reported privacy/integrity results and
the local cluster's stopped state when verification completed. This continuation
made no database connection and does not claim a fresh hosted-state check.

Repeated the 152-file preservation comparison: exactly migration 014 and the
two intended tests differ, no original file is missing, and this report is the
only added project file. The migration hash still matches the hardened hash
above. `.env`, HEAD and the empty Git index remain unchanged. `git diff --check`
passed; a limited credential-pattern scan of the four task files found no
connection URLs, private-key blocks or provider-key patterns. Completed source
and tests were preserved; only this continuation note was added.

## Return to S4E recommendation

**GO for review of this source correction and subsequent focused S4E preflight.**
The confirmed default-grant scenario is addressed locally with actual SQL tests.
This is not permission to execute live SQL and does not certify current hosted
settings.

Before any live migration, S4E must still confirm current writer containment,
actual hosted backend role/grants and pool timezone against the pinned migration
connection (previously observed UTC), effective defaults/RLS and any remaining
inherited privileges, current revision/preservation evidence, and a **new current
pre-014 backup with independently verified isolated restoration**. Operator
schema/hash checks and execution approval must match this reviewed SQL. The
older backup and previous source hash are not sufficient substitutes.

Keep the unconditional S4 interlock and default-off daily admission unchanged.
No Supabase connection, Render operation, live AI call, real allowance charge,
deployment, payment/frontend work or activation occurred. **STOP for review.**
