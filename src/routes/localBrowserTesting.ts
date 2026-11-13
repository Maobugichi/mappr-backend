import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { revisionTransaction } from '../db/revisionTransaction.js';
import { readRevisionedMap } from '../services/canonicalRevision.js';
import { isUuid } from '../middleware/anonSession.js';
import { MapprSystemSchema } from '../schema/mapprSystem.js';
import { assertLocalBrowserRequest } from '../services/localBrowserTesting.js';
import { ChangeError } from '../services/changes/errors.js';

const router = Router();
const marker = 'Disposable local browser test: synthetic fixture, no AI generation';
const fixture = MapprSystemSchema.parse({
  meta: { productName: 'Disposable Mappr Test', oneLineSummary: 'A task tracker for local AI editing tests.' },
  product: { summary: 'A small task tracker where people create tasks and track their progress.', concepts: ['tasks', 'progress'] },
  users: [{ id: 'member', name: 'Member', description: 'Creates and completes tasks.' }],
  features: [{ id: 'tasks', name: 'Manage tasks', description: 'Create and complete tasks.', relatedUsers: ['member'], dependsOn: [] }],
  techStack: [{ category: 'Frontend', choice: 'React', rationale: 'Interactive task interface.' },
    { category: 'Backend', choice: 'Node.js', rationale: 'Task API.' }, { category: 'Database', choice: 'PostgreSQL', rationale: 'Task persistence.' }],
  architecture: { nodes: [{ id: 'web', label: 'Web app', type: 'frontend', description: 'Displays tasks.' },
    { id: 'api', label: 'Task API', type: 'backend', description: 'Reads and writes tasks.' },
    { id: 'db', label: 'PostgreSQL', type: 'database', description: 'Stores tasks.' }],
    edges: [{ from: 'web', to: 'api', label: 'HTTP' }, { from: 'api', to: 'db', label: 'SQL' }] },
  dataModel: { entities: [{ id: 'task', name: 'Task', fields: [{ name: 'id', type: 'uuid' }, { name: 'title', type: 'string' }, { name: 'completed', type: 'boolean' }] }], relations: [] },
  designSystem: { colors: [], typography: [], spacing: [], components: [] },
  developmentPlan: [{ phase: 1, title: 'Task management', items: [{ description: 'Build the task interface and API.', relatedFeatures: ['tasks'] }] }],
});

// Explicit browser action only. Never runs during startup/health/readiness checks.
// A synthetic fixture is not an AI generation; real previews retain full quotas.
router.post('/dev/local-test-map', async (req, res) => {
  res.set('Cache-Control', 'no-store'); res.vary('Cookie');
  try {
    assertLocalBrowserRequest(req);
    if (!req.hasEstablishedAnonSession) throw new ChangeError('session_required');
    const id = req.get('Idempotency-Key');
    if (!isUuid(id) || !z.strictObject({ create: z.literal(true) }).safeParse(req.body).success) throw new ChangeError('invalid_request');
    const result = await revisionTransaction(pool, async client => {
      const inserted = await client.query(`INSERT INTO public.maps (id,anon_id,input_description,data,current_revision)
        VALUES ($1,$2,$3,$4,1) ON CONFLICT (id) DO NOTHING RETURNING id`, [id.toLowerCase(), req.anonId, marker, JSON.stringify(fixture)]);
      if (inserted.rowCount === 1) {
        const snapshot = await client.query(`INSERT INTO public.map_versions (map_id,version,data,patch,summary)
          SELECT id,1,data,NULL,'Synthetic local browser fixture (no AI)' FROM public.maps WHERE id=$1`, [id.toLowerCase()]);
        if (snapshot.rowCount !== 1) throw new ChangeError('temporarily_unavailable');
      }
      const map = await readRevisionedMap(id.toLowerCase(), client);
      if (map.anon_id !== req.anonId || map.input_description !== marker) throw new ChangeError('not_found');
      return { created: inserted.rowCount === 1, response: { mapId: map.id, revision: map.current_revision, data: map.data, disposable: true } };
    });
    if (!result.created) res.set('Idempotency-Replayed', 'true');
    return res.status(result.created ? 201 : 200).json(result.response);
  } catch (error) {
    const safe = error instanceof ChangeError ? error : new ChangeError('temporarily_unavailable');
    return res.status(safe.status).json(safe.body());
  }
});
export default router;
