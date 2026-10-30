
CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  -- sha256 hex digest of {techStack, architecture} (see adr.ts's
  -- techArchHash) — the same key 009_adrs.sql and 011_env_vars.sql use,
  -- NOT the map version. Where components run depends on exactly those
  -- two sections, so a features-only or data-model-only edit leaves it
  -- unchanged and the stored runbook stays valid.
  tech_arch_hash text NOT NULL,
  components jsonb NOT NULL,
  environments jsonb NOT NULL,
  cicd_steps jsonb NOT NULL,
  -- How and when database migrations are applied. Null when the system
  -- has no database.
  migrations text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (map_id, tech_arch_hash)
);