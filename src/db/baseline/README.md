# Existing application schema baseline (S1 / A1)

`001_existing_schema.sql` is a new consolidated baseline boundary for the
existing Mappr application schema. It is **not** a recovered historical migration
and must not be applied to an existing Mappr database. A1 adds only this SQL,
these instructions, and `tests/db/schema-baseline.test.cjs`.

## Evidence and limits

The source is [the S1 report](../../../BACKEND_S1_SCHEMA_BASELINE.md), backed by
the read-only catalog inspection on 2026-11-06 at 05:23:39 UTC. The later aggregate
inspection at 05:27:29 UTC did not establish migration execution history or validate
every payload/owner. A1 uses the retained inspection evidence; it does not reconnect
to the application database. This is one observed configured database, not proof
that all environments have the same schema.

The expected reproduction target is **PostgreSQL 17**, matching the observed 17.6
server. `pg_catalog.gen_random_uuid()` must already resolve. PostgreSQL 17 provides
the function on the inspected target; the baseline checks its availability instead
of installing extensions. Provider schemas, roles, grants, vaults, secrets, records,
and unrelated extensions are deliberately excluded. Differences in deployment
grants/default privileges require separate operations review.

The baseline preserves 13 tables, 78 ordered columns, 36 named PK/UNIQUE/FK
constraints, and 28 indexes. Of the indexes, 24 are supplied by primary/unique
constraints; only the other four have explicit `CREATE INDEX` statements.

| Tables | Existing repository coverage |
| --- | --- |
| `maps`, `generations`, `map_versions` | No tracked historical definitions recovered |
| `missing_requirement_reviews`, `traceability_reviews`, `api_contracts` | No tracked historical definitions recovered |
| `architecture_reviews` | `src/db/migrations/002_architecture_reviews.sql` |
| `relational_schemas` | `src/db/migrations/007_relational_schemas.sql` |
| `document_schemas` | `src/db/migrations/008_document_schemas.sql` |
| `adrs` | `src/db/migrations/009_adrs.sql` |
| `readmes` | `src/db/migrations/010_readmes.sql` |
| `env_vars` | `src/db/migrations/011_env_vars.sql` |
| `deployments` | `src/db/migrations/012_deployments.sql` |

The seven tracked migrations remain untouched. Matching their structures does not
prove that those files ran. Missing `001_init.sql` and `003`-`006` files are not
invented, and existing migration numbers are not repurposed.

## Preserved behavior and comparison requirements

- All IDs are UUID primary keys with `gen_random_uuid()` defaults. Creation/update
  timestamps are non-null `timestamptz DEFAULT now()` where present; usage and
  version rows have no `updated_at` column. No timestamp-update trigger is added.
- Only `generations.map_id`, `map_versions.patch`, and `deployments.migrations`
  are nullable. Usage rows survive map deletion with `map_id` set to NULL; history
  and all ten artifact/review tables cascade on map deletion.
- Preserve exact observed key/index names and definitions. Reviews are unique by
  map; versioned artifacts/history by map/version; ADR/environment/deployment
  artifacts by map/hash. Artifact versions have no FK to history snapshots.
- Preserve `idx_maps_anon_id`, `idx_generations_anon_id_created_at`,
  `idx_generations_created_at`, and `map_versions_map_id_version_idx`, including
  descending version order. Do not remove apparent index overlap during A1.
- Compare every column's order/type/default/nullability, named constraint and
  delete action, and index uniqueness/primary/valid/ready state. All 36 constraints
  must be validated and nondeferrable. Default RLS remains disabled, with no custom
  triggers or speculative CHECK constraints. Anonymous UUIDs gain no auth-user FK.
- There is no revision column, proposal table, quota reservation state, provenance
  column, migration ledger, schema adoption, or data backfill in this baseline.

## Safety boundary: bootstrap versus adoption

An **empty disposable bootstrap** creates the existing schema in a separately
provisioned test database. **Existing-database adoption** verifies an existing
schema and records a new baseline boundary without replaying creation SQL. These
are different operations. A1 authorizes neither live adoption nor live migration;
the SQL file is not a migration runner.

The file uses one transaction and a pre-DDL guard that rejects any relation in
`public`. Each table/index also uses plain `CREATE`, never `IF NOT EXISTS`.
Any conflict must abort the transaction rather than silently skip drift. The guard
is not target authorization: an empty public schema alone does not prove a database
is disposable. Never execute this file manually against the application connection.
Do not run the broken `npm run migrate` command or add an application-startup hook.

## Verification

From the repository root, run:

