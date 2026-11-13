# MAPPR BACKEND — S1 A1 DISPOSABLE POSTGRESQL VERIFICATION

## Objective
Close the single remaining A1 verification gap: the integration test was skipped because no disposable PostgreSQL target was configured. **This is verification only. Do not begin A2.**

## First inspect
- Read `BACKEND_S1_SCHEMA_BASELINE.md`, `BACKEND_CHANGE_CONTRACT.md`, and `src/db/baseline/README.md`.
- Inspect `src/db/baseline/001_existing_schema.sql`, `tests/db/schema-baseline.test.cjs`, and the Git diff.
- Identify the integration-test configuration already implemented. Follow its documented variables and safeguards; do not invent or weaken them.

## Target safety is mandatory
- Use only an explicitly identified, EMPTY, disposable PostgreSQL database intended for schema testing, preferably PostgreSQL 17.x.
- The test target must be separate from the existing Mappr application database. Never reuse or fall back to `DATABASE_URL`, `.env` production/development connection settings, or any existing database with user data.
- Do not connect to the configured application database to perform verification.
- Do not create/drop databases, reset schemas, or run SQL until disposable-target identity and emptiness are positively established under the test's safeguards.
- If an isolated disposable target is not available, leave the integration test skipped, document the blocker, and STOP. Do not bypass safety checks.

## When a safe disposable target is available
Run the existing A1 PostgreSQL integration test and confirm:
1. Baseline SQL creates all 13 application tables on an empty target.
2. Catalog comparison verifies 78 columns, 36 constraints, and 28 indexes, including types, defaults, nullability, PK/unique/FK definitions, FK delete actions, and index validity.
3. Existing-object detection fails closed and does not mutate a populated target.
4. FK semantics are tested using only synthetic fixture records: deleting a map cascades its artifacts/history but leaves usage records with a NULL map reference.
5. The test does not touch provider schemas or any live Mappr data.

Use bounded test execution and report any discrepancy precisely. Do not auto-fix the baseline to match assumptions; identify the SQL/catalog mismatch first.

## Deliverable
- Report exact executed commands and pass/skip/fail counts.
- State which behaviors were actually verified in PostgreSQL, which remain unverified, and why.
- If a small correction is necessary, limit it to A1 baseline/test/docs and explain it in the Git diff; do not silently change the verified inventory.
- Do not modify application routes, existing migrations, `package.json`, backend configuration, or the existing application database.
- STOP after A1 verification. **Do not proceed to A2 migration runner or database adoption.**
