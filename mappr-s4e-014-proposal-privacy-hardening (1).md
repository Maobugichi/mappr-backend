# Mappr S4E-P — Harden Migration 014 Proposal Privacy (Source & Tests Only)

**Status:** Implementation brief for backend Codex. **Not** authorization to run SQL against Supabase, deploy, or activate S4.

## Confirmed reason for this task

The 2026-11-11 S4E Supabase read-only preflight stopped at permission gate A.3. The pinned application target (PostgreSQL 17.6, observed migration session timezone UTC) has default table privileges for `anon` and `authenticated` including SELECT, INSERT, UPDATE and DELETE. Unexecuted `014_change_proposals.sql` creates `public.map_change_proposals` but does not explicitly protect it with row-level security or revoke those direct grants. This is a prospective privilege exposure, **not an observed current data leak**. Migrations 014, 015, 016 remain unapplied. S5A migration 015 and S4D migration 016 already contain separate internal-table protections.

The same preflight found 38 coherent maps, 41 coherent snapshots, zero invalid/incoherent histories, and a read-only 13-table / 220-row preservation inventory at the time observed. These are point-in-time observations, not a current recoverable backup. Render writer containment was accepted as developer attestation, not independently authenticated; keep it in force if possible, but **do not connect to or mutate Supabase for this source task**.

## Single objective

Patch the **unexecuted source migration 014** so that proposal data and internal proposal metadata are inaccessible to ordinary Supabase client roles under the confirmed live default privileges, while Mappr's established backend-owner transaction paths still work. Add focused, reproducible verification using a fresh, positively isolated disposable PostgreSQL 17 test target. Preserve every existing S4A/S4C/S4D/S5A feature.

## Required workflow

1. In the **backend** repository, inspect `git status`, diff, relevant repo instructions, `src/db/migrations/014_change_proposals.sql`, the change proposal routes/transactions, migrations 015/016, and `BACKEND_S4E_SUPABASE_MIGRATION_EXECUTION.md`. Do not overwrite current uncommitted work or unrelated files. Establish exactly which objects and roles the migration creates or requires.
2. Make the **smallest safe source change** to migration 014. Explicitly enable RLS for `public.map_change_proposals` without any public/anonymous/authenticated permit policy, and revoke effective ordinary-client table access, including explicit `anon` and `authenticated` grants as well as `PUBLIC`. Review whether any related sequence, view, routine, or auxiliary object exposes proposal contents; protect only objects demonstrably implicated. Do not rely on disabling the Supabase Data API or on `REVOKE ... FROM PUBLIC` alone. Do not change database-wide default privileges, modify unrelated existing tables, add client policies, or break backend owner/service access. Confirm actual backend role requirements rather than assuming that `BYPASSRLS` in one environment applies to every role.
3. Ensure the migration's creation and privacy restrictions are committed **atomically** by the intended migration executor so that there is no interval of visible inadequately protected table state. Preserve the prepared migration's other constraints, indices, columns, ownership model, and S4A storage contract. 014 has not run on the target, so patching its unexecuted source is preferred over an ad-hoc production hotfix; document its new hash and operator migration-integrity implications.
4. Add/extend **isolated PostgreSQL tests**, preferably by extending the existing S4D opt-in integration suite or a narrow test using a *new* verified empty synthetic database. Never rerun destructive setup on populated retained test databases. Apply baseline/013 and corrected 014, then 015/016 in order in the disposable target. With independently scoped roles, verify: ordinary clients cannot SELECT/INSERT/UPDATE/DELETE proposal rows; this denial remains true even when explicit table grants are simulated (RLS defense in depth); the backend owner/authorized role can create, retrieve and transition proposals; preview/apply idempotency, owner authorization and receipt replay still work; 015/016 private table restrictions stay intact. Test catalog ACL and actual attempted SQL operations, not just presence of `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in the source.
5. Run relevant S4/S5 tests, TypeScript and backend build, reporting precise counts and any skipped optional database tests. Preserve all existing mock and integration safeguards. Use synthetic data and mock providers only; no real AI traffic or credit usage.
6. Produce `BACKEND_S4E_014_PRIVACY_HARDENING.md`, recording exact file changes, object-level effective privileges, backend positive-access tests, fresh isolated PG test evidence, migration hash changes, unresolved Supabase role/timezone questions, and explicit go/no-go recommendation for returning to S4E.

## Boundaries — do not do these

- **No live Supabase connection, DDL, grants, migration execution, backup overwrite, or source-data modification.** This task authorizes a source patch and tests only.
- No Render resume/deployment, no feature flag changes, no `MAPPR_DAILY_ADMISSION_ENABLED` activation, and no removal of the unconditional S4 interlock.
- No payment/credit-wallet implementation; retain the approved daily-generation policy and separate future paid-credit seam.
- No new general migration framework, broad security rewrite or repeated S3B backfill.
- No silent change to migration 015/016 or baseline/013 unless a concrete defect is found and reported for separate review.

## Return-to-S4E release gates (do **not** execute here)

After review/approval of the hardened migration source, S4E must still independently verify: fresh Render writer containment; actual hosted backend role and session timezone compared with the pinned migration connection (observed UTC); effective Supabase default grants and RLS; source-table preservation hashes and revision coherence; a **new current pre-014 backup and proven isolated restore**; operator schema/hash allowlist updates; and sequential 014→015→016 live execution with post-migration verification. Any failed gate means STOP. Permission to alter the migration source is not permission to execute it live.

**STOP for review after the source patch, tests and report.**
