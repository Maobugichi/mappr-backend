import { randomUUID } from 'node:crypto';
import { Router, type ErrorRequestHandler, type RequestHandler, type Request } from 'express';
import { pool } from '../db/pool.js';
import { isUuid } from '../middleware/anonSession.js';
import { ChangeEngine, createChangeEngine } from '../services/changes/engine.js';
import { assertChangesAvailable } from '../services/changes/availability.js';
import { ChangeError, knownChangeCode, safeChangeError } from '../services/changes/errors.js';

// Scoped before JSON parsing/auth so new-route denials and parser failures have
// the documented envelope, without changing legacy response shapes.
export const changeResponseMetadata: RequestHandler = (_req, res, next) => {
  res.locals.changeRequestId = randomUUID();
  res.set('Cache-Control', 'no-store');
  res.vary('Cookie');
  const send = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 400 && !body?.requestId && knownChangeCode(body?.error)) {
      body = new ChangeError(body.error, body.details).body(res.locals.changeRequestId);
    }
    return send(body);
  };
  next();
};
export const changeErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!res.locals.changeRequestId || res.headersSent) { next(error); return; }
  const code = error?.type === 'entity.too.large' ? 'request_too_large'
    : error?.type === 'entity.parse.failed' ? 'invalid_request' : 'internal_error';
  const safe = new ChangeError(code);
  res.status(safe.status).json(safe.body(res.locals.changeRequestId));
};
export function createChangesRouter(options: { engine?: ChangeEngine; assertAvailable?: (req: Request) => void } = {}) {
  const router = Router();
  const engine = options.engine ?? createChangeEngine(pool);
  const available = options.assertAvailable ?? assertChangesAvailable;
  const respond = (res: Parameters<RequestHandler>[1], error: unknown) => {
    const safe = safeChangeError(error);
    if (safe.code === 'preview_in_progress') res.set('Retry-After', '2');
    return res.status(safe.status).json(safe.body(res.locals.changeRequestId));
  };
  router.post('/maps/:id/changes/preview', async (req, res) => {
    try {
      available(req);
      const key = req.get('Idempotency-Key');
      if (!isUuid(key)) throw new ChangeError('invalid_request');
      const result = await engine.preview(String(req.params.id).toLowerCase(), req.anonId.toLowerCase(), key.toLowerCase(), req.body);
      if (result.replayed) res.set('Idempotency-Replayed', 'true');
      return res.status(201).json(result.response);
    } catch (error) { return respond(res, error); }
  });
  router.post('/maps/:id/changes/:proposalId/apply', async (req, res) => {
    try {
      available(req);
      const proposalId = req.params.proposalId;
      if (!isUuid(proposalId)) throw new ChangeError('invalid_request');
      const result = await engine.apply(String(req.params.id).toLowerCase(), req.anonId.toLowerCase(), proposalId.toLowerCase(), req.body);
      if (result.replayed) res.set('Idempotency-Replayed', 'true');
      return res.json(result.response);
    } catch (error) { return respond(res, error); }
  });
  router.post('/maps/:id/changes/:proposalId/reject', async (req, res) => {
    try {
      available(req);
      const proposalId = req.params.proposalId;
      if (!isUuid(proposalId)) throw new ChangeError('invalid_request');
      const result = await engine.reject(String(req.params.id).toLowerCase(), req.anonId.toLowerCase(), proposalId.toLowerCase(), req.body);
      if (result.replayed) res.set('Idempotency-Replayed', 'true');
      return res.json(result.response);
    } catch (error) { return respond(res, error); }
  });
  return router;
}
export default createChangesRouter();
