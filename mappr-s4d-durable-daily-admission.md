# MAPPR — S4D Durable Shared Daily Usage Admission (Implementation Only)

## Objective and decision already approved

Mappr will **add payments and purchasable credits in a later product phase**, but **not in S4D**. Do not implement a wallet, payment provider, prices, money balances, subscriptions, checkout, refunds, or a permanent monetization architecture here. For now, keep Mappr's existing **daily successful-generation allowance** and make its accounting safe across concurrent requests. Keep the extension points narrow so a later credits/payment entitlement can be introduced without rewriting the Preview → Apply lifecycle.

The developer approved this **current-phase policy**:

- A successfully generated, valid, published Overview change **preview** consumes **one unit** of the existing daily generation allowance.
- **Apply** consumes **zero additional units**. Same-key retries/replays, internal model retries/fallbacks and internal correction consume **zero additional units**.
- Provider errors, deadline/timeout, invalid/no-op responses, stale base and failed ready-publication do **not consume a successful-generation unit**. Reserve capacity while work is in progress, then release it safely on confirmed terminal failure. Provider costs and failed-attempt abuse limits are separate from successful-usage accounting.
- A successfully published preview remains consumed if discarded, abandoned, expired, or made obsolete by a later revision. Creating an intentional replacement preview is another attempt and, if ready, consumes another unit.
- Proposal approval window: **15 minutes** after ready publication (900 seconds), no automatic extension. Preserve the existing absolute-time expiry contract and immutable replay semantics.
- Preserve existing daily quotas and configuration semantics unless evidence shows a defect that must be addressed to implement safe accounting. S4C observed current defaults of **2 successful generations per anonymous identity per day and 200 globally**. Do not rename them to paid credits in API/UI wording.
- Current daily allowance is **not the future paid-credit model**. Explain the separation in the handoff.

## Start by understanding the current repository

1. Inspect Git status/diff/index and applicable repository instructions. Preserve S2/S3, S4A/S4C, S5A, existing operator tools, untracked handoffs and unrelated changes.
2. Read `BACKEND_S4C_PROVIDER_ADMISSION.md`, `BACKEND_S4A_OVERVIEW_PREVIEW_APPLY.md`, `BACKEND_S5A_ARTIFACT_SAFETY.md`, `BACKEND_CHANGE_CONTRACT.md`, and this task brief.
3. Inspect actual `generations` and anonymous-session schema, `rateLimit.ts`, the preview admission seam, proposal/receipt state transitions, and **every existing AI entrypoint**: initial `/generate`, Architecture `/iterate`, and all **ten** artifact-generation routes. Identify each existing success/rollback/usage transaction; don't guess from handoffs.
4. Check the existing prepared 014 and 015 migrations and their relationship to a new additive accounting migration. Preserve existing records and public response formats.

## S4D scope — implement one durable, shared admission system

Build the minimum PostgreSQL-backed admission/reservation/settlement mechanism needed to make daily quotas concurrency-safe across **all twelve existing AI generation routes plus Overview change preview**.

### Data model and policy boundary

- Prepare a new **additive migration**, sequenced after existing prepared 014/015 (normally `016_...sql` if available). Do **not** run it. Store durable attempt identity, anonymous actor association, optional map/proposal association, operation kind, captured quota day/bucket, state, timestamps/lease, and narrowly versioned accounting policy. Maintain FK/uniqueness/retention and preserve all existing `generations` rows. Add a nullable unique attempt reference to new successful usage where appropriate, if coherent with the real schema.
- Keep successful usage count compatible with existing `generations` history. Prevent double-counting an attempt that transitions from an active hold to recorded success. Do not backfill fictitious attempt identities onto historical usage.
- The successful-usage accounting should be **one committed unit for one committed successful generation/publication**, in the same transaction as the canonical map revision/proposal-ready/artifact publication and its existing usage row. Failed/rolled-back publications cannot leave a successful unit.
- The allowance day/bucket and rollover behavior must be explicit and consistent with Mappr's current SQL daily boundary. Record the bucket at reservation so work crossing midnight cannot silently escape limits or double-charge. Document the resulting rule and any required separate policy approval; do not silently redefine the app's current quota timezone.
- No payment/monetary balance tables or billing library. Provide a small, typed, versioned admission interface that later supports a different entitlement mechanism, without speculative payment abstractions.

### Atomic concurrency / lock discipline

