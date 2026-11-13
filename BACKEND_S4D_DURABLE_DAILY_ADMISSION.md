# Mappr S4D durable daily admission

2026-11-11. **Implementation and offline verification PASS. Not deployed or
activated; migrations 014/015/016 remain unexecuted.** No real database, AI,
successful-usage charge or payment operation was performed. STOP for review.

## Approved current policy

This implements the approved **daily successful-generation allowance**, not
purchasable credits. Existing configurable defaults remain 2 successful units
per anonymous identity/day and 200 globally/day.

- One valid, published Overview preview consumes one successful unit. Apply,
  same-key replay and internal provider retries/corrections/fallbacks add none.
- A processing reservation holds capacity. Confirmed provider/validation/no-op,
  timeout, stale-base or publication failure releases that hold without a
  successful unit. Uncertain COMMIT is resolved from durable state first.
- Successful ready previews remain consumed after abandonment/discard, expiry
  or later revision conflict. An intentional new preview is another attempt.
- Ready approval lasts 900 seconds without automatic renewal. The production
  daily-preview adapter refuses a configured non-900 lifetime; existing saved
  responses retain their absolute expiry. The generic TTL helper/test injection
  remains available; it does not authorize a different rollout policy.

There is no wallet, price, money balance, purchase, subscription, checkout,
payment library or paid-credit refund mechanism. The existing typed preview
admission seam remains the narrow extension point for a later entitlement phase.

## Starting state and changes

Inspected Git status, diffs/index and existing source first; read the S4D brief,
S4C/S4A/S5A handoffs and change contract. No applicable repository/ancestor
AGENTS.md was found. Existing uncommitted work and historical handoffs were
preserved. This report supersedes S4C's deferred-ledger/unapproved-daily-policy
statements; its provider and release safeguards remain.

| File | S4D work |
| --- | --- |
| `src/services/dailyAdmission.ts` (new) | Shared reservation, quota locking/counting, settlement, terminal failure, bounded expired-hold recovery, safe errors and compatibility-mode helpers. |
| `src/services/changes/dailyAdmission.ts` (new) | Implements S4C's preview admission seam using the shared durable service; translates errors and enforces approved preview expiry. |
| `src/db/migrations/016_daily_generation_admission.sql` (new) | Additive accounting schema after 014/015; prepared only. |
| `src/services/changes/admission.ts` | Optional recovery hook, called before entering map/proposal transactions. Existing injected fixture seam retained. |
| `src/services/changes/engine.ts` | Production factory selects durable daily admission; provider, saved operations/diff, apply and replay remain intact. |
| `src/services/changes/errors.ts`, `availability.ts` | Attempt-throttle error and neutral release wording/reasons. Exact feature/revision gates and unconditional 503 interlock remain. |
| `src/services/canonicalRevision.ts` | Optional internal attempt passed to initial-generation/Architecture atomic usage settlement. |
| `src/routes/generate.ts`, `iterate.ts` | Reserve before provider and settle inside original revision/legacy transactions; safely resolve failure afterward. |
| `src/routes/adr.ts`, `apiContract.ts`, `critique.ts`, `deployment.ts`, `documentSchema.ts`, `envVars.ts`, `readme.ts`, `relationalSchema.ts`, `requirements.ts`, `traceability.ts` | Same admission lifecycle inside existing S5 guarded publication/usage callbacks. |
| `tests/changes/daily-admission.test.mjs`, `tests/fixtures/daily-admission.mjs` (new) | Accounting/concurrency state-machine tests and shared synthetic SQL fixture. |
| Existing authorization, revision, Overview and artifact test files | Extend real route/engine coverage; preserve earlier assertions and correct quota mock exports/usage row counts. |

No dependency, provider/model, frontend file, existing migration, operator tool,
artifact read/export implementation or canonical change scope was replaced.

## Prepared schema and retained records

Migration 016 creates:

- `daily_admission_policy`: one narrowly versioned `daily-success-v1` policy row
  capturing the migration session's existing PostgreSQL timezone.
