
CREATE TABLE IF NOT EXISTS adrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  -- sha256 hex digest of {techStack, architecture} (see adr.ts's
  -- techArchHash) — NOT the map version. An iteration that only
  -- touches dataModel or features leaves this unchanged, so the
  -- existing ADRs for that hash stay valid and don't need regenerating.
  tech_arch_hash text NOT NULL,
  adrs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (map_id, tech_arch_hash)
);