-- S4A PREPARATION ONLY. Apply separately after schema/recovery review.
-- No startup hook, existing-row backfill, billing policy or artifact rewrite.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

CREATE TABLE public.map_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES public.maps(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  preview_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  base_revision integer NOT NULL CHECK (base_revision > 0),
  base_fingerprint text NOT NULL CHECK (base_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('generating','ready','applied','failed','conflicted','expired')),
  admitted_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  expires_at timestamptz,
  candidate_fingerprint text CHECK (candidate_fingerprint ~ '^[a-f0-9]{64}$'),
  preview_response jsonb,
  terminal_error jsonb,
  validation_policy jsonb NOT NULL,
  generator_id text NOT NULL,
  applied_revision integer,
  applied_at timestamptz,
  apply_receipt jsonb,
  UNIQUE (actor_id,map_id,preview_key),
  UNIQUE (id,map_id),
  FOREIGN KEY (map_id,base_revision) REFERENCES public.map_versions(map_id,version),
  FOREIGN KEY (map_id,applied_revision) REFERENCES public.map_versions(map_id,version),
  CHECK (lease_expires_at > admitted_at),
  CHECK ((ready_at IS NULL AND expires_at IS NULL) OR (ready_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > ready_at)),
  CHECK (state NOT IN ('ready','applied','expired') OR
    (ready_at IS NOT NULL AND candidate_fingerprint IS NOT NULL AND preview_response IS NOT NULL)),
  CHECK (state NOT IN ('failed','conflicted') OR terminal_error IS NOT NULL),
  CHECK ((state = 'applied' AND applied_revision IS NOT NULL AND applied_revision::bigint = base_revision::bigint + 1 AND applied_at IS NOT NULL AND apply_receipt IS NOT NULL)
    OR (state <> 'applied' AND applied_revision IS NULL AND applied_at IS NULL AND apply_receipt IS NULL))
);
-- Internal proposals contain instructions, diffs and immutable replay receipts.
-- Supabase may grant ordinary clients access through default table privileges.
-- Keep all creation/protection in this transaction: no client permit policies.
-- Backend access requires table ownership, or BYPASSRLS plus retained grants;
-- do not FORCE RLS or grant access to an anonymous/session actor here.
ALTER TABLE public.map_change_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.map_change_proposals FROM PUBLIC;
DO $proposal_privacy$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    -- Vanilla isolated PostgreSQL need not contain Supabase's client roles.
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.map_change_proposals FROM %I',client_role);
      -- Direct revocation cannot remove privileges inherited from another role.
      -- Fail closed rather than change unrelated memberships/default grants.
      -- Include privileges (e.g. TRUNCATE) that RLS alone does not constrain.
      IF pg_catalog.has_table_privilege(client_role,'public.map_change_proposals',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Proposal privacy requires removal of inherited client privileges'
          USING ERRCODE='42501';
      END IF;
    END IF;
  END LOOP;
END;
$proposal_privacy$;
CREATE INDEX map_change_proposals_owner_state_expiry_idx
  ON public.map_change_proposals (actor_id,map_id,state,expires_at);

ALTER TABLE public.map_versions ADD COLUMN proposal_id uuid;
ALTER TABLE public.map_versions ADD COLUMN change_metadata jsonb;
ALTER TABLE public.map_versions ADD CONSTRAINT map_versions_proposal_id_key UNIQUE (proposal_id);
ALTER TABLE public.map_versions ADD CONSTRAINT map_versions_proposal_map_fkey
  FOREIGN KEY (proposal_id,map_id) REFERENCES public.map_change_proposals(id,map_id);
COMMIT;
