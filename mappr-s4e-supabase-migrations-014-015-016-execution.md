# Mappr — Execute additive Supabase migrations 014, 015, and 016

## Status / authority

The developer **explicitly authorizes applying only** the existing, reviewed additive migrations to the **verified Mappr Supabase development database**, in this exact order:

1. `src/db/migrations/014_change_proposals.sql`
2. `src/db/migrations/015_artifact_provenance.sql`
3. `src/db/migrations/016_daily_generation_admission.sql`

Authorization is **conditional on successful preconditions** and does **not** cover deployment, starting/restarting backend writers, enabling `MAPPR_CHANGES_ENABLED`, enabling `MAPPR_DAILY_ADMISSION_ENABLED`, removing S4's production interlock, changing any payment/credit policy, AI calls, or any unrelated schema/data changes.

This is a **controlled database rollout task**, not another architecture audit or schema redesign. The previous isolated PostgreSQL 17.11 integration report (`BACKEND_S4D_POSTGRES_INTEGRATION.md`) reports: ordered migrations succeeded; 17 tests passed against real isolated PG with mocked AI; 360 regression tests passed, two optional skips. **Do not re-create that work**, but recognize that its Supabase-specific RLS/grants/timezone and live recoverability were not verified there.

The backend is hosted as the Render service **`mappit`**, previously *resumed* for the S3C release. Its previously suspended state **must not** be treated as current. The installed backend release at S3C was `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513`. S3B reported 38 coherent maps and 41 snapshots, but these are historical observations and may have changed since. The user's frontend communicates with the Node API; the user previously disabled the Supabase Data API, but that setting also needs fresh confirmation if it matters to writer containment.

## Work agreement

- First inspect current Git status, repo instructions and migrations 014/015/016, relevant S4D and S5A handoffs, current writer and read contracts. Preserve all uncommitted S4A/S4C/S4D/S5A work and unrelated files.
- Use existing private tooling/connection configuration, and prove that the **actual target** matches the app's known Supabase development database using database/project/role/endpoint fingerprints without revealing secrets. Never rely on an implicit `DATABASE_URL` fallback, a guessed project, or a new DB.
- **No AI calls**. No app generation/iteration, no billing/usage entry inserts, no provider requests. No use of `npm run migrate` (historically broken), no S1 baseline replay, no 013 replay/backfill and no broad reset.
- Work safely with transaction boundaries and timeouts. Do not claim an operation rolled back if the commit response was lost. Determine the actual catalog state before considering a follow-up.
- Protect all private credentials, IDs, row payloads, backup archives, and SQL error contents. Reports should contain counts, schema names, status, and sanitized failures only.
- **Stop on a specific blocker**, say exactly which precondition failed, and ask for the smallest manual action. Do not silently weaken any guard, alter the release, change the user-approved policy, or take a different route.

## A. Read-only preflight — before any database write

1. Confirm revision readiness of the current application schema: valid `maps.current_revision`, matching latest `map_versions` snapshots, coherent history and no quarantine. Expect 38 maps/41 snapshots only if nothing has changed; do not fail merely because legitimate new maps were created. Inspect current inventory and reconcile differences with baseline evidence.
2. Confirm `014`, `015`, and `016` are not yet installed; if any is partially/fully installed, STOP and classify observed schema before acting. Verify existing tables and data expected by these migrations, required DDL privileges, and whether the migrator's effective role is an appropriate table owner/bypass role.
3. Verify actual Supabase PostgreSQL major version, configured timezone, current session role, RLS posture, inherited/default grants and the effective role used by the *running Node backend*. In particular, verify that new private tables (`map_change_proposals`, `artifact_generations`, `generation_attempts` and `daily_admission_policy`, as defined by the actual migration SQL) will remain inaccessible to ordinary client roles and accessible to the reviewed backend role. **Do not assume isolated local role semantics carry over to Supabase.** Do not grant PUBLIC permissions or disable protective RLS to make the migration pass.
4. Inspect 016's policy timezone capture against the actual backend pool session timezone. If they may differ, or if a timezone override is required, STOP and report the mismatch; do not alter timezone or rewrite the policy by assumption.
5. Confirm the intended daily generation policy is an allowance, **not** a paid-credit wallet; it is not being activated in this task. The provisional failure-attempt caps of 10 per actor/day and 1000 globally/day need separate review before durable-mode activation; do not change them as part of this schema rollout.
6. Inventory current writers. **Render `mappit` was previously resumed; require fresh verification that it is now suspended/stopped or otherwise demonstrably unable to commit writes**, including in-flight requests and supervisors. Confirm local backend off and any other known direct/remote database paths controlled. A count of idle SQL sessions alone is not proof. If Render control is unavailable to Codex, STOP and request the precise UI confirmation/action from the developer. Do not claim quiescence from old reports. No silent automatic suspension or restart without an appropriate verified maintenance plan.
7. Establish a **current, recoverable pre-014 backup** after new writes are stopped. The prior S3B pre-013 backup is not automatically a current restore point: the backend has since been live. Use the already verified PostgreSQL 17 backup/restore tooling and isolated local restore approach, reusing it rather than provisioning an unnecessary hosted service. If a current backup/restore proof already exists, verify its source-state match and evidence rather than needlessly duplicating it. Verify source rows/history, archive integrity and a successful isolated restore sufficient for the public application schema. Never test restore on Supabase itself. Stop if current recovery cannot be established.
8. Re-run focused read-only schema/preservation checks after writer containment and before DDL. Do not use the historical S3B schema allowlist unmodified: it was intentionally fixed to the earlier schema and is not a post-014/015/016 validation tool. Use an appropriately reviewed schema-aware read-only check.

