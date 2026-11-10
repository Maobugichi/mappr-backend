import { Router } from 'express';
import { pool } from '../db/pool.js';
import { isUuid } from '../middleware/anonSession.js';
import { revisionWritesEnabled, readRevisionedMap, CanonicalMapNotFoundError,
  RevisionNotReadyError } from '../services/canonicalRevision.js';

const router = Router();

// Explicit personalized read; ordinary map/share-link GETs remain public.
router.get('/maps/:id/edit-eligibility', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.vary('Cookie');

  if (!req.hasEstablishedAnonSession) {
    return res.status(401).json({ error: 'session_required' });
  }

  const { id } = req.params;
  if (!isUuid(id)) {
    return res.status(404).json({ error: 'not_found' });
  }

  try {
    const { rows } = await pool.query('SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2', [id, req.anonId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ mapId: id, canEdit: true });
  } catch {
    console.error('Map edit eligibility verification failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});


router.get('/maps/:id', async (req, res) => {
  const { id } = req.params;
  const useRevisions = revisionWritesEnabled();

  try {
    if (useRevisions) {
      if (!isUuid(id)) return res.status(404).json({ error: 'not_found' });
      const map = await readRevisionedMap(id);
      return res.json({ id: map.id, inputDescription: map.input_description, data: map.data,
        createdAt: map.created_at, updatedAt: map.updated_at, revision: map.current_revision });
    }
    const { rows } = await pool.query(
      `SELECT id, input_description, data, created_at, updated_at FROM maps WHERE id = $1`,
      [id]
    );

    const map = rows[0];
    if (!map) {
      return res.status(404).json({ error: 'not_found' });
    }

    return res.json({
      id: map.id,
      inputDescription: map.input_description,
      data: map.data,
      createdAt: map.created_at,
      updatedAt: map.updated_at,
    });
  } catch (err) {
    if (useRevisions) {
      if (err instanceof CanonicalMapNotFoundError) return res.status(404).json({ error: 'not_found' });
      if (err instanceof RevisionNotReadyError) return res.status(503).json({ error: 'revision_not_ready', message: err.message });
      console.error('Revision-aware map read failed');
      return res.status(500).json({ error: 'internal_error' });
    }

    console.error(err);
    return res.status(404).json({ error: 'not_found' });
  }
});

export default router;
