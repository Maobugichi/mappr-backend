# Mappr S3B invalid-map diagnostics

Date: 2026-11-07. **Diagnostic complete; S3B remains NO-GO.**
The 13 rejected maps have two actual failure signatures: legacy string
development-plan items on all 13, plus missing architecture-node descriptions
on 3 of those maps. No data, application code, or migration was changed.

## 1. Verified scope and counts

Read the diagnostic brief, final-readiness/preparation/S3A reports, change
contract, current schema/generation/iteration/classifier code, repository history,
and current Git changes. No applicable repository/ancestor AGENTS.md was found.
Preserved existing edits and untracked work.

Used the existing private, unapproved operator configuration. Its connection
matched the current development app configuration and pinned database/role/target
fingerprint; TLS settings were unchanged. No fallback database was used.

Inspection snapshot: **2026-11-07 13:02:28 UTC**. PostgreSQL 17.6; transaction
READ ONLY / REPEATABLE READ; configured default isolation READ COMMITTED.
Local statement/lock/idle-transaction timeouts: 10s/1s/30s. Ended with ROLLBACK.
Only generalized schema paths, issue/type metadata and counts left memory.

| Measure | Verified result | Compared with final readiness |
| --- | --- | --- |
| Current maps | **38** | Unchanged count |
| Current valid / invalid | **25 / 13** | Invalid count unchanged |
| Current Zod issue occurrences | **156** | Newly diagnosed |
| Planner initialize / match / unchanged | **22 / 3 / 0** | Unchanged counts |
| Planner quarantined | **13**, all invalid_system | Unchanged count |
| History snapshot rows | **6** | Unchanged count |
| maps.current_revision | Absent | Unchanged |
| Revision-write gate | Off in effective app configuration | Unchanged |

Equal counts do not independently prove identical membership over time. No
record identifiers were published or durable per-record diagnostic files made.

## 2. Exact validation used

Imported the actual MapprSystemSchema from src/schema/mapprSystem.ts and called
safeParse(data) with no custom options, coercion, defaults, relaxed schema, or
pre-validation normalization. This is the same schema/options used by
src/services/revisionState.ts:38 to classify invalid_system and by its historical
snapshot check at line 41. The existing pure maintenance planner reproduced
22 initialize / 3 match / 13 quarantine in the same inspection.

Confirmed validation paths:

- src/services/gemini.ts:73 supplies this schema to generateStructured.
  src/services/aiClient.ts:115 and :124 validate each attempt and bounded retry
  with safeParse; successful parsed data is returned. Current generation then
  strips null optional edge/relation labels, not missing node descriptions.
- The legacy iteration route validates its input system before AI
  (src/routes/iterate.ts:66). The architecture service validates the patched
  full system again (src/services/architectureIteration.ts:152). The revision
  service also retains structural readiness checks.
- Current required fields are defined at src/schema/mapprSystem.ts:29
  (architecture node, including description) and :65 (development-plan item,
  requiring description:string and relatedFeatures:string[]).
- The schema checks structural types, enums and phase constraints; it does not
  fully validate reference existence, uniqueness or dependency semantics.
  No relationship-integrity claim follows from a successful structural parse.

JSON-schema metadata was used only to whitelist/generalize diagnostic paths.
It was not used as an alternative validator; existing Zod unknown-key behavior
was preserved.

## 3. Aggregated validation signatures

| Structural path | Zod code / issue class | Expected | Observed structural state | Distinct affected maps | Issue occurrences | Evidence-based classification |
| --- | --- | --- | --- | --- | --- | --- |
| developmentPlan[*].items[*] | invalid_type / wrong item type | Object with description:string and relatedFeatures:string[] | String | **13** | **131** | Matches the earlier repository's string-item shape; incompatible with today's object-item requirement |
| architecture.nodes[*].description | invalid_type / missing required field | String | Field absent | **3** | **25** | Missing recorded description; no compatible historical relaxation or verified rename found |

These categories overlap: **10 maps have only the string-item failures; 3 have
both categories**. There are 13 distinct invalid maps, not 16, and 156 issue
occurrences, not 156 maps. No other current Zod failure signature was emitted.
No invalid map mixed string and object development-plan items.

Array indexes were collapsed to [*]. Only fields defined by the repository
schema were allowed into paths; an unexpected/private key would be generalized.
Actual values, names, descriptions, IDs, raw Zod messages and full payloads were
not printed.

## 4. Current versus history coverage

All **38 current payloads and all 6 saved snapshots** were validated independently.
This diagnostic did not skip history when current validation failed.

| History check | Result |
| --- | --- |
| Valid / invalid saved snapshots | **6 / 0** |
| Maps with / without history | **3 / 35** |
| Invalid current maps with history | **0 of 13** |
| Saved history rows belonging to invalid current maps | **0** |
| Orphan history rows | **0** |
| Latest-snapshot/current-data mismatches among maps with history | **0** |
| Noncontiguous/nonpositive/duplicate version sequences | **0** |

