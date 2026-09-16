import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pool } from './db/pool.js';
import { anonSession } from './middleware/anonSession.js';
import generateRouter from './routes/generate.js';
import mapsRouter from './routes/maps.js';
import critiqueRouter from './routes/critique.js';
import requirementsRouter from './routes/requirements.js';

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(anonSession);

app.use(generateRouter);
app.use(mapsRouter);
app.use(critiqueRouter);
app.use(requirementsRouter);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'db_unreachable' });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Mappr backend listening on :${port}`);
});