- `generation_attempts`: UUID identity, anonymous actor UUID, optional map and
  proposal associations, allowlisted operation, captured day start/end/timezone,
  accounting policy, `reserved/succeeded/failed` state and admission/lease/finish
  timestamps. Preview attempt ID equals its proposal UUID; artifact attempt ID
  equals S5's work/generation UUID. Legacy requests get fresh internal UUIDs.
- Nullable unique `generations.attempt_id`, with a composite FK to the attempt
  and the same actor. All historical usage keeps NULL attempt identity; no
  fictitious backfill is performed. One attempt can create at most one usage row.

Both new tables enable RLS without client policies and revoke PUBLIC access.
The actual backend owner/BYPASSRLS/grants must be verified before rollout.
No anonymous account table exists to reference: the actor remains the existing
signed anonymous-session UUID, without introducing accounts or ownership claims.

Map/proposal deletion can null their attempt associations while retaining usage
and accounting metadata. The usage FK prevents deletion of a referenced attempt.
No automatic metadata purge was added. Proposal tombstones and apply receipts
retain S4A's existing retention. Existing maps, owners, history, artifacts,
generation timestamps and usage rows are not rewritten by this migration.

## Admission and actual lock order

The authoritative count is **historical successful usage + successful usage
associated with this captured bucket + reserved holds in that bucket**. A hold
becoming success stops contributing as reserved in the same transaction that
inserts its single usage row; it is not counted twice.

1. Acquire existing map lock when applicable. Preview then locks its proposal;
   artifact publication/recovery then locks artifact rows in existing ID order.
   Initial-generation reservation has no existing map to lock.
2. Acquire transaction-scoped global advisory lock `(1296126034,0)`, then actor
   advisory lock `(1296126035,hashtext(actor))`. Hash collisions only serialize
   unrelated actors more. The global lock deliberately coordinates all days and
   operation types; no counter cache or quota balance table is needed.
3. For admission, sample the bucket/counts and insert the hold. For settlement
   or recovery, lock/re-read the attempt and make its guarded transition.
4. Commit and release the connection before provider work. There is no provider
   call under a map/quota lock or checked-out database connection.

Admission/recovery transactions explicitly use READ COMMITTED. Counts execute
in a fresh statement after quota-lock acquisition. SQL lock/statement timeouts
are 3s/10s. Callers already holding map/proposal/artifact locks never recover
another map inside that transaction. Recovery discovery and each recovery run
are separate transactions before new reservation.

Initial-generation publication creates its new map/snapshot first, then settles
under quota/attempt locks. Artifact publication acquires its existing parent/
slot locks before the callback settles usage; subsequent provenance attachment
uses those already-held objects. No path waits for a new earlier publication
lock while holding quota locks. All thirteen AI entrypoints share this order.

## Publication, failure and uncertainty

Usage insertion and `succeeded` transition execute inside the existing canonical,
preview-ready or artifact publication transaction. A usage/publication/COMMIT
rollback cannot leave a successful unit. The success UPDATE additionally checks
the database clock against the 180-second lease. A failed/recovered or expired
attempt cannot authorize a late publication; its enclosing writes roll back.
An already-successful identity refuses another publication rather than silently
authorizing a new map/revision without usage.

After a legacy request fails, cleanup acquires the same publication/quota locks,
re-reads the attempt and associated usage/proposal/artifact completion evidence.
A succeeded attempt is retained, including after lost COMMIT acknowledgement.
A reserved attempt with contradictory committed completion evidence fails closed
for review. Cleanup never releases solely on socket disconnect/cancel intent.
If connectivity/locks prevent confirmation, the hold stays reserved and a static
recovery-needed event is logged; there is no guessed refund or blind retry.

Before new work, lazy recovery examines at most 50 expired reserved attempts.
For each, it re-acquires map/proposal/artifact locks as applicable, then quota/
attempt locks, rechecks state/completion evidence and expiry, and atomically
marks failure. An orphaned generating proposal becomes the saved
`generation_timeout` failure in the same transaction. No canonical data, owner,
snapshot or artifact is repaired/deleted by recovery. Current-owner edit access
is not granted by this internal bookkeeping path.

