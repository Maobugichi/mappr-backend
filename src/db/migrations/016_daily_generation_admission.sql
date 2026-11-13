-- S4D additive preparation only. Run separately after 014/015 and isolation review.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
CREATE TABLE public.daily_admission_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  policy_version text NOT NULL CHECK (policy_version='daily-success-v1'),
  quota_timezone text NOT NULL
);
-- Capture, do not redefine, the deployment's existing SQL day boundary.
INSERT INTO public.daily_admission_policy(singleton,policy_version,quota_timezone)
  VALUES (true,'daily-success-v1',current_setting('TimeZone'));
CREATE TABLE public.generation_attempts (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  map_id uuid REFERENCES public.maps(id) ON DELETE SET NULL,
  proposal_id uuid UNIQUE REFERENCES public.map_change_proposals(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('generate','iterate','overview_preview','api_contract','relational_schema','document_schema','readme','adrs','env_vars','deployment','critique','requirements','traceability')),
  policy_version text NOT NULL CHECK (policy_version='daily-success-v1'),
  quota_day_start timestamptz NOT NULL,
  quota_day_end timestamptz NOT NULL CHECK (quota_day_end>quota_day_start),
  quota_timezone text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','succeeded','failed')),
  admitted_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL CHECK (lease_expires_at>admitted_at),
  finished_at timestamptz,
  UNIQUE (id,actor_id),
  CHECK (admitted_at>=quota_day_start AND admitted_at<quota_day_end),
  CHECK ((state='reserved' AND finished_at IS NULL) OR (state<>'reserved' AND finished_at IS NOT NULL)),
  CHECK (proposal_id IS NULL OR (operation='overview_preview' AND id=proposal_id))
);
CREATE INDEX generation_attempts_day_actor_idx ON public.generation_attempts(quota_day_start,quota_day_end,actor_id);
CREATE INDEX generation_attempts_expired_idx ON public.generation_attempts(lease_expires_at,id) WHERE state='reserved';
ALTER TABLE public.generations ADD COLUMN attempt_id uuid;
ALTER TABLE public.generations ADD CONSTRAINT generations_attempt_id_key UNIQUE (attempt_id);
ALTER TABLE public.generations ADD CONSTRAINT generations_attempt_actor_fkey
  FOREIGN KEY (attempt_id,anon_id) REFERENCES public.generation_attempts(id,actor_id);
ALTER TABLE public.generation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_admission_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_attempts,public.daily_admission_policy FROM PUBLIC;
-- RLS alone cannot prevent TRUNCATE. Revoke Supabase-like direct defaults on
-- both internal tables, preserving backend-owner access. Unexpected inherited
-- privileges abort this entire migration, including the policy and usage links.
DO $admission_privacy$
DECLARE private_table text; client_role text;
BEGIN
  FOREACH private_table IN ARRAY ARRAY['daily_admission_policy','generation_attempts'] LOOP
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',private_table,client_role);
        IF pg_catalog.has_table_privilege(client_role,format('public.%I',private_table),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') THEN
          RAISE EXCEPTION 'Daily admission privacy requires removal of inherited client privileges on %',private_table
            USING ERRCODE='42501';
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END;
$admission_privacy$;
-- No historical usage/map/artifact backfill, automatic cleanup, payments or wallet.
COMMIT;
