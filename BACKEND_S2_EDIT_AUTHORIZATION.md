# Mappr S2 edit authorization: implementation and review handoff

Date: 2026-11-07. S2 only; no deployment or S3 work. Repository instructions,
current Git diffs, `mappr-backend-s2-edit-authorization.md`, the change contract,
cookie/CORS setup, and every existing-map mutation route were inspected first.
No repository `AGENTS.md` was found. Existing tracked/staged diffs were empty;
untracked audit/contract/task documents and all A1 files were preserved.

## What changed

| File | Change |
| --- | --- |
| `src/middleware/anonSession.ts` | Records whether the request supplied an established, valid signed anonymous cookie. Missing/invalid cookies still receive a new identity for ordinary reads and new-map generation. Rejects non-string JSON cookies, malformed UUID/signature formats, and extra cookie suffixes without throwing. |
| `src/middleware/mapEditAuthorization.ts` | Reusable owner guard for existing-map mutations; accepts an injected lookup so it can be tested without a database. |
| `src/middleware/mutationOrigin.ts` | Small configured-Origin/browser-metadata guard with an explicit originless CLI compatibility allowance. |
| `src/app.ts` | Constructs the Express application without starting a listener. Mounts the origin guard and central `/maps/:id` mutation guard before all existing routers. Owner lookup is parameterized `SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2`; no owner identifier is returned. |
| `src/index.ts` | Retains dotenv loading, configured port, and listening behavior; delegates construction to `createApp()`. |
| `tests/auth/map-edit-authorization.test.mjs` | Runs real routers and services with mocked database, quota, and structured-AI boundaries over local ephemeral HTTP. Real PostgreSQL initialization is explicitly blocked. |

All existing route handlers, response serializers, AI prompts/services, database
configuration, migrations, quotas/pricing, and A1 artifacts remain unchanged.
This report records S2's implementation; earlier audit documents describe their
dated observations, not the new authorization behavior.

## Protected mutations

The central guard protects every unsafe method under `/maps/:id`, including all
13 currently implemented mutation routes:

| Method | Path |
| --- | --- |
| POST | `/maps/:id/iterate` |
| POST | `/maps/:id/critique` |
| POST | `/maps/:id/requirements` |
| POST | `/maps/:id/traceability` |
| POST | `/maps/:id/api-contract` |
| POST | `/maps/:id/relational-schema` |
| POST | `/maps/:id/document-schema` |
| POST | `/maps/:id/adrs` |
| POST | `/maps/:id/readme` |
| POST | `/maps/:id/env-vars` |
| POST | `/maps/:id/deployment` |
| PATCH | `/maps/:id/critique/findings/:findingId` |
| PATCH | `/maps/:id/requirements/findings/:findingId` |

`POST /generate` creates a new owned map and remains usable with a newly issued
or established session. It is not subject to an existing-map owner lookup.
GET, HEAD, and OPTIONS bypass ownership checks. Existing map, history, diff,
artifact, and export reads retain their handlers and response shapes; possession
of a shared link continues to allow the same reads, not editing.

## Exact authorization behavior

1. The origin check runs before session issuance and ownership lookup. A rejected
   browser-origin mutation receives `403 {"error":"origin_not_allowed"}` without
   reaching the database, quota logic, AI, or writes.
2. For an allowed-origin/CLI existing-map mutation, a missing, invalid, or newly
   replaced incoming session receives `401 {"error":"session_required"}`.
   Issuing a replacement cookie does not authorize that same request or transfer
   ownership of an old map.
3. With a valid established session, malformed map IDs, non-owner maps, and
   unknown maps return the same `404 {"error":"not_found"}`. The database query
   compares current stored ownership to the signed-cookie identity. Bodies,
   query strings, headers, and map URL possession provide no owner authority.
4. A failed ownership lookup returns `500 {"error":"internal_error"}`; the guard
   logs only a generic message, never driver query/error details, cookies, or IDs.
5. A verified owner continues to the original handler. Authorized statuses,
   payload fields, validation, generation accounting, and artifact behavior are
   unchanged. Ownership checks precede handler quota checks, AI, and transactions.

No record owner is assigned, repaired, or transferred. A different valid browser
session is a non-owner; a lost cookie has no recovery/claim path. The guard checks
ownership at request admission; there is no ownership-transfer API in this scope.
Existing iteration's revision/lost-update behavior is not repaired by S2.

## Cookie, Origin, and browser limitations

The signed `mappr_anon` cookie retains its wire format, HttpOnly flag, one-year
max-age, SameSite=Lax setting, and Secure flag in production. A legitimate cookie
issued by the existing backend continues to verify. Strict parsing intentionally
rejects previously tolerated malformed extra suffixes. A newly issued identity
can own a newly generated map but cannot claim any existing map.