## B. Conditional, authorized migrations

**Only after all A conditions pass:**

1. Apply **014** using the exact committed/prepared reviewed SQL contents; validate success and the expected proposal/history columns, FKs, indexes, grants, RLS and preservation of existing records. No preview or apply requests are admitted yet.
2. Apply **015** in order; validate the exact artifact provenance table/links, indexes, owner/RLS/grants and non-mutation of existing artifact payloads/usage. Legacy artifact output without provenance must remain classified unknown/stale, not silently marked fresh.
3. Apply **016** in order; validate policy row, attempt schema/constraints/unique associations, nullable `generations.attempt_id`, role permissions and captured timezone; all existing historical usage retains `NULL` attempt IDs. Do not invent usage or retroactive holds.
4. Respect the migrations' documented transactional semantics. Execute once and track actual successful commits. On a partial/uncertain outcome, **STOP**, preserve state and privately inspect the catalog read-only; do not blindly replay or reset. Do not rewrite already deployed maps/artifacts/history.
5. Use no supplemental DDL, grants, forced RLS changes, default conversions or ad-hoc SQL fixes absent a fresh review. If the existing SQL is incompatible with the actual Supabase role, STOP before modifying it.

## C. Post-migration verification — still no activation

- Verify exact final tables/columns, indexes, constraints, FKs, RLS and grants/owner access. Check that client-facing roles cannot access protected metadata while the backend role can perform the required future operations; use read-only privilege/catalog checks or controlled no-write transaction rolls-back, never production AI requests.
- Compare full pre- and post-migration canonical map, version history, artifact payload, existing usage and key metadata checksums/counts. Any new nullable columns/new tables are expected; **no preexisting row content should be silently rewritten**.
- Verify the S3 revision/history coherence is intact; verify no accidental generation attempts, change proposals, new artifact publications or successful usage were produced by the migration.
- Confirm current runtime flags and feature state remain unchanged. Especially: `MAPPR_CHANGES_ENABLED` not activated; S4's unconditional `preview_policy_not_configured` interlock still in place; `MAPPR_DAILY_ADMISSION_ENABLED` not activated; no new frontend/backend deployment.
- Keep writers stopped and don't resume Render until the next reviewed coordinated source release and activation. The already-live S3C binary does not implement S4/S5 provenance and accounting; avoid mixed-mode access during future rollout.

## Report and stop

Produce `BACKEND_S4E_SUPABASE_MIGRATION_EXECUTION.md` with:

1. GO/NO-GO; verified target identity (opaque only), backup/restore and writer-stop evidence boundaries.
2. Exactly which of 014/015/016 were **attempted, committed and independently verified**, with sanitized timestamps/results. Distinguish expectations from actuals.
3. Actual map/history/artifact/usage preservation and final schema/RLS/permission/timezone checks.
4. Any unverified constraints, uncertain commit outcomes or required smallest next action.
5. Confirmation that no deploy, AI request, daily-mode activation, S4 release, payment feature, or other migrations occurred.

**STOP for review when finished.** Authorization is for 014/015/016 only, conditional on the checks above. If any precondition fails, STOP before writes, preserve all evidence, and do not loop through broad audits.
