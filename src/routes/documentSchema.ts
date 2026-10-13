import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateDocumentSchema, DocumentSchemaValidationError } from '../services/documentSchema.js';
import { renderDocumentSchema } from '../services/documentRender.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';
import type { DocumentCollection, DocumentSchemaRecord } from '../schema/documentSchema.js';

const router = Router();

function toRecord(row: {
  map_id: string;
  version: number;
  collections: unknown;
  created_at: Date;
  updated_at: Date;
}): DocumentSchemaRecord {
  return {
    mapId: row.map_id,
    version: row.version,
    collections: row.collections as DocumentCollection[],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Same convention as apiContract.ts / relationalSchema.ts's
// currentVersion — a map that's never been iterated has no
// map_versions rows yet, and its data is implicitly version 1 (see the
// versioning note in iterate.ts).
async function currentVersion(mapId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(version), 1) AS version FROM map_versions WHERE map_id = $1`,
    [mapId]
  );
  return Number(rows[0].version);
}

async function fetchCurrentCollections(mapId: string): Promise<DocumentCollection[] | null> {
  const version = await currentVersion(mapId);
  const { rows } = await pool.query(
    `SELECT collections FROM document_schemas WHERE map_id = $1 AND version = $2`,
    [mapId, version]
  );
  return rows[0] ? (rows[0].collections as DocumentCollection[]) : null;
}

// GET /maps/:id/document-schema — the stored, structured collection
// spec for the map's current version, if one exists. Same
// "current version only" behavior as the other two schema features.
router.get('/maps/:id/document-schema', async (req, res) => {
  const { id } = req.params;

  try {
    const version = await currentVersion(id);
    const { rows } = await pool.query(
      `SELECT map_id, version, collections, created_at, updated_at FROM document_schemas WHERE map_id = $1 AND version = $2`,
      [id, version]
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

// GET /maps/:id/document-schema/script — renders the stored
// current-version collections to a runnable mongosh script. No dialect
// param, unlike the relational /sql route — there's only one target
// here. Nothing AI-generated in this step; renderDocumentSchema is pure
// code.
router.get('/maps/:id/document-schema/script', async (req, res) => {
  const { id } = req.params;

  try {
    const collections = await fetchCurrentCollections(id);
    if (!collections) {
      return res.status(404).json({ error: 'not_found' });
    }

    const script = renderDocumentSchema(collections);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(script);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/document-schema — generate a collection spec for the
// map's current version, overwriting any existing one for that same
// version. Same convention as the other two schema features.
router.post('/maps/:id/document-schema', async (req, res) => {
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
    const collections = await generateDocumentSchema(systemParse.data);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: schemaRows } = await client.query(
        `INSERT INTO document_schemas (map_id, version, collections)
         VALUES ($1, $2, $3)
         ON CONFLICT (map_id, version) DO UPDATE SET collections = $3, updated_at = now()
         RETURNING map_id, version, collections, created_at, updated_at`,
        [id, version, JSON.stringify(collections)]
      );

      // Shares the daily budget with the other AI-backed features —
      // same table, same counting logic in rateLimit.ts.
      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json(toRecord(schemaRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof DocumentSchemaValidationError) {
      console.error('Document schema validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'document_schema_failed',
        message: "Mappr couldn't produce a valid document schema for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;