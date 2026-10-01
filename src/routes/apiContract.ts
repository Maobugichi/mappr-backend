import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateApiContract, ApiContractValidationError } from '../services/apiContract.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';
import type { ApiContract } from '../schema/apiContract.js';

const router = Router();

function toContract(row: {
  map_id: string;
  version: number;
  endpoints: unknown;
  created_at: Date;
  updated_at: Date;
}): ApiContract {
  return {
    mapId: row.map_id,
    version: row.version,
    endpoints: row.endpoints as ApiContract['endpoints'],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// A map that has never been iterated has no map_versions rows yet — its
// data is implicitly version 1 (see the versioning note in iterate.ts).
async function currentVersion(mapId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(version), 1) AS version FROM map_versions WHERE map_id = $1`,
    [mapId]
  );
  return Number(rows[0].version);
}

// GET /maps/:id/api-contract — return the stored contract for the map's
// current version, if one exists. A contract generated for an older
// version is not returned; the caller should regenerate.
router.get('/maps/:id/api-contract', async (req, res) => {
  const { id } = req.params;

  try {
    const version = await currentVersion(id);

    const { rows } = await pool.query(
      `SELECT map_id, version, endpoints, created_at, updated_at FROM api_contracts WHERE map_id = $1 AND version = $2`,
      [id, version]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    return res.json(toContract(row));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/api-contract — generate a contract for the map's current
// version, overwriting any existing contract for that same version.
// Contracts for other versions, if any, are left untouched.
router.post('/maps/:id/api-contract', async (req, res) => {
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

    const version = await currentVersion(id);
    const endpoints = await generateApiContract(systemParse.data);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: contractRows } = await client.query(
        `INSERT INTO api_contracts (map_id, version, endpoints)
         VALUES ($1, $2, $3)
         ON CONFLICT (map_id, version) DO UPDATE SET endpoints = $3, updated_at = now()
         RETURNING map_id, version, endpoints, created_at, updated_at`,
        [id, version, JSON.stringify(endpoints)]
      );

      // Shares the daily budget with /generate and the other reviews —
      // same table, same counting logic in rateLimit.ts.
      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json(toContract(contractRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof ApiContractValidationError) {
      console.error('API contract validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'api_contract_failed',
        message: "Mappr couldn't produce a valid API contract for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;