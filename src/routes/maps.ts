import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();


router.get('/maps/:id', async (req, res) => {
  const { id } = req.params;

  try {
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

    console.error(err);
    return res.status(404).json({ error: 'not_found' });
  }
});

export default router;