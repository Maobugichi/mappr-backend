# MAPPR — S2.1: Edit Eligibility and Browser Integration Check

## Goal
Finish the smallest missing S2 integration piece before S3. Implement an explicit owner-only eligibility read endpoint so the frontend can determine whether the current browser session can edit an existing map. Preserve all S2 authorization protections and existing shared-link reads.

## Scope and repository safety
- Inspect the current backend repository, relevant instructions, Git status/diff, S2 implementation report, `BACKEND_CHANGE_CONTRACT.md`, `src/app.ts`, session middleware, owner authorization middleware, and existing tests before changing anything.
- This is a **small S2 follow-up**, not the S3 revision work or S4 preview/apply engine.
- Do not edit database schema, migrations, application data, AI services, generation behavior, pricing/quotas, or frontend files.
- Do not weaken or bypass the existing mutation ownership guard to make tests pass.

## Implement one explicit endpoint

`GET /maps/:id/edit-eligibility`

Successful authorized response (HTTP 200):

```json
{"mapId":"<requested map UUID>","canEdit":true}
```

- Require an **established valid incoming** signed anonymous session; a newly issued replacement cookie is not proof of ownership.
- Check `maps.id` against the established session's `anon_id` using a parameterized lookup. Reuse the existing S2 owner-check logic where appropriate without coupling the GET route to unsafe-method middleware.
- An absent/invalid/not-established session returns HTTP 401 `{"error":"session_required"}`.
- A valid established non-owner session, unknown map, or malformed map identifier returns indistinguishable HTTP 404 `{"error":"not_found"}`. Do not reveal map existence or owner identity.
- Use `Cache-Control: no-store` and avoid publicly cacheable personalized responses. Do not include raw `anon_id`, cookies, or other identifiers beyond the requested map ID.
- This route is for browser-side, credentialed requests. Do not assume the existing Next.js server-side map bootstrap forwards user cookies.
- Preserve the current cookie format, CORS credentials settings, and normal GET/shared-link read behavior. Do not turn map reads generally into owner-only reads.
- Validate the actual route registration order so generic map routes do not shadow this endpoint.
- Treat all client-supplied IDs, headers, and body values as untrusted; a URL by itself never grants edit rights.

## Test narrowly and honestly
- Extend the existing S2 test suite or add a focused test using mocked DB boundaries. Cover owner 200, no/invalid/reissued cookie 401, non-owner/unknown/malformed map 404, lookup failures, no leakage, and no AI/quota/write calls.
- Confirm existing protected mutation routes still deny non-owner requests and authorized success responses remain unchanged.
- Verify `no-store` and expected CORS/credentialed request behavior where testable without a browser.
- Run TypeScript and the relevant tests once, reporting exactly what ran.
- If you can run an actual browser/manual integration check against the existing development environment **without modifying data**, validate both owner and shared-link session behavior. Otherwise list precise browser verification steps and mark browser cookie behavior unverified. Do not claim real browser verification from HTTP mocks.
- Do not perform live mutation requests against the database just to test eligibility.

## Handoff to frontend
Document the exact endpoint path, response statuses, use of `credentials: 'include'`, expected cookie behavior, and frontend interpretation: 200 enables editing, 401/404 disable editing, transient errors mean eligibility is unknown (do not assume owner). Keep eligibility in session/map-scoped browser state, not publicly cached SSR props. Clarify that this is permission discovery, not the future change-scope capability registry.

## Deliverable and stop
Implement this endpoint and tests only. Provide a concise summary: changed files, actual check results, unresolved browser/deployment limitations, and a short frontend handoff. **STOP before S3.**
