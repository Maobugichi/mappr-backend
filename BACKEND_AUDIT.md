# Mappr backend audit

Date: 2026-11-05. Scope: static inspection of backend source, schemas, routes, and tracked migrations. No repository `AGENTS.md`, README, or additional repository instructions were found. Frontend files, deployed behavior, and live database schema were not inspected. No application, API, database, or AI calls were made; this report is the only added file.

## Confirmed change capabilities and API contracts

Routes mount directly without an `/api` prefix (`src/index.ts`). `maps.data` is the canonical `MapprSystem`: metadata, product, users, features, tech stack, architecture, data model, design system, and development plan (`src/schema/mapprSystem.ts`).

| Endpoint | Current request and response |
| --- | --- |
| `POST /generate` | `{description: string}` with length 20–4000; `201 {id, createdAt, updatedAt, data}`. Creates a new system, rather than changing an existing map. Source: `src/routes/generate.ts`. |
| `GET /maps/:id` | `{id, inputDescription, data, createdAt, updatedAt}`; no current version field. Source: `src/routes/maps.ts`. |
| `POST /maps/:id/iterate` | `{instruction: string}` with length 1–2000; immediately commits and returns `201 {mapId, version, summary, patch, data}`. No base version, target view, preview, or confirmation parameter. Source: `src/routes/iterate.ts:23`. |
| `GET /maps/:id/versions` | Descending array of `{version, summary, createdAt}`; no full snapshots or patches. Returns `[]` when no history exists, including unknown maps. Source: `src/routes/iterate.ts:147`. |
| `GET /maps/:id/diff?from=N&to=M` | Positive, distinct integer versions; `{mapId, from, to, diff}`; `404` if either snapshot is missing. Deterministic, no AI. Source: `src/routes/diff.ts`. |
| `GET/POST /maps/:id/critique` and `/requirements` | GET reads the saved review; POST regenerates and overwrites it, returning `201 {mapId, findings, createdAt, updatedAt}`. `PATCH .../findings/:findingId` accepts `{dismissed: boolean}` and returns the review. Sources: `src/routes/critique.ts`, `src/routes/requirements.ts`. |
| `GET/POST /maps/:id/traceability` | Saved/regenerated `{mapId, links, createdAt, updatedAt}`; POST returns `201`. Source: `src/routes/traceability.ts`. |

The architecture patch contract requires five arrays: `addNodes`, `removeNodeIds`, `updateNodes`, `addEdges`, and `removeEdges`. New nodes have `{id,label,type,description}`; updates have `id` plus optional/nullable fields; edges have `{from,to,label?}`. Removing an edge without a non-null label removes all matching directed pairs. Sources: `src/schema/architecturePatch.ts`, `src/services/architectureIteration.ts:45`.

AI POST routes share `429 daily_limit_exceeded` and `503 capacity_exceeded`; invalid iteration input returns `400 invalid_request`, missing maps `404 not_found`, exhausted output validation `502 iteration_failed`, and other iteration failures `500 internal_error`. Artifact routes use their own `*_failed` errors. The actual iteration response omits `createdAt`, although `IterationResultSchema` requires it (`src/schema/architecturePatch.ts`).

**Only architecture nodes and edges can currently be changed by instruction.** The prompt explicitly excludes other sections; the service constructs `{...system, architecture}`. Critiques provide recommendations; requirements provide suggested feature names/descriptions; neither has an endpoint to accept/apply a finding. No generic view-edit, direct system-update, proposal approval, historical snapshot-read, undo, or restore route exists in `src/routes/`.

## AI prompts, validation, and application

