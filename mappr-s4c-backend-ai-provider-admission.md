# MAPPR — S4C Backend AI Provider & Preview Admission (Implementation Only)

## Context

Mappr S3 is live on Render with revision-aware backend commit `cc2ee2c564e5fabd7d01c3a0d47aa2bac47f2513`. S4A's Overview `product.summary` preview/apply engine is implemented offline and deliberately blocked for production by a release interlock. S5A's ten-type artifact provenance/guarded publication implementation is also implemented offline, with migration 015 unexecuted. S4B and S5B frontend work have passed offline checks; **frontend and backend are separate VS Code repositories**. The priority is to make the actual Preview → Review → Apply workflow usable, not restart S3 audits or widen the scope to other views.

Read these existing files in the backend repository:
- `BACKEND_S4A_OVERVIEW_PREVIEW_APPLY.md`
- `BACKEND_S5A_ARTIFACT_SAFETY.md`
- `BACKEND_CHANGE_CONTRACT.md`
- Existing `src/services/changes/`, provider/AI client, usage/credit/quota services, generation and iterate handlers, migrations 014/015, tests.

## Goal

Implement a **real, bounded AI provider adapter for Overview summary previews** and prepare the shared preview credit/usage-admission mechanism. Keep the S4 production interlock in place; this task is **not permission to bill users or activate endpoints**. The only enabled change scope remains `product.summary` with `context.activeView='overview'` and `selectedTarget:null`.

## Required sequence

1. Inspect current Git status/diff and repository-specific instructions. Preserve S4A/S5A edits and earlier functionality. Do not overwrite newer files with historical handoff assumptions.
2. Inspect existing provider interfaces, fallback strategy, AI output generation, errors, timeouts/cancellation, daily ceilings, generation/iteration credits, and `generations` accounting. Report *confirmed existing semantics* rather than inventing a credit system.
3. Implement a production-capable **provider adapter** that uses existing approved AI provider infrastructure and the S4A pure Overview prompt/output contract. Output must be a single strictly validated `{summary: string}` with no extra properties. Preserve the server's one-field candidate construction and actual diff validation; the AI must never supply client-writable operations, map IDs or canonical data. Respect the existing provider usage and bounded generation deadline; do not fake progress or call AI during Apply.
4. Ensure preview idempotency remains correct for same-key concurrent attempts, generation success, provider failures, timeouts and ambiguous responses. Avoid repeated provider calls on same-key retry; preserve durable terminal responses and leases. Do not change S4A's map-lock, base-revision conflict detection, immutable proposal, or atomic apply transaction semantics.
5. Analyze and prepare **shared usage/credit admission** covering preview alongside the existing Mappr generation/iteration quota, without introducing a preview-specific bypass. Document required durable reservation/charge/refund/release semantics for successful previews, provider errors, no-op/invalid outputs, retries, expiry, discard, and unknown commit acknowledgements. Do not hard-code pricing, perform real billing, or expose a free production path without explicit product approval. If an adapter/ledger can be added safely behind the interlock without selecting a price, do so with mocks and fail-closed production admission; otherwise provide the smallest precise integration design and reason.
6. Keep the exact `MAPPR_CHANGES_ENABLED` gate and the **unconditional production release interlock** (currently `preview_policy_not_configured`) until a separately approved credit policy, 014/015 schema readiness, S5 live readiness, and rollout are verified. Never enable both flags to work around the interlock, remove the interlock, or allow an unconfigured provider to run in production.
7. Preserve all existing Architecture iteration, Overview Add Component, S2 ownership/Origin enforcement, cookie behavior, S3 revisions, S5 provenance and guarded exports. No additional view support, no frontend edits, no new dependency unless technically required and explained.
8. Add offline tests for provider adapter validation, actual prompt contract, failure/success/timeout handling, fallback behavior if present, same-key idempotency, concurrent preview requests, no-op refusal, quota integration seams, and absence of generation during apply. Use mocks only. Tests must never call real AI, charge credits, or connect to the live DB.
9. Run focused tests, TypeScript no-emit and backend build. Preserve secrets; do not print provider keys, prompts containing user data, operator configs or connection strings.
10. Write `BACKEND_S4C_PROVIDER_ADMISSION.md`: files changed, actual verification, what is production-ready vs blocked, confirmed existing usage accounting, exact remaining product-policy decisions, and clear next rollout order. STOP for review.

## Proposed product policy for later approval — NOT approved by this brief

- Charge **one existing Mappr credit per successfully generated, usable ready preview**; apply is free.
- Do not charge for a failed, timed-out, invalid, or no-op preview. Durable identity prevents double charges on safe replay.
- An expired or discarded **successful** preview remains charged because generation was performed; intentional new preview uses a new identity and may consume a new credit.
- Proposal expiry: 15 minutes (S4A already has a provisional default of 900 seconds).
- Any mismatch between these proposals and Mappr's real credit/quota semantics must be highlighted before implementation or activation. Do not silently assume these defaults are authorized.

## Explicit prohibitions

- No migration 014/015 execution, no source DB mutation, no deploy/push, no Render/env flag changes, no provider requests with real credentials, no credits charged, no actual S4 activation.
- Do not repeat S3 migration/backfill, redesign S5, reimplement the frontend, or widen editing to Architecture/other views.
- Keep legacy functionality and all uncommitted work intact.

## Acceptance

A correctly wired, strictly validated AI adapter can be tested offline through S4A's injected engine without bypassing any production safety interlock; quota/credit admission is either safely prepared behind the gate or has an explicit minimal plan with all open policy questions. Tests/build pass. Hand off and STOP.
