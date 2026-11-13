import { dailyAdmissionEnabled, reserveDailyAttempt, recordSuccessfulGeneration, cleanupDailyAttempt, dailyRouteError, type DailyAttempt } from '../services/dailyAdmission.js';
import { captureArtifactSource, publishArtifact } from '../services/artifacts/provenance.js';
import { artifactRouteError } from '../middleware/artifactReads.js';
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateDeployment, DeploymentValidationError } from '../services/deployment.js';
import { renderDeployment } from '../services/deploymentRender.js';
import { techArchHash } from '../services/adr.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';
import type {
  DeploymentComponent,
  DeploymentEnvironment,
  DeploymentRecord,
} from '../schema/deployment.js';
import type { EnvVar } from '../schema/envVars.js';

const router = Router();

function toRecord(row: {
  map_id: string;
  tech_arch_hash: string;
  components: unknown;
  environments: unknown;
  cicd_steps: unknown;
  migrations: string | null;
  created_at: Date;
  updated_at: Date;
}): DeploymentRecord {
  return {
    mapId: row.map_id,
    techArchHash: row.tech_arch_hash,
    components: row.components as DeploymentComponent[],
    environments: row.environments as DeploymentEnvironment[],
    cicdSteps: row.cicd_steps as string[],
    migrations: row.migrations,
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

// GET /maps/:id/deployment — the stored plan for the map's current
// techStackarchitecture hash, if one exists. Same hash-not-version
// behavior as GET /maps/:id/adrs and /env-vars: an iteration that only
// touched dataModel or features leaves the hash, and therefore the
// stored plan, unchanged.
router.get('/maps/:id/deployment', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(
      `SELECT map_id, tech_arch_hash, components, environments, cicd_steps, migrations, created_at, updated_at
       FROM deployments WHERE map_id = $1 AND tech_arch_hash = $2`,
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

// GET /maps/:id/deployment/markdown — renders the stored current-hash
// plan to Markdown. Nothing AI-generated in this step; renderDeployment
// is pure code, and it needs the live system for node labels, the
// connections list, and to spot nodes the plan doesn't cover.
router.get('/maps/:id/deployment/markdown', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const hash = techArchHash(system);
    const { rows } = await pool.query(
      `SELECT map_id, tech_arch_hash, components, environments, cicd_steps, migrations, created_at, updated_at
       FROM deployments WHERE map_id = $1 AND tech_arch_hash = $2`,
      [id, hash]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    const { rows: envRows } = await pool.query(
      `SELECT vars FROM env_vars WHERE map_id = $1 AND tech_arch_hash = $2`,
      [id, hash]
    );
    const envVars = envRows[0] ? (envRows[0].vars as EnvVar[]) : null;

    const record = toRecord(row);
    const markdown = renderDeployment(
      {
        components: record.components,
        environments: record.environments,
        cicdSteps: record.cicdSteps,
        migrations: record.migrations,
      },
      system,
      envVars
    );
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(markdown);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/deployment — generate the plan for the map's current
// techStackarchitecture hash, overwriting any existing plan for that
// same hash. A plan generated for a hash that's since changed is left
// in place, same as ADRs and env vars.
router.post('/maps/:id/deployment', async (req, res) => {
  const { id } = req.params;
  const anonId = req.anonId;

  const rateLimitCheck = dailyAdmissionEnabled() ? { allowed: true as const } : await checkRateLimits(anonId);
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

  let attempt: DailyAttempt | undefined;
  try {
    const source = await captureArtifactSource(String(id).toLowerCase(), anonId, 'deployment');
    attempt = await reserveDailyAttempt({ actorId: anonId, mapId: source.mapId, operation: source.kind, id: source.generationId });
    const hash = source.key;
    const plan = await generateDeployment(source.system);

    const saved = await publishArtifact(source, anonId, async client => {

      const { rows: planRows } = await client.query(
        `INSERT INTO deployments (map_id, tech_arch_hash, components, environments, cicd_steps, migrations)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (map_id, tech_arch_hash) DO UPDATE
           SET components = $3, environments = $4, cicd_steps = $5, migrations = $6, updated_at = now()
        RETURNING map_id, tech_arch_hash, components, environments, cicd_steps, migrations, created_at, updated_at`,
        [
          id,
          hash,
          JSON.stringify(plan.components),
          JSON.stringify(plan.environments),
          JSON.stringify(plan.cicdSteps),
          plan.migrations
        ]
      );

      // Shares the daily budget with the other AI-backed features —
      // same table, same counting logic in rateLimit.ts.
      await recordSuccessfulGeneration(client, anonId, String(id).toLowerCase(), attempt);

      return planRows[0];
    });
    return res.status(201).json(toRecord(saved));
  } catch (err) {
    await cleanupDailyAttempt(attempt);
    if (dailyRouteError(res, err)) return;
    if (artifactRouteError(res, err)) return;
    if (err instanceof DeploymentValidationError) {
      console.error('Deployment validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'deployment_failed',
        message: "Mappr couldn't produce a valid deployment plan for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;