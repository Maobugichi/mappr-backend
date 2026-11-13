# Mappr S4C provider and preview admission

2026-11-11. **S4C provider integration and admission foundation PASS offline.
Production activation remains BLOCKED.** No live AI, database, billing or
deployment operation was performed. STOP for review.

## Starting point and preserved scope

Inspected Git status/diffs, uncommitted files and preceding activity; re-read
the S4C brief, S4A/S5A handoffs and change contract. The interrupted S4C work had
only inspected source. Existing S4A/S5A implementation and historical documents
were retained. No applicable repository/ancestor AGENTS.md was found.

The only supported change remains `product.summary`, with
`context:{activeView:"overview",selectedTarget:null}`. The validated operation,
actual diff, owner/Origin checks, immutable proposal, revision conflicts, apply
transaction, receipts and S5 artifact resolver remain intact. Architecture
iteration and existing backend routes used by other frontend actions were not
replaced. No frontend files were accessed. No dependency was added.

Earlier handoffs describe their completion-time state. This report supersedes
S4A's unconfigured-provider statement; its release restrictions still apply.

## Implemented source

| File | S4C change |
| --- | --- |
| `src/services/changes/provider.ts` (new) | Lazy shared-provider adapter, strict summary output, bounded deadline and sanitized failures. |
| `src/services/aiCancellation.ts` (new) | Abort-aware waits and retry delay; consumes late SDK rejections. |
| `src/services/aiClient.ts` | Optional cancellation and safe logging for previews; passes signals to Gemini/Groq and disables nested SDK retries for controlled calls. Legacy defaults are preserved. |
| `src/services/changes/admission.ts` (new) | Pricing-neutral reservation/ready/failure interfaces, existing quota precheck and fail-closed default. |
| `src/services/rateLimit.ts` | Optional transaction query client; existing limits, SQL, day boundary and one-argument behavior unchanged. |
| `src/services/changes/engine.ts` | Wires adapter and admission hooks into existing durable lifecycle; default admission refuses new previews. |
| `src/routes/changes.ts` | Uses the wired engine factory; endpoint contracts/guards unchanged. The previous internal factory name remains an alias. |
| `src/services/changes/errors.ts` | Adds sanitized existing-quota errors: 429 `daily_limit_exceeded`, 503 `capacity_exceeded`. |
| `src/services/changes/overview.ts` | Comment clarification only; prompt, policy and validation unchanged. |
| `tests/changes/provider-admission.test.mjs` (new) | Real shared fallback logic over mocked SDK transports, strict output/cancellation/privacy and real quota-helper tests. |
| `tests/changes/overview-preview-apply.test.mjs` | Explicit non-billing fixture admission and provider/lifecycle/rollback/replay coverage; retains previous S4A assertions. |

### Provider behavior

The production engine now selects `overview-summary:shared-ai-v1`. Its adapter
uses the existing `generateStructured` infrastructure, not a separate provider
or model configuration. SDK initialization is lazy until generation; constructing
the change engine does not initialize provider clients.

