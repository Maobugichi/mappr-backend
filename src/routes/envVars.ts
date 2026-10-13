import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateEnvVars, EnvVarsValidationError } from '../services/envVars.js';
import { renderEnvVars } from '../services/envVarsRender.js';
import { techArchHash } from '../services/adr.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';
import type { EnvVar, EnvVarSetRecord } from '../schema/envVars.js';

const router = Router();

function toRecord(row: {
  map_id: string;
  tech_arch_hash: string;
  vars: unknown;
  created_at: Date;
  updated_at: Date;
}): EnvVarSetRecord {
  return {
    mapId: row.map_id,
    techArchHash: row.tech_arch_hash,
    vars: row.vars as EnvVar[],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadSystem(mapId: string): Promise<MapprSystem | null> {
  const { rows } = await pool.query(`SELECT data FROM maps WHERE id = $1`, [mapId]);
  const map = rows[0];
  if (!map) return null;

  const parsed = MapprSystemSchema.safeParse(map.data);
  if (!parsed.success) {
    console.error('Stored map failed MapprSystem validation:', parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

// GET /maps/:id/env-vars — the stored variable set for the map's
// current techStack+architecture hash, if one exists. Same
// hash-not-version behavior as GET /maps/:id/adrs: an iteration that
// only touched dataModel or features leaves the hash, and therefore the
// stored set, unchanged.
router.get('/maps/:id/env-vars', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(
      `SELECT map_id, tech_arch_hash, vars, created_at, updated_at FROM env_vars WHERE map_id = $1 AND tech_arch_hash = $2`,
      [id, hash]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    return res.json(toRecord(row));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /maps/:id/env-vars/file — renders the stored current-hash
// variables to the .env.example text. Nothing AI-generated in this
// step; renderEnvVars is pure code, and it needs the live system for
// the architecture node labels it groups sections by.
router.get('/maps/:id/env-vars/file', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(
      `SELECT vars FROM env_vars WHERE map_id = $1 AND tech_arch_hash = $2`,
      [id, hash]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    const file = renderEnvVars(row.vars as EnvVar[], system);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(file);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/env-vars — generate the variable set for the map's
// current techStack+architecture hash, overwriting any existing set for
// that same hash. A set generated for a hash that's since changed is
// left in place, same as ADRs.
router.post('/maps/:id/env-vars', async (req, res) => {
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
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const vars = await generateEnvVars(system);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: varRows } = await client.query(
        `INSERT INTO env_vars (map_id, tech_arch_hash, vars)
         VALUES ($1, $2, $3)
         ON CONFLICT (map_id, tech_arch_hash) DO UPDATE SET vars = $3, updated_at = now()
         RETURNING map_id, tech_arch_hash, vars, created_at, updated_at`,
        [id, hash, JSON.stringify(vars)]
      );

      // Shares the daily budget with the other AI-backed features —
      // same table, same counting logic in rateLimit.ts.
      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json(toRecord(varRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof EnvVarsValidationError) {
      console.error('Env vars validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'env_vars_failed',
        message: "Mappr couldn't produce valid environment variables for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;