
CREATE TABLE IF NOT EXISTS architecture_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL UNIQUE REFERENCES maps(id) ON DELETE CASCADE,
  findings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);