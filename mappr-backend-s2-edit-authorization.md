# MAPPR — Backend S2: Verified-Owner Mutation Authorization

## Context
Mappr's existing PostgreSQL database is **development/testing only**. The user wants implementation progress toward the Universal AI Change feature, not another broad audit or a disposable-schema reconstruction.

Previously verified repository/database facts (re-check against current code before editing):
- `maps.anon_id` is stored as a non-null UUID.
- `src/middleware/anonSession.ts` establishes a signed anonymous session identifier on the request (`req.anonId` in the earlier audit).
- The existing map routes do **not** enforce map ownership on mutations.
- `POST /maps/:id/iterate` immediately modifies canonical map data.
- Artifact generation endpoints, review/critique generation, traceability/requirements generation, and finding-dismissal endpoints also mutate map-owned records.
- Frontend and backend are in separate VS Code environments. Inspect backend only; do not pretend to verify frontend behavior.
- Approved design document: `BACKEND_CHANGE_CONTRACT.md` (sections on ownership and staged S2 rollout).
- S1 baseline documentation exists; A1 created an offline baseline but the optional disposable PostgreSQL integration test has not run. Do not claim A1 has passed integration tests.

## Goal
Implement the **smallest backend-only S2 milestone** that ensures existing map-mutating requests are accepted only from the map's verified anonymous owner. Preserve current read links and all existing public request/response shapes except intentional authorization failures. Do **not** implement the AI change preview/apply endpoints, revision migrations, or artifact freshness in this task.

## Step 1 — Inspect first
- Read repository instructions, `BACKEND_CHANGE_CONTRACT.md`, current Git status/diff, routes, `anonSession.ts`, cookie setup, CORS, `maps` queries, and existing test conventions.
- Enumerate **every route that creates or modifies records tied to an existing map**; do not protect only `/iterate` while leaving alternate mutation paths open.
- Check how an anonymous session is established/verified and what happens if the cookie is missing or replaced. Distinguish an invalid/missing established session from a newly issued one when possible.
- Inspect whether the project has existing auth helpers or middleware suitable for reuse. Keep implementation small and consistent.
- Confirm target development database identity before any database-related operation. This task should require **no DDL/DML migration** and should never reset or recreate existing tables.

## Step 2 — Implement owner verification
- Centralize a reusable helper/middleware that authorizes changes to a map by verifying the stored `maps.anon_id` against the established, valid signed-cookie anonymous identity.
- Do not accept an owner ID from request bodies, query strings, map IDs, or arbitrary headers.
- Perform server-side verification against current DB values; do not treat possession of a map URL as edit permission.
- Non-owner/unknown map: return a consistent `404 not_found` without revealing whether the map exists or whom it belongs to. For a truly missing/invalid established session, use `401 session_required` where supported by existing middleware. Avoid leaking raw identifiers or cookies.
- Guard existing map mutations, including Architecture iteration, critique/requirements/traceability regeneration, artifact regeneration, and findings dismissal; audit and protect any other mutable map-owned endpoints discovered.
- New-map generation (`POST /generate`) creates an owned map and must retain its working existing behavior, including binding the created map to the proper session.
- Keep existing map GET/share-link reading behavior unchanged for now: sharing/read permission is a separate product decision. Do not invent collaboration, ownership transfer, or account recovery.
- Preserve the existing successful endpoint response shapes and functionality for verified owners.
- Avoid touching unrelated routes or redesigning the authentication system.

## Step 3 — Cookie/origin safety without breaking development
- Confirm existing CORS credential behavior and signed-cookie semantics from source; do not guess that cross-origin browser requests are already functional.
- Assess whether strict Origin/CSRF checks can be implemented using the current configured frontend origins without breaking known development/CLI cases. If feasible within this narrow milestone, add an explicit small guard for cookie-authenticated mutations with tests; otherwise report the concrete blocker and keep launch disabled, rather than silently claiming CSRF protection.
- Do not hardcode production/local origins or expose secret values.
- Do not modify `.env` or reveal cookies, `DATABASE_URL`, or credentials.

## Step 4 — Backend edit-eligibility contract for frontend handoff
- Document how the frontend can determine whether the current anonymous session may edit a map, without exposing `anon_id`.
- Prefer reusing existing map response conventions. If a new endpoint or response field is needed, **propose its precise shape first in the report** rather than silently inventing a broadly visible production API.
- Remember the earlier frontend audit: the Next.js server-side map page fetch does not currently forward incoming browser cookies. A personalized `canEdit` field on server-side bootstrap cannot be assumed reliable without coordinating the frontend. Do not change frontend files.

## Step 5 — Tests and verification
- Add focused automated tests for an owner, another session, missing/invalid session, unknown map, and every protected route category.
- Verify all successful authorized requests retain their prior contracts; use mocks/in-process tests where possible, without real AI/provider calls or external billable operations.
- If performing any integration check against the existing development database, make it **read-only** and do not alter records. Avoid tests that generate artifacts or modify canonical maps in the live dev DB.
- Ensure `POST /generate` still associates a generated map with the established session (using safe mocks).
- Verify existing GET/share-link reads remain unchanged.
- Run the repository's relevant lint/typecheck/unit tests once (or the narrowest available checks). Report exact checks performed and what could not be tested.

## Boundaries / stop point
- No new change endpoints.
- No database migrations, resets, SQL baseline replay, manual ownership backfill, or edits to existing map owners.
- No changes to architecture/model output, regenerated artifacts, revision sequencing, frontend, or pricing/quota policies.
- Preserve unrelated Git changes and avoid new libraries unless necessary.
- Do not deploy or enable a wider universal-editing workflow.

## Final report
Provide: modified files; list of protected mutation routes; precise authorization behavior; remaining cookie/CSRF or frontend eligibility questions; test results; any compatibility risks; the smallest specific next action. STOP for review before S3.
