# Mappr — S5A Backend Artifact Safety Implementation

## Context and objective

Mappr's S3 revision-aware backend is live at release `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513`. S4A has implemented an **offline, production-interlocked** Overview `product.summary` change-proposal preview/apply engine with additive migration `014_change_proposals.sql` prepared but not applied. S4B has implemented a **frontend-only** Overview Describe a Change composer with coherent revision-aware canonical state and mocked tests. Neither S4A nor S4B has been deployed or activated.

This task addresses the explicitly identified S5 blocker: generated artifacts may be cached/published/read/exported as though current after a canonical map change, including paths that bypass the backend. Make a *bounded backend implementation* of truthful provenance and safe current/stale artifact access, retaining existing stored artifacts. Do not run another general architecture audit or repeat completed S3 migration preparation.

Read the current backend repo and its instructions, `BACKEND_CHANGE_CONTRACT.md`, `BACKEND_S4A_OVERVIEW_PREVIEW_APPLY.md`, and the actual artifact generators, persistence/read/export routes and caches. The repo is authoritative. Inspect Git status/diffs before editing; preserve unrelated changes.

## Required work

1. Inventory existing *backend* artifact writers, readers, export routes, cache/version keys, and dependency inputs. Start from the ten types listed in S4A's `src/services/changes/artifacts.ts`: API contract, relational schema, document schema, README, ADRs, environment variables, deployment, critique, requirements review, and traceability review. Do not assume every one uses the same provenance or source dependencies.
2. Implement a minimal **explicit provenance record** for artifacts that are newly generated after rollout. Record enough authoritative source information at generation/publication to establish whether an artifact is current: map ID, canonical revision/snapshot where relevant, source/dependency fingerprint for selective artifacts, generator/policy metadata where needed, and generation identity. Use an additive, separately reviewable migration if storage changes are required. Do not apply it.
3. Implement **race-safe publication**: an artifact generated from an old source must not be published or labeled current after that source changed. Validate the source/relationship under proper DB coordination at publication, handling retries/concurrent generation, without modifying canonical map revisions. Use existing repository transaction/locking conventions; do not hold database locks during AI/provider work.
4. Implement a unified **freshness classification** for backend reads: `current`, `stale`, `missing`, or `unknown/legacy` as appropriate, with grounded reasons/source metadata. For legacy artifacts with no verifiable provenance, never claim current. Preserve those artifacts for explicitly requested inspection; do not delete, silently rewrite, or regenerate them.
5. Enforce **current-only exports by default** for backend-supported export endpoints. Explicit stale/legacy inspection may show or download an artifact only with clear stale provenance and never under a current-export claim. Do not break legitimate public/shared read behavior without a scoped contract review. Fail closed on unverifiable currentness.
6. Integrate with S4A's artifact impact/freshness resolver so that an eventual Apply response does not incorrectly claim freshness or overwrite newly published artifact metadata. If the response is only a snapshot, label it accurately. Do not remove S4A's production release interlock.
7. Give a precise **frontend handoff** for client-side exports and artifact caches, which this backend task cannot directly modify. The S4B frontend preserves source-scoped caches but does not enforce all current-only exports. Explicitly list which frontend paths must be guarded; do not claim end-to-end S5 completion until frontend is updated and verified.

## Non-negotiable boundaries

- Preserve existing S2/S3 authorization, session cookies, public/shared map reads, S4A preview/apply contracts and strict Overview-only scope. Do not change billing or preview TTL semantics.
- No provider wiring, quota charging/refunding, credits policy decisions, new change scopes, frontend edits, S4A migration execution, production database updates, deployment or feature-flag activation.
- Keep existing artifacts/records and their history. No full table rebuilds, destructive migrations, automatic backfills, or automatic regeneration.
- Avoid speculative provenance: a revision-agnostic hash is not automatically sufficient; an unchanged canonical revision is not proof of freshness for artifact types whose own dependencies may change.
- Use narrowly scoped changes and existing libraries. No new general artifact framework unless current code demonstrates a concrete need.

## Verification

- Add focused offline tests for source change while generation is pending, simultaneous publication, revision/dependency fingerprint changes, legacy/missing artifacts, current versus stale reads, export denial, permitted explicitly labeled stale inspection, and unchanged S2/S3 behavior.
- Run TypeScript, build, and relevant existing suites; distinguish mock guarantees from real PostgreSQL behavior.
- Prepare any additive migration but **do not execute it**. Do not commit/push/deploy without separate approval.
- Report exactly which artifact types/routes were covered and which remain outstanding, especially frontend exports. Be precise if the full scope cannot be completed in this pass.

## Deliverables

- Focused backend source, tests, optional additive migration.
- `BACKEND_S5A_ARTIFACT_SAFETY.md` — files changed, per-artifact coverage matrix, implemented freshness/publication/export semantics, verified test results, migration/rollout blockers and residual safety gaps.
- `FRONTEND_S5_HANDOFF.md` — actual frontend-facing contract and concrete client-export/cache changes required, without pretending to inspect the separate frontend repository.

Stop after reporting for review. The objective is a real release blocker fixed in code, not another analysis-only planning cycle.
