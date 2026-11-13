import 'dotenv/config';

// Explicit local command plus exact opt-in. Never overwrite a production env.
if (process.env.MAPPR_LOCAL_CHANGES_TESTING !== 'true' || process.env.NODE_ENV !== 'development') {
  throw new Error('Set MAPPR_LOCAL_CHANGES_TESTING=true and NODE_ENV=development for local browser testing.');
}
process.env.MAPPR_CHANGES_ENABLED = 'true';
process.env.MAPPR_REVISION_WRITES_ENABLED = 'true';
process.env.MAPPR_DAILY_ADMISSION_ENABLED = 'true';
const { assertLocalBrowserEnvironment } = await import('../src/services/localBrowserTesting.ts');
assertLocalBrowserEnvironment();
await import('../src/index.ts');