All available history belongs to structurally valid current maps. Therefore
existing map_versions cannot supply earlier descriptions or item mappings for
the 13 rejected maps. External backups or other sources were not examined and
might contain additional information; none is assumed available.

## 5. Confirmed compatibility changes and limits on attribution

Confirmed in available Git history:

- Commit **62ebdb9**, 2026-08-29, defined development-plan items as string[].
  Architecture node description was already a required string.
- Commit **2683db7**, 2026-09-16, replaced string items with objects containing
  description and relatedFeatures. The Gemini response schema and generation
  instructions changed with it.
- Commit **068ec32**, 2026-09-28, added nullable optional edge/relation labels.
  That broadens label acceptance and does not explain either observed failure.
- The available src/db/migrations SQL contains no canonical JSON conversion for
  that item-shape transition. Migration 013 only adds the revision column.

For comparison only, evaluated the first-commit schema definition using the
installed Zod runtime: **10 of the 13 rejected maps match that earlier shape**.
The remaining 3 still lack descriptions that the first known schema required.
This comparison did not change the current definition of validity.

**Confirmed:** the stored item representation matches a verifiable legacy shape;
25 node descriptions are missing across 3 maps.

**Plausible, not proved:** some records may have been produced or imported under
an older representation without later normalization.

**Unknown:** the actual writer, deployed version/provider, creation provenance,
and reason those node descriptions were omitted. No record-to-commit attribution
was established. Do not label these records corrupted/disposable or assume an
older release explains every defect.

## 6. Preservation and possible later reconciliation

No reconciliation below is approved or implemented.

| Category | What can be preserved deterministically | What still requires a decision |
| --- | --- | --- |
| String development-plan items | A wrapper can copy the exact existing string to description, retaining its position and all other stored fields. The transformation is reversible for the observed strings. | Legacy strings contain no structured relatedFeatures field. Setting it to [] is a semantic policy about unrecorded references, not recovered information. Do not infer links automatically from prose. |
| Missing node descriptions | Keep the original records/IDs/fields unchanged and preserve them in a verified backup. | There is no stored required description at this path and no verified rename rule. A meaningful description needs a verified source or explicit developer/product input. Labels, IDs, empty strings or generated filler are not a lossless reconstruction. |

A purely in-memory experiment wrapped the **131** string items as
{description: existingText, relatedFeatures: []}. It preserved the exact text
reversibly on all 13 maps and made **10** candidates pass the current structural
schema. The other **3** still failed on missing node descriptions. Original
current/history objects were compared before/after and remained unchanged.

This proves text preservation and structural feasibility, **not** semantic
approval of empty feature references or full lossless recovery of the new
relationship information. No candidate JSON was saved or applied. Before any
later normalization, approve what [] means for legacy items, preserve the
original payloads in a verified recovery artifact, and resolve the missing
descriptions without invented content.

Keeping all 13 records untouched and retaining NO-GO is also safe. Deletion,
automatic regeneration, global optional/default fields, or weakened validators
are not recommended ways to make this cutover pass.

## 7. S3B assumptions and smallest next step

The existing status/backfill fail-closed rules are correct; no validity-rule
change is required by these findings. The prior assumption that 35 history-free
maps could all initialize must remain conditional: only 22 currently qualify.

Do not fix status alone or insert converted snapshots while leaving incompatible
raw canonical data: S3B requires full structural validity and truthful JSONB
snapshot equality. Any later normalization must use a separately reviewed plan
consistent across canonical data, history, consumers and original-data retention.
Keep S2/S2.1 authorization unchanged.

The smallest next step is to review two bounded decisions: the legacy item
reference policy for all 13 maps, and trusted descriptions for the 25 affected
nodes on 3 maps. Then prepare a narrowly scoped reconciliation proposal, without
executing it until separately authorized. Obtain the still-unverified usable
backup/restore evidence and complete writer inventory/stop-drain plan before
any database mutation. After approved reconciliation, re-run full current/history
status under the controlled maintenance window. Migration/backfill/activation
remain separate explicit approvals.

## 8. Files, checks, and remaining uncertainty

**Only BACKEND_S3B_INVALID_MAP_DIAGNOSTICS.md was added.** No application,
operator, test, migration, environment, private-config or existing report file
was changed. A one-shot diagnostic was explicitly invoked through Node/tsx;
no permanent diagnostic tool was needed.

Actually checked: exact-schema parsing of all current/history rows, count-only
planner classification, pinned target/role/config identity, column absence,
history numbering/equality, repository schema history and available migrations.
Synthetic assertions verified wildcard paths, distinct-map counting across
multiple issues, suppression of private sentinel values/IDs, unknown-key
generalization, and reversible in-memory wrapping. Git integrity checks confirm
preservation. No application suite/typecheck was rerun because no code changed.

Unverified: historical writer provenance, semantic reference mappings,
recoverability of missing descriptions from external sources, actual
backup/restore readiness, complete writer quiescence, and real PostgreSQL
migration/backfill behavior. Existing payloads are preserved, not repaired.

**NO-GO remains. No database writes, migration 013, backfill, revision activation,
or S4 work occurred. Stop for review.**

