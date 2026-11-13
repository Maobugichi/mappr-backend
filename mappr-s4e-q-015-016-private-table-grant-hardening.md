# Mappr S4E-Q — Harden migrations 015/016 against Supabase inherited TRUNCATE grants

**Scope:** Backend repository only. Source changes and isolated PostgreSQL 17 verification only. **No Supabase SQL, database migration, backup or restore, deployment, Render operations, feature activation, or paid-credit work.** Stop for review.

## Why this task exists

The latest S4E Supabase **read-only** preflight passed target pinning, current pre-014 schema, UTC observation, revision coherence (38 maps / 41 snapshots), 13 source-table preservation fingerprints, corrected 014 privacy projection, and reviewed source hashes. However, it found a new **NO-GO**: under observed Supabase default table privileges, migrations **015** and **016** would create their private tables with direct `anon` / `authenticated` privileges, **including `TRUNCATE`**. Both migrations already enable RLS; **RLS does not restrict TRUNCATE**. Do not infer current data exposure: these migrations have not been applied to Supabase.

Migration **014** was hardened and tested in S4E-P. **Preserve 014 without reworking it.** The purpose here is to apply equivalent fail-closed safeguards *only to the new private tables introduced by 015/016*, adapted to their actual DDL, execution role, and lifecycle.

## Source of truth and initial checks

1. Inspect `git status`, index, uncommitted diffs, root instructions (`AGENTS.md`, `CLAUDE.md` if present), and current migration/test source. Preserve unrelated work.
2. Read `BACKEND_S4E_SUPABASE_MIGRATION_EXECUTION.md`, `BACKEND_S4E_014_PRIVACY_HARDENING.md`, `BACKEND_S4D_POSTGRES_INTEGRATION.md`, the latest S4E NO-GO findings, and migrations `014_change_proposals.sql`, `015_artifact_provenance.sql`, `016_daily_generation_admission.sql`.
3. Verify actual table names, SQL transaction boundaries, owner/access model, and the exact established 014 technique. Do not copy SQL blindly or assert roles exist in all PostgreSQL installations.

## Narrow implementation requirements

### 1. Harden only the private new tables

At minimum, review and protect:
- **015:** `public.artifact_generations`.
- **016:** `public.daily_admission_policy` and `public.generation_attempts`.

For each newly created private table, within the migration's existing all-or-nothing transaction:
- Keep/ensure `ENABLE ROW LEVEL SECURITY` with **no permissive policies for ordinary clients**.
- Explicitly revoke **all** table privileges granted to `PUBLIC`, plus direct privileges held by `anon` and `authenticated` **if those roles exist**. The migration must also run on vanilla PG17 without Supabase-specific roles.
- Check **effective** ordinary-client privileges after revocation, not just `relacl`. Include `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER` (and any other relevant PostgreSQL table privileges present in source). If inherited/indirect grants still allow a dangerous action, **fail with a specific SQL error and roll back the whole migration** rather than silently accepting it.
- Explicitly verify `TRUNCATE` cannot be performed by either ordinary client role even when RLS is on. RLS-only row filtering is **not** an adequate substitute.
- Preserve the expected backend owner's SQL privileges and RLS posture; do not add `FORCE ROW LEVEL SECURITY` or client access policies without reviewed need. A non-owner service role needs both SQL permissions and a valid reviewed RLS-bypass path; never infer either from a role name.
- Do not rewrite project-wide default grants, role memberships, Supabase auth settings, existing table permissions, or unrelated schemas. If those prove necessary, STOP and report the smallest new approval needed.
- Preserve 015 artifact links, generation snapshots, FK/retention rules and 016 attempts/usage links, existing SQL order and S4/S5 behavior.

### 2. Actual SQL tests with realistic default privileges

Extend the **existing opted-in disposable PG17 integration suite** rather than creating a new test platform. Reuse the established pin/loopback/empty-synthetic-target guards and fake AI. Create a *fresh* verified synthetic database rather than rerunning migrations over a populated target.

Tests must:
- Simulate relevant Supabase-like direct default table grants, including `TRUNCATE`, to ordinary non-BYPASSRLS roles; include PUBLIC grants where useful.
- Apply baseline/013, existing hardened 014, corrected 015 and corrected 016 **in order**, as a non-superuser table-owning backend role.
- Confirm all three private tables have RLS enabled, no ordinary-client allow policies and no unsafe effective client privileges after commit.
- Attempt actual `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and **`TRUNCATE`** as ordinary client roles, asserting permission denial or protected-row inaccessibility as applicable; especially confirm `TRUNCATE` is denied by privilege, not merely by RLS row filtering. Check `REFERENCES`/`TRIGGER` where feasible using catalog/permission checks.
- Cover roles absent on vanilla PG17 and a deliberately introduced **inherited dangerous grant** (e.g., TRUNCATE through another role) to prove a fail-closed migration rolls back atomically and leaves no newly published private table. Avoid modifying global/test-cluster defaults outside the disposable database.
- Verify the table-owning backend can still execute representative S4 preview/apply, S5 artifact publication/tracked inspection/export, and S4D accounting flows with the original APIs and contract.
- Verify 014 remains protected; no accidental schema/config changes to the other tables.

### 3. Regression and preservation

Run focused SQL/integration tests, applicable mocked S2/S3/S4/S5 regression suites, TypeScript no-emit, backend build, and `git diff --check`. Document actual commands and results without claiming checks not run. Keep existing skipped test behavior explicit.

Perform a focused review of the edited migration source and static assertions for future regressions. Do not expose secrets, connection strings, record payloads or credentials in reports.

### 4. Release evidence (not release authorization)

Compute and record new SHA-256 values for 015 and 016, along with unchanged hardened 014 hash. Historical hash approvals/manifests become stale when source bytes change; do **not** silently reuse them. Point out any S4E preflight/operator privacy-projection checks that must be updated so they recognize the corrected effective-permission model. Prepare suggestions only; do not broaden a production allowlist or execute live SQL in this task.

## Deliverable and stop condition

Create `BACKEND_S4E_015_016_PRIVACY_HARDENING.md`, stating:
- Exact modified files, privilege logic, and why RLS alone was insufficient.
- Actual synthetic PG17 verification and offline regression results.
- Verified backend-owner access and ordinary-client denial (especially TRUNCATE).
- New source hashes, preservation results, and any remaining risks/unknowns.
- A concise list of the subsequent **S4E read-only preflight, hosted role/timezone confirmation, current pre-014 backup with independently verified isolated restore, and separate live migration authorization**.

**Hard stops:** Never touch the real Supabase database, never deploy or resume `mappit`, never enable daily admission/S4, never make paid/live AI calls, never implement billing, and never begin another change scope. If a required security property cannot be established without new permissions or wider changes, STOP and explain the precise blocker.
