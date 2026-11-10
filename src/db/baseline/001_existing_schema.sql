-- Consolidated application baseline, based on the 2026-11-06 S1 catalog.
-- New baseline boundary: not the missing historical 001_init.sql.
-- Only for an explicitly approved EMPTY disposable PostgreSQL 17 database.
-- Never execute against an existing Mappr database or as an adoption step.

BEGIN;

SET LOCAL search_path = pg_catalog, public;

-- Check the whole public relation namespace before creating any application
-- object. Plain CREATE statements below also reject name collisions.
DO $baseline$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Baseline requires an empty disposable public schema';
  END IF;

  IF pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'Baseline requires the PostgreSQL gen_random_uuid() function';
  END IF;
END;
$baseline$;

CREATE TABLE public.maps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  anon_id uuid NOT NULL,
  input_description text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maps_pkey PRIMARY KEY (id)
);

CREATE TABLE public.generations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  anon_id uuid NOT NULL,
  map_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generations_pkey PRIMARY KEY (id),
  CONSTRAINT generations_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE SET NULL
);

CREATE TABLE public.map_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL,
  patch jsonb,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT map_versions_pkey PRIMARY KEY (id),
  CONSTRAINT map_versions_map_id_version_key UNIQUE (map_id, version),
  CONSTRAINT map_versions_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.architecture_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  findings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT architecture_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT architecture_reviews_map_id_key UNIQUE (map_id),
  CONSTRAINT architecture_reviews_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.missing_requirement_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  findings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missing_requirement_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT missing_requirement_reviews_map_id_key UNIQUE (map_id),
  CONSTRAINT missing_requirement_reviews_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.traceability_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  links jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT traceability_reviews_map_id_key UNIQUE (map_id),
  CONSTRAINT traceability_reviews_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.api_contracts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  version integer NOT NULL,
  endpoints jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_contracts_pkey PRIMARY KEY (id),
  CONSTRAINT api_contracts_map_id_version_key UNIQUE (map_id, version),
  CONSTRAINT api_contracts_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.relational_schemas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  version integer NOT NULL,
  tables jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relational_schemas_pkey PRIMARY KEY (id),
  CONSTRAINT relational_schemas_map_id_version_key UNIQUE (map_id, version),
  CONSTRAINT relational_schemas_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.document_schemas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  version integer NOT NULL,
  collections jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_schemas_pkey PRIMARY KEY (id),
  CONSTRAINT document_schemas_map_id_version_key UNIQUE (map_id, version),
  CONSTRAINT document_schemas_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.adrs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  tech_arch_hash text NOT NULL,
  adrs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adrs_pkey PRIMARY KEY (id),
  CONSTRAINT adrs_map_id_tech_arch_hash_key UNIQUE (map_id, tech_arch_hash),
  CONSTRAINT adrs_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.readmes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  version integer NOT NULL,
  overview text NOT NULL,
  getting_started jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT readmes_pkey PRIMARY KEY (id),
  CONSTRAINT readmes_map_id_version_key UNIQUE (map_id, version),
  CONSTRAINT readmes_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.env_vars (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  tech_arch_hash text NOT NULL,
  vars jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_vars_pkey PRIMARY KEY (id),
  CONSTRAINT env_vars_map_id_tech_arch_hash_key UNIQUE (map_id, tech_arch_hash),
  CONSTRAINT env_vars_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE TABLE public.deployments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL,
  tech_arch_hash text NOT NULL,
  components jsonb NOT NULL,
  environments jsonb NOT NULL,
  cicd_steps jsonb NOT NULL,
  migrations text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployments_pkey PRIMARY KEY (id),
  CONSTRAINT deployments_map_id_tech_arch_hash_key UNIQUE (map_id, tech_arch_hash),
  CONSTRAINT deployments_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.maps(id) ON DELETE CASCADE
);

CREATE INDEX idx_maps_anon_id ON public.maps USING btree (anon_id);
CREATE INDEX idx_generations_anon_id_created_at ON public.generations USING btree (anon_id, created_at);
CREATE INDEX idx_generations_created_at ON public.generations USING btree (created_at);
CREATE INDEX map_versions_map_id_version_idx ON public.map_versions USING btree (map_id, version DESC);

COMMIT;
