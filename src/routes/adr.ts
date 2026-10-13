import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateAdrs, AdrValidationError, techArchHash } from '../services/adr.js';
import { renderAdrs } from '../services/adrRender.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';
import type { Adr, AdrSetRecord } from '../schema/adr.js';

const router = Router();

function toRecord(row: {
  map_id: string;
  tech_arch_hash: string;
  adrs: unknown;
  created_at: Date;
  updated_at: Date;
}): AdrSetRecord {
  return {
    mapId: row.map_id,
    techArchHash: row.tech_arch_hash,
    adrs: row.adrs as Adr[],
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

// GET /maps/:id/adrs — the stored ADR set for the map's current
// techStack+architecture hash, if one exists. Unlike the three
// version-tied features, this is NOT about the map's current *version*
// — an iteration that only touched dataModel or features leaves the
// hash (and therefore the stored ADRs) unchanged.
router.get('/maps/:id/adrs', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(
      `SELECT map_id, tech_arch_hash, adrs, created_at, updated_at FROM adrs WHERE map_id = $1 AND tech_arch_hash = $2`,
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

// GET /maps/:id/adrs/markdown — renders the stored current-hash ADRs
// to Markdown. No format param — ADRs only ever render one way.
router.get('/maps/:id/adrs/markdown', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(`SELECT adrs FROM adrs WHERE map_id = $1 AND tech_arch_hash = $2`, [
      id,
      hash,
    ]);

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    const markdown = renderAdrs(row.adrs as Adr[], system.meta.productName);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(markdown);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/adrs — generate ADRs for the map's current
// techStack+architecture hash, overwriting any existing set for that
// same hash. A set generated for a hash that's since changed is left
// in place, same as an old version's api_contract/relational_schema row.
router.post('/maps/:id/adrs', async (req, res) => {
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
    const adrs = await generateAdrs(system);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: adrRows } = await client.query(
        `INSERT INTO adrs (map_id, tech_arch_hash, adrs)
         VALUES ($1, $2, $3)
         ON CONFLICT (map_id, tech_arch_hash) DO UPDATE SET adrs = $3, updated_at = now()
         RETURNING map_id, tech_arch_hash, adrs, created_at, updated_at`,
        [id, hash, JSON.stringify(adrs)]
      );

      // Shares the daily budget with the other AI-backed features —
      // same table, same counting logic in rateLimit.ts.
      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json(toRecord(adrRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof AdrValidationError) {
      console.error('ADR validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'adr_failed',
        message: "Mappr couldn't produce valid ADRs for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;