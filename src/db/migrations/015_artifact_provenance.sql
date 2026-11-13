-- S5A additive preparation only. No automatic execution or legacy backfill.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
CREATE TABLE public.artifact_generations (
  id uuid PRIMARY KEY,
  map_id uuid NOT NULL REFERENCES public.maps(id) ON DELETE CASCADE,
  artifact_type text NOT NULL CHECK (artifact_type IN ('api_contract','relational_schema','document_schema','readme','adrs','env_vars','deployment','critique','requirements','traceability')),
  storage_key text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('generated','review_edit','legacy','legacy_edit')),
  source_revision integer,
  input_fingerprint text CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  generator_version text,
  dependency_policy text,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  parent_id uuid REFERENCES public.artifact_generations(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,map_id),
  FOREIGN KEY (map_id,source_revision) REFERENCES public.map_versions(map_id,version),
  CHECK ((origin IN ('generated','review_edit') AND source_revision IS NOT NULL AND source_revision>0
    AND input_fingerprint IS NOT NULL AND generator_version IS NOT NULL AND dependency_policy IS NOT NULL)
    OR (origin IN ('legacy','legacy_edit') AND source_revision IS NULL AND input_fingerprint IS NULL
      AND generator_version IS NULL AND dependency_policy IS NULL))
);
CREATE INDEX artifact_generations_map_type_published_idx ON public.artifact_generations(map_id,artifact_type,published_at DESC,id DESC);
-- Internal snapshots must not become a new direct client/history API through
-- inherited provider grants. The backend role must own/bypass RLS on this new
-- table; verify that privilege explicitly before rollout. Existing tables and
-- public/shared HTTP reads retain their current access rules.
ALTER TABLE public.artifact_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_generations FROM PUBLIC;
-- RLS does not restrict TRUNCATE or REFERENCES. Remove direct client defaults
-- as well, and fail closed if an indirect grant survives. Keep backend-owner
-- access; no FORCE RLS, client policies or unrelated default/membership changes.
DO $artifact_privacy$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.artifact_generations FROM %I',client_role);
      IF pg_catalog.has_table_privilege(client_role,'public.artifact_generations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') THEN
        RAISE EXCEPTION 'Artifact privacy requires removal of inherited client privileges'
          USING ERRCODE='42501';
      END IF;
    END IF;
  END LOOP;
END;
$artifact_privacy$;
-- Current-table projections keep all existing keys and records. New publication
-- archives a replaced unverified row on demand; no historical source is invented.
ALTER TABLE public.api_contracts ADD COLUMN generation_id uuid;
ALTER TABLE public.relational_schemas ADD COLUMN generation_id uuid;
ALTER TABLE public.document_schemas ADD COLUMN generation_id uuid;
ALTER TABLE public.readmes ADD COLUMN generation_id uuid;
ALTER TABLE public.adrs ADD COLUMN generation_id uuid;
ALTER TABLE public.env_vars ADD COLUMN generation_id uuid;
ALTER TABLE public.deployments ADD COLUMN generation_id uuid;
ALTER TABLE public.architecture_reviews ADD COLUMN generation_id uuid;
ALTER TABLE public.missing_requirement_reviews ADD COLUMN generation_id uuid;
ALTER TABLE public.traceability_reviews ADD COLUMN generation_id uuid;
DO $provenance$
DECLARE artifact_table text;
BEGIN
  FOREACH artifact_table IN ARRAY ARRAY['api_contracts','relational_schemas','document_schemas','readmes','adrs','env_vars','deployments','architecture_reviews','missing_requirement_reviews','traceability_reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (generation_id,map_id) REFERENCES public.artifact_generations(id,map_id)', artifact_table, artifact_table || '_generation_map_fkey');
  END LOOP;
END;
$provenance$;
COMMIT;
