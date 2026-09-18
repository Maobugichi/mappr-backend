import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { generateIteration, IterationValidationError } from '../services/architectureIteration.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';

const router = Router();

const iterateBodySchema = z.object({
  instruction: z.string().min(1).max(2000),
});

// POST /maps/:id/iterate — apply a natural-language architecture change.
//
// Versioning: `maps.data` always holds the current version (every other
// view already reads from there, so nothing else needed to change).
// `map_versions` holds full snapshots. Version 1 is backfilled lazily
// here, the first time a map is ever iterated on — maps created before
// this feature existed have no version 1 row until their first
// iteration, at which point the map's current data becomes version 1
// and the patch becomes version 2. This avoids touching /generate.
router.post('/maps/:id/iterate', async (req, res) => {
  const { id } = req.params;
  const anonId = req.anonId;

  const parsedBody = iterateBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsedBody.error.flatten() });
  }

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

    // The Gemini call happens before any connection is checked out —
    // holding a pooled connection idle for the duration of an external
    // API call would be wasteful and risks exhausting the pool under
    // load. Only the actual writes below need a dedicated client (for
    // the transaction).
    const result = await generateIteration(systemParse.data, parsedBody.data.instruction);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the map row for the duration of this transaction — any
      // other iteration on this same map now blocks here until this one
      // commits or rolls back, instead of racing to read the same max
      // version and colliding on the UNIQUE (map_id, version) insert
      // below. The version number is computed after acquiring this
      // lock, not before, so it's read-and-write atomic per map.
      await client.query(`SELECT id FROM maps WHERE id = $1 FOR UPDATE`, [id]);

      const { rows: versionRows } = await client.query(
        `SELECT COALESCE(MAX(version), 0) AS max_version FROM map_versions WHERE map_id = $1`,
        [id]
      );
      let nextVersion = Number(versionRows[0].max_version);

      if (nextVersion === 0) {
        // Backfill version 1 as the pre-iteration baseline.
        await client.query(
          `INSERT INTO map_versions (map_id, version, data, patch, summary)
           VALUES ($1, 1, $2, NULL, 'Initial generation')`,
          [id, JSON.stringify(map.data)]
        );
        nextVersion = 1;
      }

      nextVersion += 1;

      await client.query(
        `INSERT INTO map_versions (map_id, version, data, patch, summary)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          nextVersion,
          JSON.stringify(result.newSystem),
          JSON.stringify(result.groundedPatch),
          result.summary,
        ]
      );

      await client.query(`UPDATE maps SET data = $1, updated_at = now() WHERE id = $2`, [
        JSON.stringify(result.newSystem),
        id,
      ]);

      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json({
        mapId: id,
        version: nextVersion,
        summary: result.summary,
        patch: result.groundedPatch,
        data: result.newSystem,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof IterationValidationError) {
      console.error('Iteration validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'iteration_failed',
        message: "Mappr couldn't apply that change. Try rephrasing the instruction.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /maps/:id/versions — lightweight version history (no full snapshots).
router.get('/maps/:id/versions', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT version, summary, created_at FROM map_versions WHERE map_id = $1 ORDER BY version DESC`,
      [id]
    );

    return res.json(
      rows.map((row) => ({
        version: row.version,
        summary: row.summary,
        createdAt: row.created_at.toISOString(),
      }))
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;