Preview's existing durable key/digest prevents a second reservation/provider
call on replay; terminal outcomes and ready/apply receipts remain immutable.
Lost admission acknowledgement never starts a provider. Lost ready/usage COMMIT
requires observing the original identity; applied replay adds no unit. Legacy
POSTs still have **no client idempotency contract**: a repeat external request
gets a new attempt and may consume another unit. Refetch saved state before an
intentional retry after an uncertain response; no request format was expanded.

## Day rollover and attempt throttling

The bucket uses PostgreSQL's existing `date_trunc('day',...)` boundary. The
timezone is captured, not changed to UTC. Runtime sessions must match the policy
row's timezone or admission refuses before AI. Each reservation records one
database-clock sample, absolute start/end and timezone.

**New work belongs to its admission day even if it publishes after midnight.**
Its usage row retains the existing publication-transaction timestamp default;
accounting follows its attempt bucket. Historical NULL-attempt usage is counted
by original `created_at` within the bucket. A new day's allowance therefore
does not count yesterday's newly completed reserved work twice. A prior-day
hold cannot expand yesterday's admitted capacity or silently move to today.
This explicit rollover extension and effective deployment timezone require
rollout review; they are not a timezone migration or future payment rule.

Separate provisional abuse limits count **all admitted attempts**, successful,
failed or still reserved: `DAILY_AI_ATTEMPT_LIMIT` defaults to 10/actor/day;
`GLOBAL_DAILY_AI_ATTEMPT_LIMIT` defaults to 1000/day. Same-key replay and internal
provider retries do not add attempts. These caps bound failed provider work
without calling it successful usage. Confirm these provisional values during
rollout review. They do not substitute for provider-side cost monitoring.
Invalid/non-finite/fractional limits fail closed; existing successful-unit limits
retain valid nonnegative integer configuration, including zero meaning denial.

Legacy provider behavior is preserved. A provider may still finish server-side
after local failure/lease expiry; no claim of zero provider cost is made.

## Route coverage and compatibility boundary

| AI POST | Durable success boundary |
| --- | --- |
| `/generate` | New map + initial snapshot where revision-aware + usage. Original legacy transaction also participates. |
| `/maps/:id/iterate` | Existing guarded Architecture revision/history + usage; original compatibility path also participates. |
| `/maps/:id/changes/preview` | Immutable validated ready proposal + usage. |
| `/maps/:id/{api-contract,relational-schema,document-schema,readme,adrs,env-vars,deployment,critique,requirements,traceability}` | Existing S5 guarded upsert + exact provenance snapshot/pointer + usage. |

All thirteen are wired; no AI POST gap was found. Apply, GET/export and finding
dismissal PATCH paths do not reserve or consume generation units. Success
payloads, S2 cookie/owner/Origin protections, S3 revision checks and S5 freshness,
owner inspection/current-only export safeguards remain.

New denial errors are sanitized: existing daily/global quota codes retain
429/503; attempt throttling is 429 `attempt_limit_exceeded`, missing accounting
readiness is 503, and expired/duplicate internal work is 409. Preview uses its
existing structured ChangeError envelope and safe retry instructions.

**Rollout flag:** exact `MAPPR_DAILY_ADMISSION_ENABLED='true'` selects durable
admission across existing routes. Default off preserves pre-migration quota SQL
and accounting; no prepared source accidentally requires 016 at startup. In
enabled mode the old advisory precheck is skipped and the durable reservation
is authoritative. Missing schema/configuration fails closed before AI. An
enabled publication missing its attempt token is refused.

Strict concurrency-safe limits are claimed only for the enabled implementation
with **every** budget-sharing writer upgraded. Off/mixed-mode deployments retain
legacy race behavior and are not a completed rollout. Drain writers before any
mode change; do not reopen old unchecked writers around in-flight reservations.

