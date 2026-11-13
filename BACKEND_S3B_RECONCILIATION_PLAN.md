# Mappr S3B targeted reconciliation plan

Date: 2026-11-07. **Preparation complete; NO-GO for database reconciliation or S3B
cutover.** Proposed transformations and approval validation are prepared and
tested. The private review packet contains 25 blank, unapproved descriptions.
No database records, revision flags, migrations, or application behavior changed.

## 1. Scope and verified current findings

Inspected Git changes and repository/ancestor instructions first; no applicable
AGENTS.md was found. Read the reconciliation brief, diagnostics, final readiness,
preparation/S3A handoffs, schema and existing status/backfill implementation.
Preserved unrelated tracked and untracked work.

A fresh inspection used only the existing verified private development config,
checked against the effective application connection and pinned target/role.
No implicit DATABASE_URL fallback was used. TLS policy was preserved.
Snapshot timestamp: **2026-11-07 13:20:45 UTC**.

The PostgreSQL transaction was READ ONLY / REPEATABLE READ, with 10s statement,
1s lock and 30s idle-transaction timeouts; it ended with ROLLBACK. Default
isolation remained READ COMMITTED. Private row/context data was not printed.

| Actual database state | Result |
| --- | --- |
| Maps / structurally valid / invalid | **38 / 25 / 13**, unchanged counts |
| Current classifications | **22 initialize, 3 match, 13 invalid_system** |
| History rows / invalid history rows | **6 / 0** |
| current_revision column | Absent |
| Revision writes | Still disabled |

Counts are current observations, not assumptions copied from the earlier report.
They do not establish that all external writers are stopped.

## 2. Files prepared and execution boundary

| Project file | Purpose |
| --- | --- |
| scripts/lib/s3b-reconciliation.mjs | Small pure normalization, preservation, review-packet and approval-validation helper |
| tests/revisions/s3b-reconciliation.test.mjs | Offline fixtures for transformation, unknown-shape refusal, approval and stale-source checks |
| BACKEND_S3B_RECONCILIATION_PLAN.md | This plan and verification results |

The helper has no filesystem, database, environment, provider or logging access.
It is not imported by application startup/routes or the existing cutover CLI.
It returns private in-memory candidates only; it cannot save or apply them.

No existing application schema, route, worker, middleware, migration, operator
CLI, dependency, environment, deployment, report, or contract was changed.
S2/S2.1 authorization and shared-link reads remain untouched. No runnable
reconciliation write mode was added.

## 3. Proposed task transformation and structural diff

Only a legacy task string is wrapped:

    existingText -> { description: existingText, relatedFeatures: [] }

Text is copied exactly, including whitespace, line breaks and Unicode. Phase/item
order and all other fields are retained. Already valid object-format tasks,
including their recorded references and extra fields, remain unchanged.
Unknown/malformed task/system shapes are rejected rather than repaired.

The helper uses the actual current MapprSystemSchema. It accepts the diagnosed
legacy task-string errors and absent node descriptions for preparation; it does
not relax the final validator or treat the missing descriptions as resolved.
After normalization, every candidate is checked against the unchanged schema.

The private plan includes one structural change record per wrapped item:
exact array path, string -> object, fields description/relatedFeatures, preserved
text, and zero recorded references. It contains no task prose. To check non-target
preservation, the helper reverses only declared changes in a clone and compares
every remaining JSON value structurally with the source. Task strings are also
compared as UTF-8 bytes during the real-data dry run.

**Policy for approval:** relatedFeatures:[] means **no relationships recorded in
the legacy source**, not no conceptual relationships. No feature IDs are inferred
from prose or invented. This is the brief's proposed maintenance policy; its
review-packet approval flag remains false. It does not recreate missing
historical relationship information or improve dependency semantics.

## 4. Aggregate read-only simulation results

| Check | Actual result |
| --- | --- |
| Affected maps / string tasks wrapped in memory | **13 / 131** |
| Exact string bytes and order retained | **PASS** |
| Existing object-format tasks checked / retained unchanged | **267 / 267** |
| Non-target fields structurally preserved | **PASS across all 38 candidates** |
| Repeated task normalization | **PASS: identical candidates, no further changes** |
| Invalid maps made valid by task wrapping alone | **10** |
| Maps still invalid after task wrapping | **3**, requiring **25** descriptions |
| Source fingerprints captured in the private plan | **13** |
| Blank suggested / approved descriptions | **25 / 0** |
| Missing policy approval rejected | **PASS** |
| Policy-only approval with missing descriptions rejected | **PASS** |
| Current rows, timestamps and history unchanged in the captured snapshot | **PASS** |

The real database still has **13 invalid maps**, not three: no candidate was
applied. No descriptions were populated even in the actual-data simulation.
Complete approved candidates were tested only with synthetic descriptions in
offline fixtures.

Original source objects were compared before/after, and current/history rows
were re-read inside the same read-only snapshot and compared. This verifies our
preparation preserved the captured data; it does not prove other sessions are
quiescent. Artifacts and usage were not written or regenerated.

## 5. Private Architecture description review

Created a new, non-overwriting packet in the existing restricted operator
directory, at the explicitly selected path:

    C:\Users\HomePC\AppData\Local\Temp\mappr-s3b-final-5c646e43b5b04ec686d93afb05b94a93\legacy-reconciliation-review.json

Directory inheritance is disabled and file permissions were verified as
current-user-only. Packet contents were not printed, added to Git, or transmitted
externally. Keep it private; no upload or copying into repository documents is
needed. Temp cleanup may remove it.

The packet contains:

- A target fingerprint and 13 selected map references/source fingerprints plus
  task structural diffs. No owner IDs or complete source payloads are included.
