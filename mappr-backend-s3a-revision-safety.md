# MAPPR — Universal Change System
## S3A: Revision-safe canonical writes (backend implementation, no live migration)

**Repo:** Mappr backend only. The frontend lives in a separate VS Code environment.  
**Status:** Implementation task, narrowly scoped. **Do not implement S4 Preview/Apply.**  
**Inputs:** `BACKEND_CHANGE_CONTRACT.md`, `BACKEND_S1_SCHEMA_BASELINE.md`, and the completed S2/S2.1 authorization implementation. The database is currently used only for development/testing, but its existing maps and artifacts must still be preserved.

## Goal

Introduce one authoritative revision sequence for every canonical `maps.data` write. Eliminate lost updates from concurrent legacy Architecture iterations, retain existing response compatibility, and prepare a safe additive schema change for the existing database. **Do not execute any schema/data migrations against the configured application database in this task.** This is S3A; S3B will review and perform the controlled dev-database upgrade after backup/verification.

## 1. Inspect and confirm the current implementation

- Inspect repository instructions, Git status/diffs, and current relevant files first.
- Inspect `src/routes/generate.ts`, `src/routes/iterate.ts`, `src/routes/maps.ts`, `src/routes/diff.ts`, `src/services/architectureIteration.ts`, database transaction helpers, the `map_versions` schema and all `maps.data` writers.
- Confirm S2/S2.1 owner guards remain in place and the live map-read contract remains compatible.
- Use the actual repository as source of truth. If any existing behavior conflicts with the handoff, explain it before changing the design.

## 2. Add an explicit, additive revision migration (prepare, do NOT run)

- Create an appropriately named, ordered migration file without inventing missing historical files (`001`, `003`–`006`) or assuming a working migration runner.
- Add `maps.current_revision` using a non-destructive, staged approach; no default/constraint that would silently misrepresent existing records before backfill.
- Keep `map_versions.version` as the **same single revision sequence**, not a second independent counter.
- Preserve all existing maps, versions, foreign keys, usage records, generated artifacts, and legacy response data.
- Provide an explicit **separate and reviewable backfill procedure** (SQL or script) for S3B. Do not invoke it from app startup, tests, or npm scripts. It must:
  - Lock and re-read each map under a bounded transaction.
  - For maps with no history, create a truthful version-1 snapshot of *their current data* only after requisite validation.
  - For maps with matching history, set `current_revision` to the actual latest snapshot version.
  - Detect and *stop/quarantine* invalid, gapped, mismatched, or uncertain maps; never rewrite historical snapshots, invent former versions, or automatically assign ownership.
  - Be restartable/idempotent and produce a safe summary without exposing map data/secrets.
- Do not make columns `NOT NULL` or add stronger constraints until eligible records are verified and the coordinated writer is ready. State when a later constraint step is safe.
- No access to, creation of, or modification of a separate disposable database is required for this stage.

## 3. Make new generation write revision 1 atomically

- On `POST /generate`, atomically insert the canonical map, its **actual version-1 full snapshot** in `map_versions`, and existing successful usage accounting.
- Set `maps.current_revision = 1` in the same transaction.
- Return an **additive** `revision: 1` field while preserving all prior fields and status codes.
- Ensure failures roll back all relevant writes and do not leave a partially initialized map.

## 4. Make legacy Architecture iteration conflict-safe

- Preserve `POST /maps/:id/iterate` request `{instruction}` and its architecture-only patch semantics; do not change AI prompts or introduce preview/approval here.
- Capture one coherent `{data,currentRevision}` base snapshot before the AI call. **Do not hold a database transaction or row lock while AI runs.**
- Apply/validate the architecture patch against that captured base (using existing service behavior) outside the commit transaction.
- At commit: begin a short transaction; lock the map row; recheck the owner and current revision; if base is stale, return a typed `409 revision_conflict` without changing map data, history, or usage; do not rebase or silently rerun AI.
- If revision matches, allocate `currentRevision + 1`, insert immutable full snapshot/history, update `maps.data`, `maps.current_revision`, and timestamps, and insert successful usage **in one transaction**.
- Preserve the legacy successful `201` response fields `{mapId,version,summary,patch,data}`; `version` must equal the committed canonical revision. An additive `revision` is allowed if consistent with contract.
- Use a small shared canonical commit abstraction **only where it genuinely avoids competing writers**. Do not create a generalized universal-change framework in S3A.
- Avoid publishing an old full-system response as a newer revision. The frontend must still implement the separately planned response-ordering gate before Universal Change launch.

## 5. Read and history compatibility

- `GET /maps/:id` must add a positive `revision` that is transactionally consistent with its returned `data`, preserving the existing fields and shared-link read behavior from S2.
- The historical `GET /maps/:id/versions` and `GET /maps/:id/diff` routes continue using the same version numbers and response shapes.
- Do not fabricate a revision for an unbackfilled map. If an unbackfilled/invalid map is encountered before S3B, fail safely with a clearly identified migration-not-ready condition, or keep S3A code behind an explicit development rollout gate. **Do not accidentally break currently working development routes by silently assuming migration completion.** Document the chosen rollout sequencing.
- Preserve S2 and S2.1 eligibility behavior; do not change shared read permissions.

## 6. Tests (no application database writes)

Add focused tests with existing tooling/mocks for at least:
- New generation: map, version-1 snapshot, and usage are committed together; a failure rolls back.
- Iteration: success increments one revision; two requests from the same base cannot both commit; the loser returns 409 and does not overwrite the winner.
- No AI call under an open database transaction or held map lock.
- Forced SQL failure: no partial map/history/usage state.
- Conflict: no speculative version row, no quota-success entry, no silent regeneration/rebase.
- Concurrent commits against different maps remain independent.
- Owner check still applies, and old successful request/response structures remain valid.
- GET map returns coherent data + revision; history/diff numbering stays consistent.
- Backfill test fixtures cover unversioned, matching, mismatched, gapped, and invalid/unknown-owner cases; the implementation refuses unsafe mutation.
- No test should execute SQL against the existing application database; keep integration tests explicitly gated for later controlled S3B verification.

Run TypeScript and relevant tests once. Report exact executed commands/results, and identify any skipped real-PostgreSQL verification truthfully.

## 7. Release discipline and deliverables

- **Do not run migrations, backfills, or DDL/DML against the existing application database.** No edits to `.env` or secrets. Do not change frontend files, S2 authorization policies, artifact freshness/generation routes, billing policy, AI provider selection, or unrelated Mappr behavior.
- If a fundamental issue makes a safe staged code rollout impossible, stop, report the smallest blocker, and do not improvise a destructive shortcut.
- Produce `BACKEND_S3A_IMPLEMENTATION.md` summarizing: changed files, design choices, preserved behavior, migration/backfill instructions for S3B, tests, residual risks, and the exact order needed to enable it safely on the dev database.
- Stop for user review. **Do not begin S3B, S4, or S5.**

**Acceptance goal:** The backend has a reviewed, revision-aware code path and an additive upgrade plan, but the existing development database remains unchanged until the separate controlled S3B step.