S4's exact default-off feature/revision checks and unconditional
`preview_policy_not_configured` interlock remain. Only explanatory release
wording/reasons now refer to daily-admission rollout instead of unapproved paid
credits. The ledger does not remove the interlock. No runtime flag or environment
configuration was changed.

## Actual verification

TypeScript no-emit and backend build exited 0. Final regression command exited 0:

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/db/schema-baseline.test.cjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs tests/changes/overview-preview-apply.test.mjs tests/artifacts/artifact-safety.test.mjs tests/changes/provider-admission.test.mjs tests/changes/daily-admission.test.mjs
```

**361 tests: 360 passed, 0 failed, 1 skipped.** S4D adds 46 passing cases to the
previous 314. The skip is the optional PostgreSQL integration test; its three
disposable-schema opt-ins were cleared only in the verification process.
Experimental module-mock warnings remain.

Development runs found/corrected an internal-error assertion and an old S2 mock
omitting PostgreSQL's usage-insert rowCount. Final tests cover actual thirteen
route/engine success paths, actor/global mixed-operation races, failed-attempt
caps, preserved historical usage, hold-to-success counting, provider/no-op/
timeout/stale/conflict failure, atomic rollback, uncertain acknowledgements,
free replay/apply, expiry/orphan recovery versus late workers, midnight rollover,
timezone refusal, approved proposal lifetime and continued release interlock.

All database/provider boundaries use synthetic in-memory fixtures or mocked SDKs;
HTTP fixtures bind temporary loopback ports. Mocks do not prove PostgreSQL SQL,
DDL/FKs/RLS, real lock scheduling/rollback/COMMIT, timezone/DST behavior or provider
performance. No database integration test or live HTTP/AI call ran.

Preservation comparison covers 141 pre-existing project files: only the 21
intended route/service/test files changed. Earlier handoffs/briefs, 014/015,
S4C provider/cancellation, S5 storage/read/export modules, dependencies and
operator/recovery tooling are unchanged. `.env`, HEAD and index are unchanged;
configured-secret scan found no matches in new/changed source. Ignored build
output was refreshed. No commit/push was made.

## Isolated PostgreSQL 17 verification plan and release prerequisites

**Single next smallest task:** separately authorize execution/verification of
014/015/016 and real transaction tests in a positively isolated empty PostgreSQL
17 database, using synthetic records and mocked AI. No database was provisioned
or contacted here; this plan has not run.

1. Positively identify the empty disposable target and prove it differs from the
   application target. Reproduce the reviewed baseline/013 with synthetic coherent
   maps/history, then apply 014, 015 and 016 in order. Never substitute Supabase.
2. Verify FK/unique/CHECK/index behavior, retention/deletion actions, historical
   NULL-attempt preservation and actual backend ownership/RLS/grants. Verify
   non-backend roles cannot read/write new private metadata through default grants.
3. Use independent sessions/processes to race different routes at actor/global
   last units. Observe lock order/timeouts and exact successful/held counts.
   Exercise real canonical/preview/artifact publication transactions with fake AI.
4. Inject usage/provenance/COMMIT failures and disconnects around acknowledgements;
   verify once-only usage and durable outcome recovery. Race recovery against
   late workers and owner/map/proposal changes without altering unrelated data.
5. Test historical usage and admitted work across midnight, DST and mismatched
   session timezones; verify query plans/indexes and bounded recovery under backlog.

After that review: confirm rollover/timezone and provisional abuse caps; prepare
recovery evidence and a coordinated additive schema/source rollout covering all
writers. The old S3B operator schema allowlist needs its own reviewed extension
before use with 014/015/016; do not replay old migration/backfill commands.
Verify separate frontend/browser cache ordering, owner cookies, daily-allowance
wording, explicit approval/expiry/retry UX and S5 local export safeguards.
Obtain separate deployment/durable-mode/S4 activation approval; do not remove
the interlock until all schema, daily admission and S5 readiness checks pass.

No live database changes, migrations, AI calls, payments, quota charges,
deployment, feature activation or frontend edits occurred. STOP for review.
