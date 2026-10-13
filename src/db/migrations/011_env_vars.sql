
CREATE TABLE IF NOT EXISTS env_vars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  -- sha256 hex digest of {techStack, architecture} (see adr.ts's
  -- techArchHash) — the same key 009_adrs.sql uses, NOT the map
  -- version. Adding a feature or editing the data model leaves it
  -- unchanged, so the variables stay valid; swapping the database or
  -- adding a service changes it, which is exactly when they go stale.
  tech_arch_hash text NOT NULL,
  vars jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (map_id, tech_arch_hash)
);