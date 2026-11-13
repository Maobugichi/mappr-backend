# Mappr S3C revision activation and Render handoff

Date: 2026-11-08. **Local source/build/offline verification PASS. Activation is
not performed or authorized by this task. STOP for review.**

The database handoff records 38 coherent revisions, 41 snapshots and zero
quarantine, with `revisionReady:true` at 14:20:33 UTC. This task did not contact
Supabase or repeat migration/backfill. Repeat the narrow read-only status check
within the eventual activation window; the earlier database result is evidence
from S3B, not a new live inspection here.

## Git and deployable-source status

| Item | Actual finding |
| --- | --- |
| Local branch | `main` |
| Local HEAD | `ac67e6dec321de01425d174ca371c6f2f55bc945` |
| Tracking branch / cached ahead-behind | `origin/main` / `0 / 0` |
| Live remote branch check | `git ls-remote` succeeded; remote `main` has that same SHA |
| Staged changes | None |
| Current implementation committed/pushed | **No: required changes are modified or untracked** |
| Render linked repo/branch, active SHA and settings | **Unavailable; dashboard verification required** |

Modified tracked runtime files are `src/index.ts`,
`src/middleware/anonSession.ts`, and `src/routes/generate.ts`, `iterate.ts`,
`maps.ts`. The following required TypeScript inputs remain untracked:

```text
src/app.ts
src/db/backfillCurrentRevision.ts
src/db/revisionTransaction.ts
src/db/s3bCutover.ts
src/middleware/mapEditAuthorization.ts
src/middleware/mutationOrigin.ts
src/services/canonicalRevision.ts
src/services/revisionState.ts
```

The operator scripts, S1 baseline, migration 013 and test files are also
untracked. Review and publish the related prerequisite files together; a partial
commit can omit imports needed by the full TypeScript build. Private operator
configurations, archives, cookies, credentials and recovery payloads must remain
outside Git.

**There is no reviewed commit SHA containing the passing current implementation
to give Render yet.** The remotely present HEAD is not the activation candidate.
No commit, push, fetch, branch change or Render operation was performed. The
remote check only read the branch reference. A new reviewed release SHA and its
availability to Render must be established under separate publication approval.

## Implemented and verified behavior

| Source | Confirmed behavior |
| --- | --- |
| `src/services/canonicalRevision.ts` | Gate is exactly `process.env.MAPPR_REVISION_WRITES_ENABLED === 'true'`; no startup refusal when it is missing/off |
| `src/routes/generate.ts` | Enabled branch commits map/revision 1, full initial snapshot and usage in one transaction; AI precedes the transaction |
| `src/routes/iterate.ts` | Enabled branch captures a coherent base before AI, locks/rechecks owner/base/revision afterward, and commits snapshot, canonical revision/data and usage atomically |
| `src/db/revisionTransaction.ts` | SQL-only transactions; 3-second lock and 10-second statement limits; rollback on failure |
| `src/routes/maps.ts` | Enabled GET reads data, counter and matching-history checks coherently; missing/inconsistent readiness fails with 503 |
| `src/app.ts`, owner/origin middleware | Existing-map mutations require an established signed-cookie owner; browser origins are checked; public/shared GETs remain readable |
| Edit eligibility | Owner-only `GET /maps/:id/edit-eligibility`; `no-store`, Cookie variation, established-session requirement and current ownership lookup |

Only generation and iteration are request-time canonical writers. Artifact
routes write their own tables. Reconciliation/backfill remain explicit operator
utilities, not startup tasks. The package has no prestart/prebuild/postinstall
hooks; `src/index.ts` constructs the app and listens without migration/backfill.
No graceful-drain/shutdown handler is implemented, so a maintenance plan cannot
assume application-level drain telemetry exists.

**Missing/off/nonliteral flags still select the legacy write branches.** A flag
must be the literal string `true` before every future writer starts. Do not run
an old deployment or an off writer against the backfilled database.

## Checks actually run

Environment: **Node v24.14.1, npm 11.11.0, TypeScript 7.0.2**, Windows.

```text
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
node --experimental-test-module-mocks --import tsx --test --test-reporter=spec tests/auth/map-edit-authorization.test.mjs tests/revisions/revision-safety.test.mjs tests/revisions/s3b-cutover.test.mjs tests/revisions/s3b-reconciliation.test.mjs tests/revisions/s3b-reconciliation-executor.test.mjs
```

