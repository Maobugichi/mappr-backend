import { dailyAdmissionEnabled, reserveDailyAttempt, recordSuccessfulGeneration, cleanupDailyAttempt, dailyRouteError, type DailyAttempt } from '../services/dailyAdmission.js';
import { captureArtifactSource, publishArtifact, editReviewArtifact } from '../services/artifacts/provenance.js';
import { artifactRouteError } from '../middleware/artifactReads.js';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { generateArchitectureReview, ReviewValidationError } from '../services/architectureCritic.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';
import type { ArchitectureReview } from '../schema/architectureFinding.js';

const router = Router();

function toReview(row: {
  map_id: string;
  findings: unknown;
  created_at: Date;
  updated_at: Date;
}): ArchitectureReview {
  return {
    mapId: row.map_id,
    findings: row.findings as ArchitectureReview['findings'],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// GET /maps/:id/critique — return the stored review, if one exists.
router.get('/maps/:id/critique', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT map_id, findings, created_at, updated_at FROM architecture_reviews WHERE map_id = $1`,
      [id]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    return res.json(toReview(row));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/critique — run a fresh review and overwrite any existing one.
router.post('/maps/:id/critique', async (req, res) => {
  const { id } = req.params;
  const anonId = req.anonId;

  const rateLimitCheck = dailyAdmissionEnabled() ? { allowed: true as const } : await checkRateLimits(anonId);
  if (!rateLimitCheck.allowed) {
    if (rateLimitCheck.reason === 'global_limit') {
      return res.status(503).json({
        error: 'capacity_exceeded',
        message: 'Mappr has hit its daily generation capacity. Please try again later.',
      });
    }
    return res.status(429).json({
      error: 'daily_limit_exceeded',
      message: "You've used your free generations for today. Come back tomorrow, or upgrade for more.",
    });
  }

  let attempt: DailyAttempt | undefined;
  try {
    const source = await captureArtifactSource(String(id).toLowerCase(), anonId, 'critique');
    attempt = await reserveDailyAttempt({ actorId: anonId, mapId: source.mapId, operation: source.kind, id: source.generationId });
    const findings = await generateArchitectureReview(source.system);

    const saved = await publishArtifact(source, anonId, async client => {

      const { rows: reviewRows } = await client.query(
        `INSERT INTO architecture_reviews (map_id, findings)
         VALUES ($1, $2)
         ON CONFLICT (map_id) DO UPDATE SET findings = $2, updated_at = now()
         RETURNING map_id, findings, created_at, updated_at`,
        [id, JSON.stringify(findings)]
      );

      // Counts against the same daily budget as /generate — inserted
      // into the same table that rateLimit.ts already counts from, so
      // no change to the rate-limiting logic itself is needed.
      await recordSuccessfulGeneration(client, anonId, String(id).toLowerCase(), attempt);

      return reviewRows[0];
    });
    return res.status(201).json(toReview(saved));
  } catch (err) {
    await cleanupDailyAttempt(attempt);
    if (dailyRouteError(res, err)) return;
    if (artifactRouteError(res, err)) return;
    if (err instanceof ReviewValidationError) {
      console.error('Review validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'review_failed',
        message: "Mappr couldn't produce a valid architecture review for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const dismissBodySchema = z.object({
  dismissed: z.boolean(),
});

// PATCH /maps/:id/critique/findings/:findingId — persist a dismiss/undismiss.
router.patch('/maps/:id/critique/findings/:findingId', async (req, res) => {
  const { id, findingId } = req.params;

  const parsed = dismissBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }

  try {
    const row = await editReviewArtifact(String(id).toLowerCase(), req.anonId, 'critique', async client => {
      const { rows } = await client.query(
      `UPDATE architecture_reviews
       SET findings = (
         SELECT jsonb_agg(
           CASE WHEN elem->>'id' = $3
                THEN jsonb_set(elem, '{dismissed}', to_jsonb($2::boolean))
                ELSE elem END
         )
         FROM jsonb_array_elements(findings) AS elem
       ),
       updated_at = now()
       WHERE map_id = $1
       RETURNING map_id, findings, created_at, updated_at`,
      [id, parsed.data.dismissed, findingId]
    );

      return rows[0];
    });
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    return res.json(toReview(row));
  } catch (err) {
    if (artifactRouteError(res, err)) return;
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;