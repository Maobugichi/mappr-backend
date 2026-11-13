import type { Request } from 'express';
import { ChangeError } from './changes/errors.js';

const hosted = () => ['RENDER', 'RENDER_SERVICE_ID', 'VERCEL', 'K_SERVICE'].some(key => Boolean(process.env[key]));
export const localBrowserTestingRequested = () => process.env.MAPPR_LOCAL_CHANGES_TESTING === 'true';
export const localBrowserTestingEnabled = () => localBrowserTestingRequested() && process.env.NODE_ENV === 'development' && !hosted();

export function assertLocalBrowserEnvironment() {
  if (!localBrowserTestingEnabled() || Number(process.env.PORT ?? 4000) !== 4000) throw new Error('Local browser testing requires development on port 4000 without hosted runtime markers.');
  let origin: URL;
  try { origin = new URL(process.env.FRONTEND_ORIGIN ?? ''); } catch { throw new Error('Local browser testing requires an explicit loopback frontend Origin.'); }
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname) || origin.origin !== process.env.FRONTEND_ORIGIN) {
    throw new Error('Local browser testing requires an exact HTTP localhost or 127.0.0.1 frontend Origin.');
  }
  if (['MAPPR_CHANGES_ENABLED', 'MAPPR_REVISION_WRITES_ENABLED', 'MAPPR_DAILY_ADMISSION_ENABLED'].some(key => process.env[key] !== 'true')
    || (process.env.CHANGE_PROPOSAL_TTL_SECONDS ?? '900') !== '900') {
    throw new Error('Local browser testing requires real revision/daily admission and the existing 900-second proposal policy.');
  }
  return { host: '127.0.0.1', port: 4000, frontendOrigin: origin.origin, browserHost: origin.hostname } as const;
}
export function assertLocalBrowserRequest(req?: Request): void {
  let config: ReturnType<typeof assertLocalBrowserEnvironment>;
  try { config = assertLocalBrowserEnvironment(); } catch { throw new ChangeError('preview_policy_not_configured'); }
  const loopback = (address: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
  if (!req || !loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress) || req.socket.localPort !== 4000
    || req.get('host') !== `${config.browserHost}:4000`
    || ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(name => req.get(name) !== undefined)) {
    throw new ChangeError('preview_policy_not_configured', { required: ['direct_loopback_request'] });
  }
  // This local visual-test slice enables only the three requested views.
  if (req.path.endsWith('/changes/preview') && !['overview', 'architecture', 'tech-stack'].includes(req.body?.context?.activeView)) {
    throw new ChangeError('unsupported_scope');
  }
}
