# Mappr S3C — Revision-Safe Runtime Activation & Render Handoff

## Context and verified current boundary

The developer reports that S3B migration 013 and backfill have **committed successfully** to the Supabase development database. The final verified state is 38 coherent maps (35 at revision 1, three at revision 2), 41 snapshots total (six originals preserved and 35 added), contiguous history, latest snapshot equal to canonical JSONB data, and zero quarantine (`revisionReady:true`). The revision-write feature gate is still **OFF**. Render service `mappit` remains suspended; the local backend is not running; Supabase Data API was disabled. Existing backup and recovery evidence is preserved.

The immediate goal is to **prepare and verify an activation plan that will never restart a legacy/off writer after the migration**. This task is limited to backend repository verification, offline tests, and a deployment/activation handoff. The user's prior approval covers migration 013 and backfill only; it does **not** authorize changing Render settings, deploying, resuming services, starting writable servers, or live API mutations. Stop at that boundary.

## Step 1 — Current repo and writer implementation

- Inspect current Git branch/status/diff and project instructions first; preserve all prior code and reports, including untracked S1/S2/S3 work. Determine whether the S3A/S2/S2.1 implementation has been committed and pushed, and whether Render is linked to the repository/branch containing it. Don't assume local source equals Render's deployed build.
- Inspect `src/services/canonicalRevision.ts`, `src/db/revisionTransaction.ts`, `src/routes/generate.ts`, `src/routes/iterate.ts`, `src/routes/maps.ts`, `src/index.ts`, the actual package scripts, TypeScript/build output, and all other canonical-data writers. Confirm the exact `MAPPR_REVISION_WRITES_ENABLED=true` gate and that legacy writers remain active if it is missing/off.
- Confirm the current code's behavior with post-backfill `current_revision`, coherent GET reads, atomic version-1 generation, and conflict-safe iteration. Check S2 ownership/origin and S2.1 eligibility haven't regressed. Identify any startup-time database changes or auto migration/backfill hooks (none should be introduced).
- Examine Render's existing build/start commands and branch only from files/evidence actually accessible; if provider control-plane details are unavailable, state precisely what the developer must check on the `mappit` service dashboard. Do not claim Render has received the new code or environment flag.

## Step 2 — Offline verification, no live writes

- Run TypeScript compile, backend build (if applicable), and the relevant S2/S2.1/S3A/S3B mocked suites once. If failures occur, investigate only concrete regressions. Do not run database-mutating tests or AI calls.
- Verify that `npm start` uses *freshly built* output, not stale `dist` from before S2/S3. Do not start an HTTP server that can write to Supabase while the runtime flag is off.
- Optionally run a strictly read-only post-S3B status query (existing pinned operator only) if needed and connectivity permits; record it as an inspection, not activation. Do not create any generation or iteration smoke test records in this task.
- Assess whether existing frontend clients are compatible with additive `revision` fields and 409 `revision_conflict`/503 `revision_not_ready`; note that the separate frontend must enforce high-water revision ordering, not blindly replace newer state with stale responses. Do not edit the separate frontend repo from here.

## Step 3 — Produce a safe, concrete activation sequence

Write a minimal operator runbook keyed to the actual project setup:

1. Freeze canonical writes; independently verify the known Render `mappit` and local instances remain suspended/off, and that no hidden worker/direct SQL writer is known. Keep Supabase Data API disabled unless a later approved change is required.
2. Verify the post-backfill source state is `revisionReady:true`, 38 maps, 41 snapshots, no invalid/null revision, contiguous histories, current data = latest snapshot; preserve backups and original recovery evidence.
3. Identify the exact reviewed Git commit/branch that includes all S2, S2.1, S3A, S3B prerequisites and passes a clean build and tests. Confirm it is pushed to the branch Render will deploy. If not, report precise missing steps without pushing or committing without permission.
4. Stage/configure `MAPPR_REVISION_WRITES_ENABLED=true` **for every future writer, including Render and any local development launch**, before accepting any mutable request. Make sure the enabled value is the literal string `true` at process startup. Never start the old/off binary against the migrated DB. There is no safe blanket rollback to an off writer after migration.
5. Render deployment must build the **reviewed current source**, not merely restart the old deployment or redeploy a stale build. Verify service commit SHA and actual build/start commands; avoid `Restart service` or a save-and-deploy-existing-build operation as a substitute for building new source. If Render cannot safely replace a suspended service without exposing a legacy instance, **STOP** and request a specific deployment plan that preserves write quiescence. Do not assume its platform behavior.
6. Once the new revision-aware instance is live and all others are known safe, verify the active commit/flag through reliable operational evidence and perform *read-only* credentialed/public GET smoke tests: GET map returns coherent positive revision, history/diff shape unchanged, owner eligibility correct, public shared-link reads preserved; 503/not-ready and 409 handlers covered by offline tests. Don't invent a public flag endpoint or expose secrets.
7. Only with separate approval run one bounded live generation/iteration/concurrency smoke test if necessary (may create records/consume AI quota); never perform it under this task's permission.
8. On failed cutover, keep mutable requests blocked, investigate/reconcile current revisions and deployment. Do not disable the gate and resume legacy writers, drop column/history, or automatically restore data over newer changes.

Render docs note that `Restart service` uses the same commit/configuration as the currently deployed instance and that environment-variable save/deploy options differ. Treat this as a verification requirement rather than assuming deployment has occurred:
- https://render.com/docs/deploys
- https://render.com/docs/configure-environment-variables

## Deliverable and stop boundary

Create `BACKEND_S3C_REVISION_ACTIVATION_HANDOFF.md` containing:
- What is implemented and actually verified versus unavailable evidence.
- Exact Git commit/branch/build status and whether Render can deploy that revision.
- Offline test/build results and any blockers.
- Concrete steps for the developer to configure/deploy/resume `mappit` *with revision writes enabled before accepting mutations*.
- Checklist for local backend launches with the same gate.
- Post-activation smoke verification and a fail-safe incident plan.

**Do not** modify Supabase data, change feature flags, commit/push code, deploy/resume Render, start local backend writers, re-enable Data API, or begin S4. Stop for review and request separate deployment/activation authorization.
