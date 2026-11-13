# Mappr frontend S5 handoff

2026-11-10. Backend source is implemented and tested offline; **not deployed**.
Migration 015 is prepared only. Frontend files, browser behavior and client-side
export implementations were not inspected. The following are concrete API/view
paths to cover, not invented frontend filenames or completed UI verification.

## Use tracked artifact reads

For each artifact view, use its structured endpoint with `?freshness=tracked`:

```text
/maps/:id/api-contract
/maps/:id/relational-schema
/maps/:id/document-schema
/maps/:id/readme
/maps/:id/adrs
/maps/:id/env-vars
/maps/:id/deployment
/maps/:id/critique
/maps/:id/requirements
/maps/:id/traceability
```

Public/shared current reads remain public. New provenance fields are additive
to existing artifact payload fields. Successful tracked responses contain:

```json
{
  "sourceRevision": 7,
  "currentRevision": 8,
  "generationId": "<publication UUID>",
  "sourceFingerprint": "<opaque SHA-256>",
  "generatorVersion": "relational_schema:s5a-1",
  "publishedAt": "<server ISO timestamp>",
  "freshness": { "status": "fresh", "reason": "inputs_unchanged" },
  "isCurrent": true,
  "inspectionOnly": false,
  "readMode": "tracked"
}
```

Example metadata only; the actual response also includes the artifact fields.
`fresh` is the wire spelling for current. Older source revision 7 can correctly
be fresh at map revision 8 when the artifact's declared inputs are unchanged.
Do not infer currentness from equality of revision, legacy `version`, or a
tech/architecture hash. A legacy row can have matching keys and no proof of
currentness. Source revision and fingerprint may be null for unknown output.

Reasons: `inputs_unchanged`, `source_changed`, `generator_changed`,
`payload_changed`, `provenance_unknown`, `not_generated`.

Current lookup returns 409 `artifact_stale` when saved output exists without a
verified matching record. It includes freshness metadata and an `inspectionUrl`,
but **no artifact payload**. Missing output/map is 404. Revision/provenance schema
not ready is 503; do not fall back to unchecked local export on these errors.

Legacy structured GETs retain key-selection/sharing behavior and return additive
metadata with `readMode:"legacy"`. They are compatibility reads, not the new
current-artifact lookup. In particular, tracked mode may reuse an older-revision
schema that a legacy current-version read cannot find.

## Saved stale inspection

Explicitly request:

```text
GET /maps/:id/<artifact>?freshness=tracked&includeStale=true
```

This mode requires an established owner cookie: missing/invalid session is 401;
unknown/non-owned map is 404. Pass credentials using the already agreed browser
cookie/Origin setup; no URL-only edit or inspection permission is added.

The resolver prefers current output. If only stale/legacy saved output exists,
200 includes its payload with `isCurrent:false`, `inspectionOnly:true`, stale
reason, observed `currentRevision` and known `sourceRevision` (or null). Label it
as saved/out of date; unknown provenance must be stated without inventing a
generation revision. Reading does not regenerate anything or use credits.

Keep inspection caches separate from current artifact caches. Saved inspection
must not satisfy completeness/traceability checks or silently replace current
artifact state. Do not combine saved README/deployment prose with current graph,
labels or environment output and describe the result as one current document.
This implementation adds no arbitrary historical-generation browser or archival
SQL/Markdown/download API.

## Backend exports to use and guard in the UI

| View/output | Current-only backend request |
| --- | --- |
| Relational SQL | `GET /maps/:id/relational-schema/sql?dialect=postgres\|mysql\|sqlite` |
| Document/mongosh script | `GET /maps/:id/document-schema/script` |
| ADR Markdown | `GET /maps/:id/adrs/markdown` |
| README Markdown | `GET /maps/:id/readme/markdown` |
| Environment example file | `GET /maps/:id/env-vars/file` |
| Deployment runbook Markdown | `GET /maps/:id/deployment/markdown` |

All six routes enforce verified current primary output, including callers that
omit the tracked query. They return 409 for stale/unknown output and 404 for
missing output. `includeStale` is rejected with 400 on exports; it cannot override
the guard. Do not save an error JSON body as a successful downloaded file.

README flags reference only fresh API/schema/ADR output. Deployment includes only
fresh environment-variable output. Optional stale/missing dependencies are omitted
with an explicit note. These documents render from one coherent snapshot and are
rendered anew on each request. Regenerating support at the same canonical revision
can change an export; do not cache downloads solely by map revision.