CORS still uses the configured `FRONTEND_ORIGIN` with credentials enabled. A
configuration-only check confirmed that an origin is configured as a serialized
HTTP(S) origin and a cookie secret is configured; no values were printed or changed.
No origins are hardcoded in application code.

Mutation-origin rules:

- A supplied Origin must exactly match the configured serialized HTTP(S) origin.
  Opaque `null`, untrusted, or malformed origins are rejected. Missing/invalid
  frontend configuration rejects browser requests carrying an Origin.
- With no Origin, a request carrying Referer or any checked Sec-Fetch header is
  rejected. Originless requests without those browser headers retain CLI behavior.
- GET/HEAD and CORS preflight are unchanged. Origin checks also apply to new-map
  generation, so a cross-origin browser cannot use it as an unguarded mutation.

**This is limited Origin/Fetch-Metadata protection, not mandatory-Origin or
token-based CSRF protection.** The originless compatibility allowance cannot prove
that every headerless request came from a CLI. Do not claim full CSRF protection
or enable a wider universal-edit workflow from this milestone. Any stricter policy
needs explicit frontend/CLI agreement. Scripts that attach Referer/Sec-Fetch headers
without Origin must supply the agreed configured Origin or have their case reviewed;
an originless Node fetch is not assumed equivalent to a headerless CLI request.

Real browser cookie storage/sending, deployed HTTPS/proxy behavior, cross-site
SameSite behavior, and the separate frontend's credential settings remain unverified.
No frontend files were accessed. The supplied S2 brief states that the Next.js
server-side bootstrap does not forward browser cookies; a personalized edit flag
on that bootstrap would therefore be unreliable without coordinated changes.

## Edit-eligibility proposal: not implemented

Public `GET /maps/:id` has **no new personalized field**. The frontend must not
infer edit rights from that response, a shared URL, or its server-side bootstrap.

For frontend agreement before adding an API, propose an owner-only, credentialed
browser request:

```text
GET /maps/:id/edit-eligibility
Cache-Control: no-store
200 {"mapId":"<requested map UUID>","canEdit":true}
401 {"error":"session_required"}
404 {"error":"not_found"}
```

Here 404 deliberately covers both non-owner and unknown map; both mean editing is
unavailable. The proposed GET would need an explicit owner check, since ordinary
GETs bypass the central mutation guard. It would expose no anonymous ID and require
no read-sharing permission change. It is **not present in this implementation**.
Agree on this shape (or another explicit browser-side eligibility mechanism),
credential forwarding, cache isolation, and lost-session UI before implementing it.
Do not move a `canEdit` assertion into publicly cached SSR bootstrap data.

## Verification performed

- `node --check tests/auth/map-edit-authorization.test.mjs` passed.
- `node node_modules/typescript/bin/tsc --noEmit` passed.
- `node --experimental-test-module-mocks --import tsx --test tests/auth/map-edit-authorization.test.mjs`
  passed outside the sandbox: **47 passed, 0 failed, 0 skipped**. The initial
  sandbox attempt failed before test execution because the tsx loader's OS user
  lookup returned `uv_os_get_passwd ... ENOMEM`; the same mocked command was rerun
  with approval outside that restriction. Node reports an experimental module-mocking
  warning; no new library or package script was added.

Coverage includes all 13 mutation paths for owner/non-owner/unknown-map cases;
missing, bad-signature, malformed, suffixed, and JSON cookies across every path;
spoofed owner body/query/header inputs; failed lookups; anonymous and non-owner
shared GETs and HEAD; CORS preflight; all authorized success payload field sets;
new-map ownership for fresh, replaced, and established sessions; and origin/CLI
rules. Denied requests are checked for zero quota, AI, transaction, or write calls.

No application database was contacted, so no live target identity, database-level
permission behavior, historical owner/session correspondence, or provider calls
were tested. SQL in the route tests executed only in an in-memory mock. The task
brief's development/testing target description was not independently re-verified
through a connection, since no real database operation was necessary. A1 PostgreSQL
reproduction remains skipped/unverified; S2 does not claim to close that gap.

## Compatibility risks and next review action

The intentional compatibility changes are refusal of non-owner/missing-session
mutations and rejection of untrusted/browser-like originless mutations. Shared
reads and successful owner response shapes remain unchanged. Existing clients must
retain and send their original anonymous cookie; no URL-based edit entitlement is
preserved or invented. Unknown frontend cookie delivery or stricter CSRF expectations
must be resolved rather than bypassing owner checks.

Smallest next action: review S2 and agree with the frontend on a credentialed
browser eligibility check plus actual cookie/origin behavior. No eligibility route
was added, no feature was deployed, and no preview/apply, migration, adoption,
revision backfill, or S3 implementation was started. Stop for review here.
