import type { RequestHandler } from 'express';

function validConfiguredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

// Originless requests without browser metadata retain CLI compatibility. This
// allowance is not a claim of mandatory-Origin/token-based CSRF protection.
export function mutationOrigin(frontendOrigin: string | undefined): RequestHandler {
  const allowedOrigin = validConfiguredOrigin(frontendOrigin);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    const browserMetadata = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'referer']
      .some(header => req.get(header) !== undefined);
    const permitted = origin !== undefined
      ? allowedOrigin !== null && origin === allowedOrigin
      : !browserMetadata;

    if (!permitted) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    next();
  };
}