Responses use `Cache-Control:no-store` / `Vary:Cookie`. CORS exposes:

```text
X-Mappr-Current-Revision
X-Mappr-Artifact-Generation
X-Mappr-Render-Fingerprint
```

The render fingerprint includes current observed revision, primary generation,
observed supporting generations/statuses, rendering version and dialect. Fetch
the server export on user download rather than reusing a previously assembled
file. Treat headers as snapshot metadata, not as a permanent currentness claim.

## Client-only paths that still require frontend work

Locate and guard every download/copy/print/export action in these views, including
actions reached from overview menus, contextual menus and aggregate exports:

- API Contract JSON and any OpenAPI/YAML conversion offered by the frontend.
  The backend has no API-contract export endpoint; client rendering must consume
  a verified tracked response rather than cached legacy endpoints.
- Critique, requirements and traceability JSON/CSV/Markdown/report exports if
  offered. These have no backend export endpoint. Legacy unversioned cached
  findings/links are not proof of freshness.
- Relational/document schema, ADR, README, environment-variable and deployment
  actions that build a Blob, text file or clipboard content locally instead of
  calling the six guarded routes. Prefer the server renderer for those formats;
  any local alternative needs equivalent provenance/dependency checks.
- Bulk/ZIP/project exports and any share/copy/print paths that incorporate the
  above artifacts. One stale member cannot be silently packaged as current.
  Omit it with an explicit note or block the export; stale inspection remains
  visibly separate.

These capabilities are the required search targets; their actual frontend
component/helper/file names and which optional formats exist require confirmation
in the separate frontend repository. This backend task did not claim to verify
those implementations or change UI behavior.

## Cache and mutation response ordering

1. Scope keys by map, session context, artifact type and read mode. Include
   dialect/output format for download requests. Do not expose cookie values in
   cache identifiers or logs.
2. Maintain the existing canonical revision high-water mark. A lower
   `currentRevision` artifact response cannot update a newer map's artifact state;
   refetch instead. An artifact's older `sourceRevision` is provenance, not a
   replacement canonical revision.
3. At equal canonical revision, artifact generations can change independently.
   Use per-artifact request epochs/cancellation so superseded responses cannot
   replace newer accepted output. UUIDs are identities, not sortable counters;
   do not order them lexically. Retain generation/published metadata for display
   and dependency invalidation.
4. After successful artifact POST/PATCH, refetch tracked state before installing
   a current cache or enabling a download. Those success bodies retain their
   existing payload shape; they are not a durable freshness lease. Regenerating
   API/schema/ADR output invalidates cached assembled README downloads;
   environment output invalidates cached deployment downloads even at the same
   map revision.
5. After canonical apply/legacy iteration, invalidate affected artifacts and
   exports. S4 `artifactImpactsContext` labels predictions; apply
   `artifactFreshnessContext` labels a transaction snapshot. Receipt replay may
   describe an old generation/revision: use it to confirm the operation, then
   refetch, not to overwrite newer canonical/artifact caches.
6. Generation conflicts (`artifact_source_changed`, `artifact_publication_conflict`)
   mean refetch/review; do not silently start another billable provider request.
   Existing artifact POSTs have no new client idempotency contract. A lost HTTP
   response requires checking tracked state before an intentional retry.

## Frontend acceptance before S5/S4 release

- [ ] Verify all ten tracked views, metadata parsing and correct older-source
  reuse. Unknown/legacy output never enables a current-export action.
- [ ] Verify owner-only stale inspection and public/shared current reads without
  inventing new sharing/edit permissions; confirm real cookie delivery.
- [ ] Verify all six server downloads and every client-only/bulk export path;
  handle 400/401/404/409/503 without a stale-data fallback.
- [ ] Verify same-revision regeneration, supporting-artifact changes, delayed
  responses, map/session switching and old S4 receipt replay cannot regress caches.
- [ ] Verify README/deployment show omitted-support notes and never splice stale
  optional output into a current file.
- [ ] Verify the actual deployed backend source/schema and browser integration
  after separately authorized migration/release; current tests were offline only.

S4's production interlock remains. Credits/provider policy, TTL approval and
other S4 prerequisites are unchanged. No deploy, migration execution, S4
activation or frontend change is authorized by this handoff. STOP for review.
