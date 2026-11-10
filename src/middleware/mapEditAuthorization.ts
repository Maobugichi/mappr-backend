import type { RequestHandler } from 'express';
import { isUuid } from './anonSession.js';

export type MapOwnerLookup = (mapId: string, anonId: string) => Promise<boolean>;

// Mount once at /maps/:id before every map router. Shared reads stay public.
export function mapEditAuthorization(isOwner: MapOwnerLookup): RequestHandler {
  return async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }

    if (!req.hasEstablishedAnonSession) {
      res.status(401).json({ error: 'session_required' });
      return;
    }

    const mapId = req.params.id;
    if (!isUuid(mapId)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      if (!await isOwner(mapId, req.anonId)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
    } catch {
      // Do not log owner identifiers, cookies, or a driver's raw query/error.
      console.error('Map ownership verification failed');
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    next();
  };
}