```powershell
node --check tests/db/schema-baseline.test.cjs
node --test tests/db/schema-baseline.test.cjs
```

With no dedicated test settings, six offline checks validate the baseline's bounded
SQL structure/inventory and the connection-isolation rules. The PostgreSQL test is
explicitly **SKIPPED: SQL reproduction NOT verified**. Passing offline tests is not
proof of PostgreSQL syntax, live catalog equality, delete semantics, or deployment
compatibility. No new test dependency or `package.json` script is required.

### Optional isolated PostgreSQL test

Before enabling SQL tests, an operator must separately provision and explicitly
approve an otherwise empty, exclusively reserved PostgreSQL 17 database. This test
does not provision, reset, drop, truncate, or automatically delete a database.
Never designate the application database as disposable.

All three settings must be supplied independently in the test process environment:

| Setting | Required value |
| --- | --- |
| `MAPPR_SCHEMA_TEST_DATABASE_URL` | The separately provisioned test connection; never copied from or defaulted to `DATABASE_URL` |
| `MAPPR_SCHEMA_TEST_DATABASE_NAME` | Exact database name, matching `mappr_schema_test_[a-z0-9_]+` |
| `MAPPR_SCHEMA_TEST_DISPOSABLE` | Exactly `I_ACCEPT_DISPOSABLE_DATABASE_ONLY` |

Additionally, the operator must mark that disposable database's **database comment**
as `mappr-a1-disposable:<database-name>`, with its exact name substituted. The test
reads this server-side marker; it never creates/changes it. Provisioning/marking is
an operator action outside the test and must not be performed on a working database.
Do not commit connection values or identifiers to this repository.

The dedicated URL must explicitly contain host, database, username, password, and
exactly one `sslmode` query parameter; other query parameters are rejected.
`sslmode=disable` is allowed only on loopback hosts. `require` and `verify-full`
both require certificate verification in this harness. Partial configuration,
uncertain identity, an unsupported major version, missing marker, or a nonempty
public schema is a **failure**, not a skip or reason to relax the guard.

The harness does not load `.env` into the environment. When an isolated test is
explicitly enabled, it parses `.env` only to exclude the application's database
name, also checking `process.env.DATABASE_URL`. It never connects through either
application URL or falls back to `PGHOST`/other default connection values. It
rejects matching application database names even across differing host aliases.
The independently supplied test name and server marker are additional mandatory
proofs, not permissions inferred from an empty schema.

Once enabled, the test:

1. Uses a bounded read-only preflight to verify database name, server marker,
   PostgreSQL major version, and an empty public relation namespace.
2. Starts its own isolated transaction, acquires a test-scoped advisory lock,
   repeats the preflight, and executes the baseline's unchanged transaction body.
   The file's outer `BEGIN`/`COMMIT` are replaced by the test-owned boundary.
3. Compares all 13 tables/78 columns/36 constraints/28 indexes with an independent
   S1 inventory, including UUID availability, RLS flags, and absence of custom
   triggers. A savepoint checks that replay on existing objects is rejected.
4. Creates only synthetic rows in its newly created tables, deletes the synthetic
   map, and checks SET NULL usage retention versus CASCADE history/artifact removal.
5. Rolls back all created objects and fixtures even on success. No COMMIT, DROP,
   TRUNCATE, destructive reset, cleanup database, or new cleanup connection is used.
   Connection/record details are withheld from errors; no IDs or credentials are
   printed. If cleanup fails, it reports failure and does not improvise a reset.

Use the same `node --test` command once all isolation requirements are met. Network
or permission failures fail the isolated test; they never trigger an application
database fallback. Review its actual executed/skipped status before claiming schema
reproduction. No isolated configuration was provided for the initial A1 delivery;
live reproduction remains unverified until this test runs in an approved target.

## A2 handoff: not implemented

After human review of A1, A2 can propose a portable migration runner, checksum/lock
policy, a separate Mappr migration ledger, and an explicit existing-schema adoption
path. It must distinguish read-only status/check, empty bootstrap, approved adoption,
and future upgrades. A recorded adopted baseline must not pretend old SQL files ran.
Future migration enumeration must not replay the legacy files already covered here.

Before any adoption/application: confirm target identity, compare a fresh catalog
with this baseline, review environment-specific permissions, and establish tested
backup/restore and rollback procedures. Schema drift is a blocker requiring review.
The current `package.json` migration command remains unchanged and broken by design
in A1; replacing it belongs to A2. S2 ownership changes, S3 revisions, S4 proposals,
S5 freshness, universal endpoints, and frontend work remain outside this change.
