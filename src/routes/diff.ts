import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { computeSystemDiff } from '../services/diff.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';

const router = Router();

const diffQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

// GET /maps/:id/diff?from=1&to=3 — deterministic diff between two stored
// versions. No AI call here at all: both snapshots already exist in
// map_versions (written by /maps/:id/iterate), so this is pure
// comparison, same as the rest of the deterministic-where-possible code
// in this codebase (layout, markdown export, etc.).
router.get('/maps/:id/diff', async (req, res) => {
  const { id } = req.params;

  const parsedQuery = diffQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsedQuery.error.flatten() });
  }
  const { from, to } = parsedQuery.data;

  if (from === to) {
    return res.status(400).json({ error: 'invalid_request', message: '"from" and "to" must differ' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT version, data FROM map_versions WHERE map_id = $1 AND version IN ($2, $3)`,
      [id, from, to]
    );

    const fromRow = rows.find((r) => r.version === from);
    const toRow = rows.find((r) => r.version === to);

    if (!fromRow || !toRow) {
      return res.status(404).json({
        error: 'not_found',
        message: `One or both versions don't exist for this map (found ${rows.length}/2).`,
      });
    }

    const fromParse = MapprSystemSchema.safeParse(fromRow.data);
    const toParse = MapprSystemSchema.safeParse(toRow.data);
    if (!fromParse.success || !toParse.success) {
      console.error('Stored version failed MapprSystem validation');
      return res.status(500).json({ error: 'internal_error' });
    }

    const diff = computeSystemDiff(fromParse.data, toParse.data);

    return res.json({ mapId: id, from, to, diff });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;