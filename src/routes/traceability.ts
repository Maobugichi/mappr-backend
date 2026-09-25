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

  const rateLimitCheck = await checkRateLimits(anonId);
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

  try {
    const { rows: mapRows } = await pool.query(`SELECT id, data FROM maps WHERE id = $1`, [id]);
    const map = mapRows[0];
    if (!map) {
      return res.status(404).json({ error: 'not_found' });
    }

    const systemParse = MapprSystemSchema.safeParse(map.data);
    if (!systemParse.success) {
      console.error('Stored map failed MapprSystem validation:', systemParse.error.flatten());
      return res.status(500).json({ error: 'internal_error' });
    }

    const links = await generateTraceability(systemParse.data);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: reviewRows } = await client.query(
        `INSERT INTO traceability_reviews (map_id, links)
         VALUES ($1, $2)
         ON CONFLICT (map_id) DO UPDATE SET links = $2, updated_at = now()
         RETURNING map_id, links, created_at, updated_at`,
        [id, JSON.stringify(links)]
      );

      // Shares the daily budget with /generate and the other reviews —
      // same table, same counting logic in rateLimit.ts.
      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json(toReview(reviewRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
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