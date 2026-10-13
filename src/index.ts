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
import iterateRouter from './routes/iterate.js';
import diffRouter from './routes/diff.js';
import traceabilityRouter from './routes/traceability.js';
import apiContractRouter from './routes/apiContract.js';
import relationalSchemaRouter from './routes/relationalSchema.js'
import documentSchemaRouter from './routes/documentSchema.js';
import adrRouter from './routes/adr.js';
import readmeRouter from './routes/readme.js';
import envVarsRouter from './routes/envVars.js';
import deploymentRouter from './routes/deployment.js';

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(anonSession);

app.use(generateRouter);
app.use(mapsRouter);
app.use(critiqueRouter);
app.use(requirementsRouter);
app.use(iterateRouter);
app.use(diffRouter);
app.use(traceabilityRouter);
app.use(apiContractRouter);
app.use(relationalSchemaRouter);
app.use(documentSchemaRouter);
app.use(adrRouter);
app.use(readmeRouter);
app.use(envVarsRouter);
app.use(deploymentRouter);

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