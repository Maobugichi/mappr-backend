import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { generateMapprSystem, GenerationValidationError } from '../services/gemini.js';
import { checkRateLimits } from '../services/rateLimit.js';

const router = Router();

const requestBodySchema = z.object({
  description: z.string().min(20, 'Description is too short').max(4000),
});

router.post('/generate', async (req, res) => {
  const parsed = requestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }

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
    const system = await generateMapprSystem(parsed.data.description);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const mapResult = await client.query(
        `INSERT INTO maps (anon_id, input_description, data)
         VALUES ($1, $2, $3)
         RETURNING id, created_at, updated_at`,
        [anonId, parsed.data.description, system]
      );
      const map = mapResult.rows[0];

      await client.query(`INSERT INTO generations (anon_id, map_id) VALUES ($1, $2)`, [
        anonId,
        map.id,
      ]);

      await client.query('COMMIT');

      return res.status(201).json({
        id: map.id,
        createdAt: map.created_at,
        updatedAt: map.updated_at,
        data: system,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof GenerationValidationError) {
      console.error('Generation validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'generation_failed',
        message:
          "Mappr couldn't produce a valid system map for that description. Try rephrasing it with more detail.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;