- Serialize shared **global and actor** quota admission in a clearly documented, consistent lock order. Count historical committed successful usage plus currently active reservations, without double-counting settlements. Concurrency across Preview and the twelve preexisting routes must not exceed the configured ceilings.
- Design a deadlock-safe lock order with the existing map-first, proposal-second, artifact-slot and version-history transactions. **Do not hold a quota lock or a database connection during provider calls.** If retaining existing lock order is incompatible, make a narrow justified change and cover the ordering with adversarial tests; do not rebuild the entire application.
- Reserve capacity durably **before** calling the provider. A duplicate durable preview idempotency key/body may only observe/replay its existing attempt and must not create another hold or provider invocation. A different body under the same key must still conflict.
- Make commit acknowledgment uncertainty recoverable through durable attempt/proposal/publication identity; never assume an uncertain COMMIT rolled back. New preview has immutable keys. Legacy endpoints do **not** currently have client idempotency contracts: do not falsely claim repeat external requests are automatically deduplicated or change their public request formats silently.
- Finalize success exactly once within the existing successful publication transaction. On confirmed provider/validation/conflict/timeout failure, atomically terminate the attempt and release its active hold. Do not release a hold solely because a client disconnected or a server-side provider cancel was requested: verify terminal state first.
- Add bounded processing leases and **safe orphan/expired-hold recovery** so crashes do not block quotas permanently. Recheck canonical/proposal/artifact state under the same documented locks before releasing or expiring; a late worker must never publish successfully after its reservation was recovered as failed. Preserve proposal tombstones and replay receipts.
- Include a separate configurable **failed-attempt / provider-cost abuse limit** that counts attempts, not successful-generation units. Propose defensible provisional limits and document them as pending rollout review; do not enable unlimited free provider attempts. Do not invent wallet charges for failed requests.

### API, authorization, and existing behavior

- Connect S4C `PreviewAdmissionLedger` reserve/ready/failed hooks to the durable implementation, preserving S4A summary-only scope (`product.summary`), explicit Apply approval, 15-minute ready expiry, original diff, idempotency and revision conflict handling.
- Integrate the same shared admission/reservation/settlement across `/generate`, `/iterate`, and all ten artifact generation POSTs, including the existing S5A guarded-publication and usage-transaction boundaries. Keep the current successful output payloads, generation semantics, billing-free Apply, and S2 owner/origin protections.
- Quota denial must happen before provider work and preserve the established error conventions (e.g. existing daily/global limit behavior and S4C's sanitized 429/503 forms). No leakage of secrets, raw AI instructions, actor IDs, or database details.
- Keep the unconditional **S4 production release interlock** and default-off `MAPPR_CHANGES_ENABLED` intact. Do not enable new previews or deploy merely because the ledger is implemented. Existing functional AI routes must not be accidentally disabled, and the S3 revision gate cannot be bypassed.
- Keep artifact GET freshness/owner-only inspection/current-only export protections intact. Do not edit frontend code in this backend task.

## Tests and acceptance criteria

Use synthetic data, mocked provider transports, and mock database boundaries for offline regression. Run TypeScript no-emit, backend build and the relevant existing S2/S3/S4/S5 tests, including new accounting tests. Test at least:

- Racing attempts from one actor, different actors and globally across *different operation types* at the last remaining quota unit; only permitted reservations succeed.
- No provider starts on quota denial; no quota/database lock is held during AI; no double-counting of active hold + settled successful usage.
- Normal success, invalid/no-op/provider timeout, stale preview, artifact source/publication conflict, transaction rollback at usage+publication stages.
- Same-key preview replay and duplicate concurrent submissions, lost admission COMMIT, lost ready/usage COMMIT and apply replay; zero additional unit for Apply.
- Lease expiry/recovery vs late worker; day rollover with an in-flight attempt; preservation and counting of preexisting historical `generations` records.
- Failed-attempt throttling; strict scopes, session/owner/Origin checks, 15-minute proposal expiry and persistent successful usage after discard/expiry.
- S5A artifact publication and unchanged API/Architecture generation behavior.

Prepare migration tests and a short isolated PostgreSQL 17 integration test plan for real lock/DDL/FK verification. **Do not** run against the live Supabase development database or assume mocks prove real isolation. If an isolated database is not available, report exactly what remains unverified; do not block completion of the offline implementation on unrelated infrastructure work.

## Hard boundaries

- **No real database writes, live migrations, live provider/AI calls, real quota charges, Render or frontend deployment, flags enabling S4, or S4 scope expansion.** Do not modify the currently deployed S3 revision data.
- Do not implement paid credits, prices, payment processing, refund wallet, subscription or checkout logic in this phase.
- Do not modify existing private config, `.env`, secrets, cookies, recovery archives or historical artifacts.
- Minimize dependencies and abstractions; preserve working functionality and uncommitted work.
- If any requirement creates an unresolved architectural conflict (especially deadlocks, transaction coupling or legacy-route semantics), isolate it, explain the smallest safe alternative, and stop rather than weakening invariants.

## Required output

Write `BACKEND_S4D_DURABLE_DAILY_ADMISSION.md`, detailing:
1. What was implemented and exact files/migration prepared.
2. The real lock order, quota counters, processing holds, rollover and crash-recovery behavior.
3. Exact route coverage and any remaining gaps; separate completed code from mocks and proposals.
4. Actual commands and test counts; real PostgreSQL items not yet verified.
5. How daily allowance is kept separate from **future paid credits and payments**.
6. Remaining rollout prerequisites (014/015/new accounting migration, frontend/live browser integration, S4 interlock/activation) and the **single next smallest task**.

Then **STOP for review**. Do not push, deploy, execute migrations or start S4 live.
