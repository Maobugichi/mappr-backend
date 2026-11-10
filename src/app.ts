import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pool } from './db/pool.js';
import { anonSession } from './middleware/anonSession.js';
import { mapEditAuthorization } from './middleware/mapEditAuthorization.js';
import { mutationOrigin } from './middleware/mutationOrigin.js';
import generateRouter from './routes/generate.js';
import mapsRouter from './routes/maps.js';
import critiqueRouter from './routes/critique.js';
import requirementsRouter from './routes/requirements.js';
import iterateRouter from './routes/iterate.js';
import diffRouter from './routes/diff.js';
import traceabilityRouter from './routes/traceability.js';
import apiContractRouter from './routes/apiContract.js';
import relationalSchemaRouter from './routes/relationalSchema.js';
import documentSchemaRouter from './routes/documentSchema.js';
import adrRouter from './routes/adr.js';
import readmeRouter from './routes/readme.js';
import envVarsRouter from './routes/envVars.js';
import deploymentRouter from './routes/deployment.js';

// Separate construction from listening so tests can exercise the real routers
// with mocked database/provider modules and no application database connection.
export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(mutationOrigin(process.env.FRONTEND_ORIGIN));
  app.use(anonSession);
  app.use('/maps/:id', mapEditAuthorization(async (mapId, anonId) => {
    const { rows } = await pool.query('SELECT 1 FROM maps WHERE id = $1 AND anon_id = $2', [mapId, anonId]);
    return rows.length > 0;
  }));

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
    } catch {
      res.status(500).json({ ok: false, error: 'db_unreachable' });
    }
  });
  return app;
}