- Existing Gemini model environment/default is retained. Existing Groq fallback
  order remains `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, then
  `qwen/qwen3.8-27b`. No new model recommendation is made here.
- Existing explicit 429/503 retry delays (1s, 3s), one schema correction per
  provider, strict Groq JSON schema and 6000 completion-token cap are retained.
  Controlled preview calls disable SDK-internal retries so the shared retry
  chain is the single retry owner. Legacy callers retain SDK defaults.
- The adapter uses S4A's prompt, treating the supplied system/instruction as
  untrusted data. Its correction prompt is generic and does not echo provider
  error content. Output must be exactly `{summary:string}`, trimmed, nonblank,
  at most 4000 characters. Extra fields and replacement systems are rejected.
  The server still constructs the sole operation and complete actual diff.
- A total 120-second deadline includes initialization, correction, retry waits
  and fallback. The engine's existing deadline/180-second lease/publication
  clock checks remain. Cancellation reaches both SDKs and stops our waiting,
  retry and fallback chain even if an SDK finishes later.
- New-preview logs use static provider failure/validation events; public errors
  contain no prompts, raw output, credentials or SDK error messages. Exhausted
  provider failure is sanitized as 502; deadline/abort is 504.

Client cancellation cannot prove a provider stopped server-side work or incurred
no cost. Actual provider billing is separate from any proposed Mappr usage unit.
No AI is called during Apply or a same-key replay.

## Confirmed existing accounting

This repository has **daily generation-count quotas, not a paid-credit wallet**.
`src/services/rateLimit.ts` counts successful `generations` rows by anonymous
identity and globally. Environment-configurable defaults are 2 per identity and
200 globally. The SQL day boundary is PostgreSQL `date_trunc('day',now())` in
the database session's timezone; it is not proven to be a UTC billing day.

`POST /generate`, `POST /maps/:id/iterate` and all ten artifact-generation POSTs
check that helper before AI. Successful persistence inserts one `generations`
row in the same transaction as the map/revision/artifact publication. Failures
and finding-dismissal PATCHes do not insert successful usage. Source:
`src/routes/generate.ts`, `src/routes/iterate.ts`,
`src/services/canonicalRevision.ts`, and the ten artifact route callbacks.

The existing helper is a read-only committed-count precheck. It has no durable
reservation, wallet, price, payment/refund system, in-flight-attempt count or
serialized global admission. Concurrent legacy requests can overshoot a ceiling.
Those semantics are preserved, not silently replaced. Legacy HTTP requests do
not acquire the new preview's durable idempotency contract.

## Admission foundation and retry safety

The brief permits a pricing-neutral seam plus a precise deferred ledger design
while policy is unapproved. That is the implemented boundary: **no production
ledger, price, charge, refund, usage insertion or new accounting migration** was
invented. Synthetic ledger hooks are used only in offline tests.

`PreviewAdmissionLedger` defines `assertConfigured`, `reserve`, `ready` and
`failed`. All persistence hooks receive the same `PoolClient` as their proposal
transition. A future implementation must use only that transaction for its
durable accounting, not independently committed/external billing side effects.

| Lifecycle point | Implemented behavior |
| --- | --- |
| New key, valid owned coherent base | Check configured admission, insert generating proposal, reuse existing quota helper on the transaction client, then invoke reservation hook before COMMIT. Failure rolls everything back; no AI starts. |
| Same key/body while processing or terminal | Return the saved state/error/response before any new quota check or reservation/provider call. Different body under the key conflicts. |
| Valid ready publication | Invoke `ready` in the transaction saving the immutable preview. A settlement error rolls back publication. |
| Provider failure, invalid/no-op, timeout or pre-ready revision conflict | Invoke `failed` with the durable terminal transition. Hook failure rolls both back; lease recovery does not regenerate. |
| Lost admission COMMIT acknowledgement | Do not call AI; reuse the same key to discover the reservation, then fail an expired processing lease without takeover. |
| Uncertain ready COMMIT acknowledgement | Do not assume rollback/refund or regenerate. Same-key retry reads the saved ready response, or waits for the still-generating lease to resolve. |
| Apply/replay, ready expiry or later apply conflict | No new provider or admission hook. S4C does not choose whether an already-ready attempt is refundable. |

Map-first/proposal-second locks, no held connection during AI, guarded ready
UPDATE, saved terminal outcomes and atomic apply remain unchanged. Ledger hooks
are called once per committed transition under that discipline; tests verify
transaction coupling, not a nonexistent production ledger. Owner changes can
leave an inaccessible processing attempt; a future privileged recovery path must
release it safely without assigning ownership or granting edit access.

The default `blockedPreviewAdmission` rejects new attempts with
`preview_policy_not_configured` **before proposal insertion, quota reads or AI**.
`src/services/changes/availability.ts` is unchanged: exact default-off
`MAPPR_CHANGES_ENABLED`, revision readiness, then an unconditional production
interlock. Neither environment flag nor a provider key bypasses it. Both Preview
and Apply remain blocked. Offline tests explicitly inject admission/readiness;
HTTP callers cannot select those dependencies.

### Smallest deferred durable integration

After product approval, implement and separately review one shared admission
mechanism for Preview and all twelve existing AI entrypoints:

1. Add a durable attempt table with actor/map binding (nullable map for initial
   generation), unique preview proposal association, operation kind, state,
   admission/lease/finish timestamps and accounting-policy version. Preserve all
   existing usage rows. Add a nullable unique attempt reference to `generations`
   for exact-once future successful-usage association. Names/schema remain a
   proposal, not prepared or executed migration SQL.
2. Serialize shared global-then-actor daily admission briefly. Count committed
   `generations` plus active holds, without double-counting settled attempts.
   A quota precheck alone is insufficient. Integrate generation, Architecture
   iteration and all ten artifact publishers before claiming strict shared
   ceilings. No provider runs while a budget/map/proposal lock is held.
3. Extend existing map/proposal/artifact lock order consistently with budget and
   attempt locks; never hold a budget lock while waiting for an earlier map or
   artifact lock. Non-map initial-generation admission uses only the shared
   budget/attempt sequence. Retry/recovery must obey the same order.
4. Commit the approved successful usage unit with ready publication, and release
   a processing hold with failure, using the lifecycle hooks. Preserve immutable
   receipts and exactly-once uniqueness. Never infer release from an uncertain
   COMMIT; query durable identity first.
5. Recover expired/orphan processing holds only after rechecking the proposal
   under the same locks. A late worker cannot publish after recovery. Separate
   attempt/abuse limits are needed because failed provider work still costs
   resources. No cleanup may erase key tombstones or applied receipts early.

This durable shared-ledger work is **not implemented** by S4C. It depends on the
policy decisions below; there is no permissive production fallback meanwhile.

## Product decisions still requiring approval

The brief/change contract's one-credit recommendation is **not approved** and
does not match an existing monetary balance service. Confirm:

- Whether one ready preview consumes one unit of the existing daily allowance
  or a different entitlement, and how global capacity is reserved.
- Charge point and failure treatment: provider error, timeout, invalid/no-op
  output, stale base and failed publication; how provider cost is observed
  separately and how repeated failed attempts are capped.
- Whether a successful preview remains consumed after abandonment, discard,
  expiry or a later apply conflict; whether a replacement gets any allowance.
- No additional unit for internal correction/fallback, same-key retry/replay or
  Apply under the recommendation; agree on exact UI wording before release.
- Reservation/day rollover semantics and timezone, especially a preview admitted
  before midnight but published afterward. Keep abandoned processing-hold
  recovery distinct from refunds of an already-ready preview.
- Proposal lifetime: existing configurable provisional default is 900 seconds,
  not product approval. Returned expiry and S4A's no-auto-renewal behavior remain.

## Actual verification

Focused provider/Overview suites: **81 passed, 0 failed**. After adding failure-
settlement rollback, uncertain-admission and late-rejection checks, the final
source passed these commands (exit 0):

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs tests/artifacts/artifact-safety.test.mjs tests/changes/provider-admission.test.mjs
```