| Check | Actual result |
| --- | --- |
| TypeScript no-emit check | **Exit 0** |
| Backend build (`tsc`) | **Exit 0** |
| Five mocked S2/S2.1/S3A/S3B suites | **195 passed, 0 failed, 0 skipped** |
| Fresh compiled entry timestamp | **2026-11-08 14:41:23 UTC** |
| Compiled runtime wiring checks | **10/10 passed** |

Before the build, `dist` lacked the app factory and revision service. After the
build, `dist/index.js` uses the current app factory and the emitted app/routes
contain owner/origin guards, eligibility, strict gate, atomic generation,
revision-checked iteration, typed conflict response and coherent GET path.
`npm start` resolves to `node dist/index.js`; that entry was read, not imported
or launched. `dist` is Git-ignored and must be built on Render from reviewed
source.

Tests use synthetic data, database/provider mocks and temporary loopback HTTP
fixtures. Real pg construction is blocked and provider keys are removed in test
workers. Some workers exercise the enabled gate only against mocks. No live
backend, Supabase connection, AI request or deployed configuration was used.
The database-mutating S1 integration suite was not run.

These results cover the current dirty working tree with installed dependencies.
A clean checkout/Linux build of the eventual release commit is not yet verified.
Local configuration remains off and its file is unchanged. No optional live
database check was needed for this preparation task.

## Render settings to verify before authorizing activation

There is no repository Render manifest, deployment workflow or usable Render
control-plane access. Nothing establishes which source/configuration `mappit`
currently runs. Record these dashboard facts before changing anything:

- Exact service/workspace, linked repository, branch, current deployed SHA,
  pending deploys, auto-deploy policy and every replica/worker sharing the target.
- Service runtime and root directory. The commands below assume native Node and
  a root containing this backend's `package.json` and `tsconfig.json`; if the
  service uses Docker/a prebuilt image, review that actual recipe first.
- Actual build/start/pre-deploy commands, Node version, health path, suspension
  state, environment groups and service-level variable overrides.
- A provider-supported way to build/replace the suspended service while writes
  stay blocked, without first running the old deployment. This behavior could
  not be verified here; **STOP if that sequence is not established**.

Expected project-specific settings, to configure only after separate approval:

| Setting | Required value/check |
| --- | --- |
| Build | `npm ci --include=dev && npm run build` so dev-only TypeScript/types are available |
| Start | `npm start` -> freshly built `node dist/index.js` |
| Pre-deploy | No migration/backfill hook; S3B is complete |
| Node | Explicit reviewed version; local evidence is v24.14.1. Retest a different chosen version |
| Health path | `/health`; confirms basic DB connectivity, not commit/flag/revision readiness |
| Port | Honor Render's `PORT`; source has local fallback 4000 |
| Revision flag | Service-level `MAPPR_REVISION_WRITES_ENABLED=true`, literal lowercase string |
| Environment | `NODE_ENV=production`; canonical deployed `FRONTEND_ORIGIN` without a path/trailing slash |
| Secrets | Preserve the verified development `DATABASE_URL`, existing `COOKIE_SECRET`, provider keys/model settings and approved quotas privately |

