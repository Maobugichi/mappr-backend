# MAPPR — S3B One-Use Legacy Reconciliation Executor (PREPARATION ONLY)

## Context and confirmed state

The developer has approved all 25 proposed Architecture descriptions and the legacy development-plan policy. Backend Codex has already validated the approved private packet against freshly read, verified development database data (2026-11-07 15:25:13 UTC). Read-only simulation reports 38/38 maps structurally valid, 0 quarantine, 13 candidate maps, 131 string tasks to wrap, and 25 missing node descriptions to add. **These are simulated results; no records have been changed.**

Prior implementations include S2/S2.1 edit authorization, gated S3A revision-safe canonical writes, S3B status/migration/backfill CLI, and a pure `scripts/lib/s3b-reconciliation.mjs` helper with review-packet validation. They are source of truth; verify in the current repository before implementing.

**Goal:** Prepare the smallest explicitly invoked, developer-controlled, one-use reconciliation executor so that these approved 13 legacy maps can later be normalized safely. **Do not run it against any application database in this task.** Do not run migration 013, backfill, enable revision writes, or move to S4.

## Scope

1. Inspect Git status/diffs, project instructions, `BACKEND_S3B_RECONCILIATION_PLAN.md`, `BACKEND_S3B_INVALID_MAP_DIAGNOSTICS.md`, `BACKEND_S3B_CUTOVER_PREPARATION.md`, `BACKEND_S3B_FINAL_READINESS.md`, `BACKEND_CHANGE_CONTRACT.md`, and current actual reconciliation helper, S3B CLI/engine, revision services, map schema, transaction utilities and relevant tests. Preserve all existing uncommitted work.
2. Add a **separate opt-in operator command or narrowly integrated mode** that reads a private approved review JSON **by an explicitly provided path outside the repository** and uses an explicitly verified/pinned target and restricted operator config. Never use an implicit application `DATABASE_URL` or dotenv fallback. Reuse existing target-verification, timeouts, schema, fingerprint, sanitization and approval safeguards instead of duplicating them.
3. Implement a read-only **dry-run/validate** mode first. It must re-read the entire current inventory, verify target, review format, all 13 selected current raw JSONB source fingerprints and stored owners, node context, per-node approvals and task-policy approval using the existing helper. Assert all 13 candidates validate against the unchanged current `MapprSystemSchema`; report aggregate counts only. Reject any stale/changed source, different selected set, schema mismatch, missing/partial approval or unexpected history, not a partial success.
4. Implement a **gated write-capable mode**, but **do not invoke it in this task**. Require separate, explicit developer execution approval (not implied by this brief), verified usable backup/restore evidence, verified quiescent writers, correct dev-only pinned target, explicit exact confirmation token, complete private review validation and stable source recheck before writes. The operator cannot prove external attestations; document how the human supplies/reviews them. Do not include credentials, original data or approval artifacts in logs, chat, Git or report.
5. For each of the 13 approved maps, lock the map row in a bounded transaction, compare exact current raw source (via PostgreSQL JSONB semantics AND the existing source fingerprint contract), stored owner, node context, and lack of unexpected version/history state, validate the complete approved candidate, then update **only** the 131 legacy task paths and 25 missing description paths that apply to that row. Prefer targeted `jsonb_set`/path updates using original database string values, without JS full-payload serialization. Preserve every other JSONB value, map ID, `anon_id`, `created_at`, `updated_at`, history, artifacts and usage. No AI/provider calls or quota charges. Check affected row counts and resulting full schema. Stop safely on any mismatch, SQL failure or unexpected third state.
6. Define deliberate **idempotency/recovery** behavior: if an individual map was already transformed exactly as approved after a previous uncertain commit, recognize it without another write; unchanged original may be applied once; anything else stops. Do not assume a source fingerprint of the old payload will match after successful application. Because maps commit separately, report safe count-only partial progress and how a subsequent authorized run reconciles it. Never rewrite existing snapshots.
7. Make no automatic startup, API route, package lifecycle, deployment or migration hooks. No changes to S2/S2.1 auth, public map reads, canonical writers, current schema requirements, revision flag or migration 013. Keep the new code modest and limited to operator tooling/tests.
8. Write focused offline mock tests for valid dry run, required approvals/refusals, stale fingerprints/owners/context, malformed packet and unknown targets, preservation of all unmodified fields, exact text/order, per-map transaction failure, row lock checks, approval gates before connection/write, no duplicate apply on retry, quarantine before writes, sanitized counts-only output, and no database connection/import side effects. Run TypeScript checks and relevant tests, reporting accurately. Optional real DB interaction is **read-only only** and must use the previously verified private configuration; don't print payloads.

## Stop boundary and handoff

Create `BACKEND_S3B_RECONCILIATION_EXECUTOR.md` with:
- Exact files added/changed and design;
- exact commands for **read-only validation** and **future** gated execution, clearly labeling future execution **NOT APPROVED**;
- aggregate offline test results and any read-only status results;
- exact remaining prerequisites: verified backup and recoverable restore, enumerated and stopped/drained legacy writers, fresh zero-quarantine recheck, independent final execution approval;
- note that reconciliation must precede migration 013 and backfill while writers remain stopped.

**STOP FOR REVIEW. No live writes, no migration 013, no backfill, no revision flag change, no S4.**
