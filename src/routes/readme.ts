import { dailyAdmissionEnabled, reserveDailyAttempt, recordSuccessfulGeneration, cleanupDailyAttempt, dailyRouteError, type DailyAttempt } from '../services/dailyAdmission.js';
import { captureArtifactSource, publishArtifact } from '../services/artifacts/provenance.js';
import { artifactRouteError } from '../middleware/artifactReads.js';
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { generateReadme, ReadmeValidationError } from '../services/readme.js';
import { techArchHash } from '../services/adr.js';
import { renderReadme, type ReadmeArtifactFlags } from '../services/readmeRender.js';
import { checkRateLimits } from '../services/rateLimit.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';
import type { GettingStartedStep, ReadmeRecord } from '../schema/readme.js';

const router = Router();

function toRecord(row: {
  map_id: string;
  version: number;
  overview: string;
  getting_started: unknown;
  created_at: Date;
  updated_at: Date;
}): ReadmeRecord {
  return {
    mapId: row.map_id,
    version: row.version,
    overview: row.overview,
    gettingStarted: row.getting_started as GettingStartedStep[],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Same convention as the other version-tied features' currentVersion.
async function currentVersion(mapId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(version), 1) AS version FROM map_versions WHERE map_id = $1`,
    [mapId]
  );
  return Number(rows[0].version);
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

// Four existence checks, one per optional artifact, so the renderer can
// decide what to cross-reference without guessing. api_contracts and
// relational_schemas/document_schemas are version-tied like readmes
// itself; adrs is keyed on its own techStack+architecture hash, computed
// fresh here the same way adr.ts's own route does.
async function loadArtifactFlags(mapId: string, version: number, system: MapprSystem): Promise<ReadmeArtifactFlags> {
  const hash = techArchHash(system);

  const [apiContract, relationalSchema, documentSchema, adrs] = await Promise.all([
    pool.query(`SELECT 1 FROM api_contracts WHERE map_id = $1 AND version = $2`, [mapId, version]),
    pool.query(`SELECT 1 FROM relational_schemas WHERE map_id = $1 AND version = $2`, [mapId, version]),
    pool.query(`SELECT 1 FROM document_schemas WHERE map_id = $1 AND version = $2`, [mapId, version]),
    pool.query(`SELECT 1 FROM adrs WHERE map_id = $1 AND tech_arch_hash = $2`, [mapId, hash]),
  ]);

  return {
    hasApiContract: apiContract.rows.length > 0,
    hasRelationalSchema: relationalSchema.rows.length > 0,
    hasDocumentSchema: documentSchema.rows.length > 0,
    hasAdrs: adrs.rows.length > 0,
  };
}

// GET /maps/:id/readme — the stored, structured README fields (overview
// + gettingStarted only) for the map's current version, if any.
router.get('/maps/:id/readme', async (req, res) => {
  const { id } = req.params;

  try {
    const version = await currentVersion(id);
    const { rows } = await pool.query(
      `SELECT map_id, version, overview, getting_started, created_at, updated_at FROM readmes WHERE map_id = $1 AND version = $2`,
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

// GET /maps/:id/readme/markdown — the full assembled README: the
// AI-generated overview/gettingStarted plus every other section
// rendered fresh from the current map and the four artifact checks.
router.get('/maps/:id/readme/markdown', async (req, res) => {
  const { id } = req.params;

  try {
    const system = await loadSystem(id);
    if (!system) {
      return res.status(404).json({ error: 'not_found' });
    }

    const version = await currentVersion(id);
    const { rows } = await pool.query(
      `SELECT overview, getting_started FROM readmes WHERE map_id = $1 AND version = $2`,
      [id, version]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }

    const flags = await loadArtifactFlags(id, version, system);
    const markdown = renderReadme(
      system,
      { overview: row.overview, gettingStarted: row.getting_started as GettingStartedStep[] },
      flags
    );

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(markdown);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /maps/:id/readme — generate overview/gettingStarted for the
// map's current version, overwriting any existing ones for that same
// version. Same convention as the other version-tied features.
router.post('/maps/:id/readme', async (req, res) => {
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
    const source = await captureArtifactSource(String(id).toLowerCase(), anonId, 'readme');
    attempt = await reserveDailyAttempt({ actorId: anonId, mapId: source.mapId, operation: source.kind, id: source.generationId });
    const version = source.revision;
    const generated = await generateReadme(source.system);

    const saved = await publishArtifact(source, anonId, async client => {

      const { rows: readmeRows } = await client.query(
        `INSERT INTO readmes (map_id, version, overview, getting_started)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (map_id, version) DO UPDATE SET overview = $3, getting_started = $4, updated_at = now()
         RETURNING map_id, version, overview, getting_started, created_at, updated_at`,
        [id, version, generated.overview, JSON.stringify(generated.gettingStarted)]
      );

      // Shares the daily budget with the other AI-backed features —
      // same table, same counting logic in rateLimit.ts.
      await recordSuccessfulGeneration(client, anonId, String(id).toLowerCase(), attempt);

      return readmeRows[0];
    });
    return res.status(201).json(toRecord(saved));
  } catch (err) {
    await cleanupDailyAttempt(attempt);
    if (dailyRouteError(res, err)) return;
    if (artifactRouteError(res, err)) return;
    if (err instanceof ReadmeValidationError) {
      console.error('README validation failed twice:', err.zodError.flatten());
      return res.status(502).json({
        error: 'readme_failed',
        message: "Mappr couldn't produce a valid README for this system. Try again.",
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;