- `src/services/architectureIteration.ts` sends the full system plus one instruction, requests a minimal patch and summary, and asks for a best-effort interpretation of ambiguous requests. No conversation history is supplied.
- All AI services reuse `generateStructured` in `src/services/aiClient.ts`. Configured primary model: `GEMINI_MODEL`, default `gemini-flash-latest`; hardcoded Groq fallbacks: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`. These are source settings, not verified provider availability. Both API keys are required at startup.
- Gemini receives a hand-authored response schema and JSON MIME type; Groq receives strict JSON Schema derived from Zod. Parsed JSON is checked with Zod, with one schema-error correction attempt per provider. HTTP 429/503 calls receive transient retries after 1 and 3 seconds. Malformed JSON throws before Zod and falls through to another provider. Prompts/model selection are not recorded with saved changes.
- `applyArchitecturePatch` removes existing nodes and their incident edges, updates surviving nodes, deduplicates new node IDs, and filters new edges against final node IDs. It then validates the resulting full system shape (`src/services/architectureIteration.ts:57`). Application is deterministic; the model does not write database records or execute generated code.
- Validation is mainly structural. `MapprSystemSchema` does not enforce unique IDs, valid cross-section references, feature dependency acyclicity, or development-plan dependency order. Grounding does not deduplicate edges or repair pre-existing dangling edges. `groundedPatch.removeEdges` preserves unverified removal requests, cascading removals are implicit, and the AI summary is not reconciled with the actual diff. A wholly filtered/no-op patch can still create a version and consume quota.

## Persistence, versioning, and rollback

`POST /generate` writes `maps` and a `generations` usage row in one transaction. Initial version 1 is implicit. First iteration lazily inserts the old full system as version 1, then inserts the new full snapshot, grounded patch, and summary as version 2. Later iterations increment `MAX(version)` and atomically update `maps.data`, `maps.updated_at`, history, and usage (`src/routes/iterate.ts:76–117`). The original description is retained unchanged. SQL failures roll back these writes; this is transaction rollback, not user-accessible undo. Deployment artifacts contain textual release rollback guidance only.

Available migrations define artifact JSONB columns, unique map/version or map/hash keys, and map foreign keys with `ON DELETE CASCADE` (`src/db/migrations/002_architecture_reviews.sql`, `007_relational_schemas.sql` through `012_deployments.sql`). **DDL for `maps`, `generations`, `map_versions`, `missing_requirement_reviews`, `traceability_reviews`, and `api_contracts` is absent.** `package.json`'s migration script references absent `001_init.sql` and does not run the supplied migration series. Actual deployed constraints and clean database provisioning cannot be confirmed.

## Generated artifacts and dependencies

Each artifact below has `GET/POST /maps/:id/<suffix>`. POST has no supported instruction body: it generates from canonical data, upserts the artifact, and records usage in a transaction; it never changes `maps.data`. GET returns `404` when its current key has no saved artifact. POST regenerates even when one exists. Record responses contain `mapId`, timestamps, the key, and the payload listed below.

| Suffix / route file under `src/routes/` | AI input; saved payload | Freshness key / additional GET |
| --- | --- | --- |
| `api-contract` / `apiContract.ts` | Full system; `endpoints` grounded to feature/entity IDs | Map `version`; no backend OpenAPI export route found |
| `relational-schema` / `relationalSchema.ts` | `dataModel`; logical `tables`, with deterministic many-to-many join tables | Map `version`; `/sql?dialect=postgres\|mysql\|sqlite` (dialect required) |
| `document-schema` / `documentSchema.ts` | `dataModel`; `collections`, with deterministic many-to-many reference fields | Map `version`; `/script` (mongosh) |
| `readme` / `readme.ts` | `meta`, features, tech stack, architecture, development plan; `overview`, `gettingStarted` | Map `version`; `/markdown` |
| `adrs` / `adr.ts` | Tech stack and architecture; subject-grounded, deduplicated `adrs` | `techArchHash`; `/markdown` |
| `env-vars` / `envVars.ts` | Tech stack and architecture; normalized/deduplicated `vars` with grounded references | `techArchHash`; `/file` (.env.example) |
| `deployment` / `deployment.ts` | Tech stack and architecture; `components`, `environments`, `cicdSteps`, `migrations` | `techArchHash`; `/markdown` |

Matching generation services live under `src/services/` with the same filenames. Export rendering is deterministic in `relationalRender.ts`, `documentRender.ts`, `readmeRender.ts`, `adrRender.ts`, `envVarsRender.ts`, and `deploymentRender.ts`; exports return text, not saved executable deployments. API-contract OpenAPI export is mentioned in README text/schema comments, but its implementation cannot be attributed to this backend.

Version keys use `COALESCE(MAX(map_versions.version),1)`. `techArchHash` is SHA-256 over `JSON.stringify({techStack,architecture})` (`src/services/adr.ts:51`), so ordering/text changes affect it. Old keys remain stored; regeneration overwrites the same key without preserving prior artifact revisions.

Critique, requirements, and traceability instead overwrite one record per map with **no source version/hash**. Their prompts inspect the full system; grounding filters node/feature references. README Markdown combines saved AI prose with current canonical sections and existence checks for API contract, database schemas, and ADRs (`src/routes/readme.ts:57`). Deployment Markdown combines its saved plan with current graph connections, computed deployment order, and optional current-hash environment variables (`src/routes/deployment.ts:89`, `src/services/deploymentRender.ts`). These exports can change when supporting artifacts change, without regenerating their AI prose.

## Data consistency and persistence risks

1. **Lost updates:** iteration reads and runs AI before acquiring its row lock. Two requests can derive full snapshots from the same starting map; the later commit overwrites the earlier change while still receiving a distinct version. No expected revision check or rebase occurs (`src/routes/iterate.ts:47–108`).
2. **Artifact provenance race:** version-keyed generation reads `maps.data` and `MAX(version)` separately. An iteration between those reads can label old data as a newer version. Artifact generation/export queries do not share a consistent snapshot (`src/routes/apiContract.ts:84–108`; equivalent schema/README flows).
3. **Uneven freshness:** iteration triggers no automatic regeneration or explicit stale flags. Version/hash artifacts disappear from current GETs after key changes; reviews and traceability remain visible with potentially removed node references. Architecture-only edits unnecessarily invalidate database artifacts whose input is only `dataModel`.
4. **Cross-view drift:** a cache/database/service change can alter architecture while leaving tech stack, entities, features, and roadmap contradictory. Independent generation and reference filtering do not enforce semantic agreement or complete coverage. For example, relational grounding validates referenced table existence, not referenced columns/keys; traceability does not enforce exactly one result per feature (`src/services/relationalSchema.ts:49`, `src/services/traceability.ts`).
5. **Mutation access:** signed anonymous cookies support quota identity, but map queries do not compare the map's `anon_id` to the requester. Anyone possessing a map ID can read, iterate, regenerate, or dismiss findings through these routes (`src/middleware/anonSession.ts`, `src/routes/`). CORS is configured but no ownership authorization middleware is present (`src/index.ts`).
6. **Recovery and accounting gaps:** no restore API or artifact revision history; original instruction, base revision, and model provenance are not saved by iteration. Quota checks precede AI work without reservation, allowing concurrent requests past the limit; failed calls consume provider resources without a usage row (`src/services/rateLimit.ts`, AI POST routes). Missing DDL further limits persistence guarantees.

## Recommended reusable backend architecture (proposal only)

- Reuse `generateStructured`, typed schemas, deterministic patch application, `computeSystemDiff` (already covers every canonical section in `src/services/diff.ts`), and existing pure renderers. Add section-specific change handlers for other canonical views rather than treating artifact regeneration as a system edit.
- Centralize a change service: capture one immutable base revision, propose a typed patch, validate IDs/references/dependencies and cross-section effects, compute the real diff/summary, and atomically commit only if that revision is still current. Keep AI outside the database transaction; reject conflicts explicitly. Separate preview/apply if the product requires approval.
- Persist initial and subsequent snapshots, actual operations, instruction, actor, base revision, and model/prompt/schema provenance. Implement restore as a new version and run the same consistency checks. Restore missing migrations before depending on this design.
- Introduce an artifact registry declaring exact source sections and supporting-artifact dependencies. Store input fingerprints, source revisions, generator versions, explicit freshness state, and artifact revisions. Regenerate affected artifacts from the captured snapshot and verify provenance before exposing them as current. Keep deterministic exports separate from AI generation.
- Apply ownership checks, idempotency, and atomic quota reservation through shared middleware/services. Preserve existing contracts until an explicitly agreed migration.

## Questions requiring frontend confirmation

- Which views need instructions: canonical product/users/features/tech/data/design/roadmap, derived artifacts, or both? Should artifact edits be independent overrides or change canonical data?
- Does Architecture use immediate apply today, or require a proposed diff and explicit acceptance? What should happen when an instruction affects multiple sections?
- After iteration, which canonical data, artifact caches, reviews, and traceability results are refreshed? How should missing versus stale artifacts appear, and when should regeneration consume quota?
- Which response shapes are actually consumed, particularly iteration's missing `createdAt` and map GET's missing version? Are OpenAPI export, version browsing, or undo implemented locally?
- Are shared map IDs intended to grant editing rights? What ownership/read-only sharing behavior is expected?
- Are graph positions/layout, selection, and unsaved edits frontend-local? This backend schema has no layout coordinates; confirm how accepting a change preserves that state.