Final result: **315 tests: 314 passed, 0 failed, 1 skipped**. S4C adds 25 passing
cases; existing 289 passing cases remain. The skip is the optional PostgreSQL
integration test; all three disposable-schema opt-ins were cleared in the test
process. Experimental module-mock warnings remain.

Tests use synthetic credentials/data, mocked SDK transports and database clients.
They cover actual shared provider fallback/correction, strict schema/prompt,
safe logging, cancellation and late rejection, concurrent same-key identity,
quota denial before generation, once-per-transition notifications, settlement
rollback and lost acknowledgements. Existing S2/S3/S4A/S5A suites remain passing.

No real provider, PostgreSQL, billing or deployed HTTP endpoint was contacted.
Mock results do not prove live model availability/quality, provider-side
cancellation/cost, real DDL/privileges/lock timing, or browser behavior. No
production readiness or completed ledger integration is claimed.

Preservation checks compare all 135 pre-existing project files: only the seven
intended existing files in the source table changed. S5A sources, migrations
014/015, availability/TTL, authorization, revision/operator tooling, earlier
documents and dependencies are unchanged. Local `.env`, Git HEAD and index are
unchanged; ignored build output was refreshed. No commit or push was made.

## Remaining release order

1. Review this implementation and approve the exact usage/expiry/failure policy.
2. Implement/test the shared durable admission and recovery mechanism across all
   budget-sharing routes. Retain the interlock until it is complete.
3. Under separate authorization, verify 014/015 and future accounting schema plus
   real concurrency/recovery behavior in an explicitly isolated PostgreSQL
   target. Prepare a reviewed additive live rollout; no migration ran here.
4. Confirm S5 backend/live and separate frontend safeguards, including local
   export gating, owner inspection, cache invalidation and revision ordering.
   Confirm `product.summary`, `overview`, explicit null target and preview credit
   UX. Existing receipts must never overwrite a newer canonical/cache revision.
5. Obtain separate source release, deployment and activation approval. Replace
   the unconditional interlock only in that reviewed rollout, after schema,
   policy, admission and artifact readiness checks; perform approved smoke tests.

No live database changes, migrations, credits charged, live AI calls, deployment,
flag changes, frontend edits or additional change scope occurred. STOP for review.
