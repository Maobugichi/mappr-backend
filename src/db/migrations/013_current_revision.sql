-- S3A expansion only. Prepare for S3B; DO NOT run from application startup.
-- Existing maps remain NULL until separately reviewed, locked backfill.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public.maps ADD COLUMN current_revision integer;
COMMIT;
