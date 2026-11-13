# MAPPR — S3B Legacy Data Reconciliation Preparation

## Goal
Prepare a narrowly scoped, reviewable reconciliation of the 13 existing development/test maps that fail the current `MapprSystemSchema`, without modifying any database records. The target is to unblock S3B revision backfill while preserving all existing Mappr systems and meaningful data.

**This is preparation only. Do not execute a repair or migration.**

## Grounded findings from the approved read-only diagnostics
- 38 maps total; 25 currently valid and 13 structurally invalid.
- 13 maps contain 131 legacy `developmentPlan[*].items[*]` values represented as strings, whereas today's schema requires objects with `description: string` and `relatedFeatures: string[]`.
- Three of those 13 maps additionally have 25 `architecture.nodes[*].description` values missing entirely.
- Ten invalid maps contain only the legacy task format. No invalid map mixes string and object task items.
- All six historical snapshots are valid; none belongs to these 13 maps.
- Git history confirms the earlier string-item design and later object-item design. It does not establish the original descriptions of the 25 nodes.

Verify current source, Git diff, and current read-only classifications rather than assuming the counts cannot change.

## A. Inspect and preserve
1. Read the current `BACKEND_S3B_INVALID_MAP_DIAGNOSTICS.md`, `BACKEND_S3B_FINAL_READINESS.md`, `BACKEND_S3B_CUTOVER_PREPARATION.md`, `BACKEND_S3A_IMPLEMENTATION.md`, relevant schema, backfill/status implementation, repo instructions, and Git diff.
2. Keep S2/S2.1 owner checks and shared-link read behavior untouched.
3. Use ONLY the already-verified private development target and READ ONLY connection for any actual-data inspection. Never use an implicit `DATABASE_URL` fallback in operator tooling.
4. Do not expose map IDs, anonymous owner IDs, project text, raw payloads, credentials, or private connection details in chat, repository documents, stdout, or logs.
5. Any full-data review packet must live **outside Git**, at a private, access-restricted local path, with an explicit reviewed path; do not create it by default in the backend project.

## B. Prepare the deterministic legacy task normalization
Define a minimal transform for legacy task strings only:

`existingText` becomes `{ "description": existingText, "relatedFeatures": [] }`

- Preserve task text byte-for-byte and array order.
- Preserve all other fields and objects; do not regenerate or rephrase tasks.
- Treat an empty `relatedFeatures` list as **no relationships recorded in the legacy source**, not a claim that there are no conceptual relationships. Document this limitation for approval.
- Do not infer feature IDs from task prose; do not introduce fictitious references.
- Make the transformation idempotent and reject unrecognized shapes.
- Validate the transformed candidate using the **actual current** `MapprSystemSchema`, not a relaxed substitute.
- Produce a before/after structural diff and a way to confirm unchanged non-target data.
- Do not write normalized data to PostgreSQL or overwrite original payloads.

## C. Review the 25 missing Architecture descriptions
These fields have no recoverable original value in verified current/history data.

- Prepare a **private human-review packet** for the three affected maps, containing only the minimum context needed for the owner/developer to approve descriptions: map/node identifier, existing node label/type, existing node relationship context, suggested text, and approval state.
- Suggested descriptions, if any, must be explicitly labeled **new proposed content**, never recovered original content. They must be grounded in existing node context, with no invented services, technologies, or behavior. If context is insufficient, leave the suggestion blank for manual entry.
- Do not use empty-string filler, the node ID, or copied label as an automatic description. Do not introduce AI-provider calls, usage charges, or external data transmission in this task.
- Do not populate the 25 descriptions or save candidate changes back to PostgreSQL before explicit developer review and approval.
- Build a validator that rejects missing approvals, duplicate node references, stale source data, or descriptions that fail the current schema.

## D. Prepare a separate, gated reconciliation design
Recommend the smallest executable change needed **later**, after review:
- Verify a usable backup/recovery point first and stop/drain canonical writers.
- Independently verify the exact private target and re-read each map under lock.
- Confirm the candidate still matches its captured source (e.g. JSONB data equality / cryptographic fingerprint) and the selected map's owner metadata is unchanged; fail closed on mismatch.
- Apply only the explicitly approved task normalization and node descriptions, in bounded transactions, keeping original payloads recoverable in approved backup/reconciliation evidence.
- Preserve map IDs, owners, timestamps where appropriate, existing history, artifacts, usage rows, and all unrelated sections.
- Distinguish this one-time canonical data normalization from a user-requested product iteration; do not invent historical versions or silently record a product change.
- Explain how to sequence normalization with S3B migration 013 and truthful revision snapshots **before** enabling the global revision-write flag.
- Re-run complete structural validation and zero-quarantine status after a separately authorized change.
- Explicitly refuse to perform repair if any map cannot be reconciled safely. Do not skip incompatible maps while claiming global readiness.

Do not weaken `MapprSystemSchema` merely to pass the check. Do not insert snapshots for invalid canonical payloads. Do not modify any schema, route, worker, migration, deployment configuration, or flag for this task.

## E. Tests and deliverable
You may add a small pure helper and offline fixture tests for the proposed transformation and approval validation **only if necessary**. Do not add dependencies or broad refactors. Test:
- All 131 legacy tasks can be wrapped while retaining exact text/order (read-only dry run).
- Non-target fields are byte-for-byte/structurally preserved.
- Existing object-format tasks remain unchanged.
- Duplicate/unknown targets and incomplete node description approval fail closed.
- An already-normalized candidate does not change on repetition.
- The 10 maps with only task-format issues become structurally valid in read-only simulation; the three remaining maps still require 25 approved descriptions.
- Current and historical data remain unchanged.

Produce `BACKEND_S3B_RECONCILIATION_PLAN.md` containing: exact findings, proposed transforms, the policy decision on `relatedFeatures: []`, the 25-description approval workflow, only aggregate dry-run results, files changed, tests actually run, and outstanding prerequisites (backup/restore, stopped writers, separate write approval). Reference any private review packet by safe description, not by leaking its contents.

**Do not run migration 013, modify any database row, backfill versions, toggle revision writes, deploy anything, or start S4. STOP for review.**
