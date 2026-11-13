# Local Describe a Change browser testing

2026-11-13. **Backend ready and running; frontend server still needs to start.**

- Backend: `http://localhost:4000`, bound only to `127.0.0.1` (PID 12708 at preparation).
- Permitted frontend Origin: `http://localhost:3000`, from the existing `.env`.
  No frontend responded there during the readiness check. Frontend files were
  not accessed; configure its existing API-base setting to the backend URL.
- Use `localhost` on both sides. Do not mix `localhost` and `127.0.0.1` or use
  the Render URL, a LAN address or a development proxy for this test mode.
- Use `credentials: 'include'` on all frontend API requests. Existing cookies
  remain signed, HttpOnly, SameSite=Lax, non-Secure in development. No owner
  cookie is forged or transferred from another session.

## Startup and local gate

The backend has already been started. Do not launch a second copy. For a later
restart from `C:\Users\HomePC\mappr-backend` in PowerShell:

```powershell
$env:MAPPR_LOCAL_CHANGES_TESTING = 'true'
npm run dev:changes
```

The launcher reads existing `.env` credentials and requires explicit opt-in plus
`NODE_ENV=development`. It enables changes, coherent revision writes and durable
daily admission **only in that process**. `.env` was not changed. Normal
`npm run dev` does not opt in automatically.

Local mode requires port 4000, an exact HTTP loopback frontend Origin and the
existing 900-second proposal policy. It binds only to loopback and checks actual
local/remote socket addresses, port and Host on every change/fixture request.
Forwarded/proxy headers are rejected. Only Overview, Architecture and Tech Stack
previews are allowed in this visual-test slice.

Production/non-development/recognized hosted environments cannot use this
exception, even with the flag enabled. The production release interlock remains
blocked. Ownership, Origin checks, strict proposals, Apply/rejection validation,
revision locks, accounting and S5 freshness/export protections remain active.

The private runtime/log location is recorded outside Git at
`%LOCALAPPDATA%\Temp\mappr-local-browser-runtime.json`. To stop this prepared
instance, verify that PID 12708 is still this backend before stopping it. A PID
can be reused after exit. No Render process/deployment was touched.

## Create the disposable map yourself

No test map was automatically created. Start/open the frontend at
`http://localhost:3000`, then run this once in its browser developer console:

```js
const api = 'http://localhost:4000';
await fetch(`${api}/health`, { credentials: 'include' });
window.mapprLocalFixtureKey ??= crypto.randomUUID();
const response = await fetch(`${api}/dev/local-test-map`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': window.mapprLocalFixtureKey,
  },
  body: JSON.stringify({ create: true }),
});
const fixture = await response.json();
if (!response.ok) throw new Error(JSON.stringify(fixture));
console.log({ mapId: fixture.mapId, revision: fixture.revision });
```

Open the returned `mapId` through the frontend's normal map page. The synthetic
"Disposable Mappr Test" includes a summary, React/Node.js/PostgreSQL stack and
web/API/database architecture nodes. Initial revision 1 and its matching snapshot
are created atomically for **your browser's established owner session**. This
explicit fixture action makes no AI request and records no artificial AI usage.
Retry with the same key if its outcome is uncertain. Key collisions never
overwrite an existing map, and an existing map owned by another session is denied.

Use only this disposable map for visual edits. No existing map is changed to
prepare testing. Saved generated artifacts initially do not exist; existing S5
missing/stale/current behavior still applies if you later choose to generate them.

Test Overview, Architecture and Tech Stack through the frontend's actual
Describe a Change → Preview → explicit Apply/reject actions. No preview or Apply
was invoked against the real database during preparation. Real successful
previews use the existing configured **9-per-actor daily allowance** and
**200-global daily ceiling**; remaining allowance depends on existing usage.
Replays, Apply and rejection do not add another generation. No allowance was
raised, reset or bypassed. Provider keys/model configuration are present, but
their live validity/output quality will be exercised by your first manual preview.

Frontend request view identifiers remain `overview`, `architecture` and
`tech-stack`. Preserve existing revision-ordering, terminal-proposal handling and
artifact-cache synchronization. Refresh current canonical data between edits.

## Verification and changes

- One bounded READ ONLY database probe matched the existing development target
  fingerprint; required S4/S5 tables were present. All 38 maps had coherent
  revisions. Session timezone was UTC and matched the existing daily policy.
- Live local `GET /health`: 200, database connected. CORS allowed the configured
  Origin with credentials; OPTIONS preflight was 204 and allowed Idempotency-Key.
  The real signed cookie was HttpOnly/Lax/non-Secure. An established-session
  eligibility GET for an unknown map returned the expected 404.
- Listener independently observed at `127.0.0.1:4000` only.
- **245 focused offline tests passed, zero failed**; TypeScript, backend build
  and whitespace checks passed. Tests cover production/hosted refusal, socket/
  Host/proxy denial, real router cookie/owner/Origin checks, fixture atomicity/
  retry safety, shared proposal lifecycle and enforced daily quota. Their
  providers and database writes were synthetic mocks.

Files: `src/services/localBrowserTesting.ts`, `src/routes/localBrowserTesting.ts`,
`scripts/local-browser.mjs`, startup/router availability wiring, the npm command
and focused tests. Existing `.env`, migrations, feature handlers and artifact/
admission/revision implementations were preserved.

No real AI call, canonical edit, fixture creation, usage change, migration,
deployment, Render restart or Data API change occurred. Browser visual tests
remain for the developer. **STOP with the local backend running.**