- Architecture context for only **3 maps / 25 missing-description nodes**:
  private map/node references, existing label/type, and incident relationships
  with neighboring references/labels/types and existing edge labels.
- For each description: blank suggestion, manual-entry-required state, blank
  proposedDescription, new_proposed_content origin, and approved:false.
- The explicit unrecorded-reference policy with approved:false.

**Human workflow:** use this private packet locally; preserve source/context and
target fields. Enter a meaningful description grounded in each node's existing
role/relationships, adding trusted developer input when context is insufficient.
Every supplied description is **new proposed content**, not a recovered original.
Leave unresolved entries unapproved. Review the exact text and approve each of
the 25 individually; separately acknowledge the task-reference policy.

No automatic descriptions, label/ID copies, empty filler, AI calls, usage charges
or external content were introduced. If more context is needed, request a
separately reviewed private context expansion, not invented services, technologies
or behavior.

Approval flags are private operator attestations; they do not prove a human's
identity, grant S2 editing permission, or authorize database execution.

## 6. Approval validator and stale-source refusal

validateReconciliationReview returns candidates only after checking:

1. Exact supported packet shape/version, correct target and approved task policy.
2. Exact selected source set and declared task changes; no unknown, duplicate or
   omitted map/node targets. Ambiguous node IDs in affected context are rejected.
3. Source fingerprints still match freshly supplied records. Each fingerprint
   includes target, map reference, owner metadata and the exact server-returned
   data::text JSONB representation. Raw text is checked against the parsed data
   before capture; no source text or owner metadata is published.
4. Unchanged node labels/types/relationship context, all required per-node
   approvals, and string descriptions. Blank, ID-only and label-only filler is
   rejected by the review policy.
5. The complete candidate passes the actual current MapprSystemSchema and has
   only the declared task wrapping and missing-description additions.

Thus changes to source JSON, owner metadata, target, or context invalidate review.
No raw Zod messages or private values are included in helper errors. A future
executor must re-read under lock; validation of today's packet alone cannot
prevent later changes.

## 7. Smallest later executable reconciliation: design only

Do not add repair behavior to /iterate or backfill. A later separately reviewed,
one-use maintenance driver should:

1. Require explicit developer execution approval, the verified private target,
   completed usable backup/recovery evidence, and confirmed stopped/drained
   canonical writers. Keep all legacy/revision-aware writers coordinated and
   stopped through normalization and cutover.
2. Preserve the exact original selected JSONB/owner/timestamp evidence in an
   approved, restricted recovery artifact before any writes. Today's minimal
   review packet is **not** a full-data backup.
3. Re-read each selected map under lock in a bounded transaction. Match the
   reviewed raw source fingerprint/JSONB value and owner metadata, require no
   unexpected history/counter state, and run the complete approval validator.
   Any unknown/stale/incomplete record stops the process; do not skip it while
   claiming global readiness.
4. Apply only approved paths. Prefer targeted JSONB path updates: wrap each
   approved string using its exact database value and add only approved missing
   descriptions. Do not reserialize entire payloads from JavaScript, which
   could change unrelated JSON numeric representation. Check full candidate
   validity and unchanged non-target data before commit.
5. Preserve IDs, owners, created_at/updated_at for this bookkeeping operation,
   all unrelated canonical fields, existing snapshots, artifact rows and usage.
   Do not call AI, count a user iteration, invent historic revisions, or bill
   usage. Retained artifacts are not newly certified fresh by normalization.
6. Keep original/candidate evidence recoverable and record count-only progress.
   For an uncertain commit, reconcile the locked row with the captured original
   and exact approved result: apply once, recognize already-applied state without
   another write, or stop on any third state. Existing review validation fails
   on a changed source; it is not itself an apply-retry receipt.

For this still-pre-013 database, normalize approved canonical records **before**
migration 013 while writers remain stopped and the gate remains off. Then re-run
full current/history validation and zero-quarantine status. Only after a separate
approved cutover instruction apply migration 013 and backfill truthful initial
snapshots of the now-valid canonical state. Preserve existing six snapshots;
do not manufacture snapshots of invalid data or pretend that normalization is
the original historical generation event.

If the inventory remains unchanged and all descriptions are approved/resolved,
35 initializations / 3 matches / zero quarantine would be an expectation to
verify, **not a result observed here**. Enable revision-aware writers only after
backfill/readiness succeeds on every map and replacement instance. Do not flip
the gate off and resume legacy writers after successful backfill.

## 8. Checks actually run and remaining prerequisites

Ran once:

    node --check scripts/lib/s3b-reconciliation.mjs
    node node_modules/typescript/bin/tsc --noEmit
    node --import tsx --test --test-reporter=spec tests/revisions/s3b-reconciliation.test.mjs

Syntax and TypeScript checks passed. The new JavaScript helper is exercised by
the runtime tests; it is outside the existing src-only TypeScript compilation.
**24 offline tests passed, 0 failed, 0 skipped.** Coverage includes exact text/
order, extra-field preservation, object tasks, idempotence, unknown shapes,
duplicate/unknown targets, incomplete approvals, stale owner/source/target/context,
invalid descriptions, and fully approved synthetic candidates.

The actual-data dry run used the pinned development database READ ONLY and the
new pure helper. Private packet ACLs, pending approvals, unchanged current/history
data and aggregate results were checked. No database mutation test or live
apply was run. Prior application suites were not repeated because application
code was untouched.

**Outstanding:** human completion/approval of 25 new descriptions; explicit
policy acknowledgment; usable backup and demonstrated recovery; complete writer
inventory and executable stop/drain plan; fresh locked-source checks; separately
approved implementation and execution of the one-use maintenance driver.
The existing private cutover config still has no execution approval.

**STOP for review. No repair, deletion, migration 013, backfill, flag change,
deployment, or S4 work was performed.**

