import 'dotenv/config';
import { createApp } from './app.js';
import { assertLocalBrowserEnvironment, localBrowserTestingRequested } from './services/localBrowserTesting.js';

const app = createApp();

const port = Number(process.env.PORT ?? 4000);
const host = localBrowserTestingRequested() ? assertLocalBrowserEnvironment().host : undefined;
const listening = () => {
  console.log(`Mappr backend listening on :${port}`);
};
if (host) app.listen(port, host, listening); else app.listen(port, listening);