There is no repository Node pin (`engines`, `.node-version`, `.nvmrc`). Choose
one explicitly in deployment configuration; Render's default depends on service
creation history. [Render Node version configuration](https://render.com/docs/node-version).

The generic `npm run migrate` points to missing `001_init.sql`. It is not an
activation command. Neither 013 nor backfill may be replayed by build/start/
pre-deploy settings.

## Future-only activation sequence — not executed

1. Obtain separate publication/deployment/activation approval. Keep `mappit`
   suspended, local writers off and Data API disabled. Reconfirm no other known
   writer or in-flight request can commit. Control auto-deploy/pending triggers
   before publishing code; a linked-branch push can initiate a deploy.
2. Use the pinned operator's **status mode only** in that maintenance window.
   Require `revisionReady:true`, 38 maps, 41 snapshots, 38 unchanged/ready and
   zero quarantine; verify coherent history and preservation/recovery evidence.
   Do not run `migrate` or `backfill` again.
3. Review the complete source/tests/operator changes, commit and push only with
   publication authorization, and record the new full SHA. Verify the remote
   branch and Render Git link contain it. Build/test that actual release commit
   in a clean checkout/CI. Do not use the old SHA above as the release target.
4. Stage the literal revision flag for every future writer before startup.
   For Render, use **Save only** while the service remains safely suspended;
   the next deployment must consume it. **Save and deploy** reuses an existing
   build; **Save, rebuild, and deploy** triggers a build. Environment groups
   must not leave conflicting writer configurations. No setting is changed in
   this handoff. [Render environment options](https://render.com/docs/configure-environment-variables).
5. After validating the suspended-service replacement plan, build/deploy the
   reviewed SHA with the settings above. Use **Deploy a specific commit** when
   selecting that SHA; verify deploy events and build logs. **Restart service**
   retains the deployed commit and environment and cannot publish this local
   implementation. Normal rolling deploys can leave an older instance serving;
   keep writes blocked until all instances are verified. If replacement would
   expose the legacy/off binary, stop and obtain a specific safe provider plan.
   [Render deployment behavior](https://render.com/docs/deploys).
6. Verify the active SHA, new build and effective literal flag through operational
   evidence, then the read-only checks below. Do not infer activation from a
   saved value, a green health check or a listening log alone. Admit mutable
   traffic only after every writer and required frontend checks are cleared.
7. Any live generation/iteration/concurrency smoke test requires separate approval
   because it can create rows and consume AI quota. None was performed here.

## Local launch checklist — future approval required

For each terminal/supervisor: use the reviewed revision-aware checkout, verify
the pinned target and readiness, preserve cookie/origin settings, and set the
literal process flag before any launch. Every fresh terminal/nodemon parent
needs the correct environment. The current `.env` does not enable the gate.

Example for an approved Windows launch only; **not run in this task**:

```powershell
$env:MAPPR_REVISION_WRITES_ENABLED = 'true'
if ($env:MAPPR_REVISION_WRITES_ENABLED -cne 'true') { throw 'Refusing off-writer startup' }
npm.cmd run build
npm.cmd start
```

The same gate applies to `npm run dev`. No backend startup guard enforces it
automatically today. Do not start a second/local writer during the Render cutover.

## Read-only smoke and frontend agreement

After the separately authorized deployment, use private known map/session inputs:

- `/health`: basic connectivity only. `GET /maps/:id`: positive coherent
  `revision`, expected data and timestamps; compare with the pinned DB state.
- `GET /maps/:id/versions`: unchanged summary shape. For a known two-version
  map, `GET /maps/:id/diff?from=1&to=2`: unchanged diff contract. Keep IDs and
  response payloads out of reports/logs.
- Public/shared map reads remain available without owner authorization. Existing
  owner's credentialed eligibility GET returns `{mapId,canEdit:true}`; missing
  established session is 401, non-owner/unknown is 404. Preserve `COOKIE_SECRET`
  and use a host-appropriate established owner session; a shared link is not
  editing authority.

Frontend files and browser integration were not inspected. Confirm:

- Additive `revision` on map/generation responses and `revision === version` on
  successful iteration. Preserve existing response fields.
- 409 `revision_conflict` carries `details.expectedBaseRevision` and
  `details.currentRevision`; refetch/review, with no silent automatic apply.
  503 `revision_not_ready` blocks editing; never switch to legacy/off behavior.
- One map/session-scoped canonical cache enforces a revision high-water mark:
  older GET/iteration/replayed responses cannot replace newer state. Refresh
  history/dependent views after acceptance; do not assume every GET is newest.
- Credentialed CORS and actual browser cookie delivery for deployed domains.
  The cookie is HttpOnly, `SameSite=Lax`, and Secure in production. Cross-site
  fetch is excluded by Lax even with credentials enabled; if the actual domains
  are cross-site, resolve routing/cookie policy under separate review before
  claiming owner editing works. [SameSite behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value).

## Incident boundary and remaining blockers

If deployment/readiness/smoke verification fails, keep mutable traffic blocked
and affected writers stopped. Preserve column, counters, snapshots, recovery
evidence and deployment logs; inspect status/history read-only. Do not disable
the gate and resume old writers, roll back to a legacy artifact, drop history,
replay migration/backfill blindly or restore over newer writes. Review a corrected
revision-aware build and a coordinated restart separately.

Before activation, resolve the unpublished source SHA, actual Render settings
and suspended-service replacement behavior, frontend cookie/error/cache
confirmation, and separate deployment/activation authorization. **STOP for review.**
No live flags, Render settings, database records or backend writer processes were
changed, and no deployment occurred. Project changes are limited to ignored build
output and this new report; verification metadata was kept outside Git. S4 was
not started.
