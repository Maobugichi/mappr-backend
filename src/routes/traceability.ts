import { dailyAdmissionEnabled, reserveDailyAttempt, recordSuccessfulGeneration, cleanupDailyAttempt, dailyRouteError, type DailyAttempt } from '../services/dailyAdmission.js';
import { captureArtifactSource, publishArtifact } from '../services/artifacts/provenance.js';
import { artifactRouteError } from '../middleware/artifactReads.js';
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateTraceability, TraceabilityValidationError } from '../services/traceability.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';
import type { TraceabilityReview } from '../schema/traceability.js';

const router = Router();

function toReview(row: {
  map_id: string;
  links: unknown;
  created_at: Date;
  updated_at: Date;
}): TraceabilityReview {
  return {
    mapId: row.map_id,
    links: row.links as TraceabilityReview['links'],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// GET /maps/:id/traceability — return the stored trace, if one exists.
router.get('/maps/:id/traceability', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT map_id, links, created_at, updated_at FROM traceability_reviews WHERE map_id = $1`,
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

// POST /maps/:id/traceability — run a fresh trace, overwriting any existing one.
router.post('/maps/:id/traceability', async (req, res) => {
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
    const source = await captureArtifactSource(String(id).toLowerCase(), anonId, 'traceability');
    attempt = await reserveDailyAttempt({ actorId: anonId, mapId: source.mapId, operation: source.kind, id: source.generationId });
    const links = await generateTraceability(source.system);

    const saved = await publishArtifact(source, anonId, async client => {

      const { rows: reviewRows } = await client.query(
        `INSERT INTO traceability_reviews (map_id, links)
         VALUES ($1, $2)
         ON CONFLICT (map_id) DO UPDATE SET links = $2, updated_at = now()
         RETURNING map_id, links, created_at, updated_at`,
        [id, JSON.stringify(links)]
      );

      // Shares the daily budget with /generate and the other reviews —
      // same table, same counting logic in rateLimit.ts.
      await recordSuccessfulGeneration(client, anonId, String(id).toLowerCase(), attempt);

      return reviewRows[0];
    });
    return res.status(201).json(toReview(saved));
  } catch (err) {
    await cleanupDailyAttempt(attempt);
    if (dailyRouteError(res, err)) return;
    if (artifactRouteError(res, err)) return;
    if (err instanceof TraceabilityValidationError) {
      console.error('Traceability validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'traceability_failed',
        message: "Mappr couldn't produce a valid trace for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;