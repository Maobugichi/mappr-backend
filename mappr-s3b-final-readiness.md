# MAPPR — S3B FINAL RUNTIME READINESS (NO DATABASE WRITES)

## Purpose
The S3B cutover preparation is complete. This task is the final, bounded operational readiness check before a separately approved development-database cutover. **Do not implement another migration framework or start S4.**

Read `BACKEND_S3B_CUTOVER_PREPARATION.md`, `BACKEND_S3B_PREFLIGHT.md`, `BACKEND_S3A_IMPLEMENTATION.md`, and the current `src/db/s3bCutover.ts` and `scripts/s3b-cutover.mjs`. Inspect Git status and preserve all changes.

The user confirms the existing database is used exclusively for development and testing. It is okay to inspect that database read-only, but do not use this assertion as a substitute for verifying the configured target.

## Tasks

1. **Identify target safely.** Verify which development PostgreSQL target the app uses without printing URLs, passwords, tokens, private map IDs, or owner IDs. Do not use a different/production target, and never output `.env` secrets. Confirm the new operator CLI's required configuration shape. If safe, prepare its private configuration **outside the repository** with restricted file permissions, following the existing tool's rules; do not commit it or put credentials in command history. Do not silently change TLS verification.

2. **Run status only, if configured.** Use `node --import tsx scripts/s3b-cutover.mjs --mode status --config "<verified-private-config-path>"` against the positively identified development target. It must operate READ ONLY. Record aggregate results: schema compatibility, current-revision column presence, map/history inventory, quarantine count, `columnPresent` and `revisionReady`, target fingerprint (opaque only), and any blockers. Independently verify target identity before treating a fingerprint as approved. If the private configuration or positive target verification is unavailable, stop and report the smallest specific missing prerequisite. Do not fake green status or substitute the application connection URL as CLI fallback.

3. **Verify recoverability.** Determine whether the actual database provider has a completed usable backup/restore facility, or whether compatible PostgreSQL tools are available for an offline private backup. A backup artifact must be stored outside Git and must not be displayed or shared. Confirm a credible restore path/verification, not just a backup setting or successful archive listing. Do not perform a restoration on the current database. If no backup and recovery evidence is available, state exactly what the developer must configure next.

4. **Identify writers.** Enumerate only the running services/processes that can write canonical `maps.data` to this verified target. Document how the developer can stop/drain them before cutover. Do not indiscriminately kill processes or stop service supervisors in this read-only task.

5. **Report GO/NO-GO.** Write `BACKEND_S3B_FINAL_READINESS.md` with confirmed facts, safe aggregate status results, actual backup/recovery evidence, writer inventory, remaining blockers, and the smallest next action to complete the cutover. Distinguish observed facts from assumptions. Avoid another broad architecture audit.

## Hard stops
- No migration 013 execution.
- No database data modification or backfill.
- No revision feature flag change.
- No application routes/AI service changes.
- No S4 work.
- Do not expose or commit credentials or sensitive map data.
- Never invent backup evidence or declare the cutover approved.

Stop after the readiness report. The actual migration/backfill/activation requires a separately reviewed explicit execution instruction.
