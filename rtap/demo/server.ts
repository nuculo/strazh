import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  processChatCompletion,
  type DemoAppMode,
  type ChatCompletionRequest,
  SYNTHETIC_CANARY_TOKEN,
  DEFAULT_NEBIUS_MODEL,
  DEFAULT_NEBIUS_BASE_URL,
  MAX_OUTPUT_TOKENS_BOUND,
  NEBIUS_REQUEST_TIMEOUT_MS,
} from './app.js';

function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const PORT = parseInt(process.env.DEMO_PORT || getArg('port', '4000'), 10);
const HOST = process.env.DEMO_HOST || '127.0.0.1';
const DEFAULT_MODE = (process.env.DEMO_MODE || getArg('mode', 'baseline')) as DemoAppMode;
const MODEL = process.env.DEMO_MODEL || getArg('model', DEFAULT_NEBIUS_MODEL);

const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY;
const NEBIUS_BASE_URL = process.env.NEBIUS_BASE_URL || DEFAULT_NEBIUS_BASE_URL;

const IS_OFFLINE = process.argv.includes('--offline') || process.env.DEMO_OFFLINE === '1' || process.env.DEMO_OFFLINE === 'true';

export function createDemoServer(defaultMode: DemoAppMode = DEFAULT_MODE, isOffline: boolean = IS_OFFLINE) {
  return http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const activeKey = Boolean(process.env.NEBIUS_API_KEY || NEBIUS_API_KEY);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          app: 'Strazh Support Bot (Controlled Demo)',
          defaultMode,
          model: process.env.DEMO_MODEL || MODEL,
          executionMode: isOffline ? 'offline-simulation' : 'live-nebius',
          liveNebiusCapable: activeKey,
          canaryMarker: SYNTHETIC_CANARY_TOKEN,
          supportedRoutes: [
            '/simulated/baseline/v1/chat/completions',
            '/simulated/mitigated/v1/chat/completions',
            '/live/baseline/v1/chat/completions',
            '/live/mitigated/v1/chat/completions',
            '/baseline/v1/chat/completions',
            '/mitigated/v1/chat/completions',
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST') {
      let mode: DemoAppMode = defaultMode;
      let requestIsOffline = isOffline;

      if (url.pathname.includes('/simulated/')) {
        requestIsOffline = true;
      } else if (url.pathname.includes('/live/')) {
        requestIsOffline = false;
      }

      if (url.pathname.includes('/mitigated')) {
        mode = 'mitigated';
      } else if (url.pathname.includes('/baseline')) {
        mode = 'baseline';
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', async () => {
        try {
          const reqBody = (body ? JSON.parse(body) : {}) as ChatCompletionRequest;
          const currentApiKey = process.env.NEBIUS_API_KEY || NEBIUS_API_KEY;
          const currentBaseUrl = process.env.NEBIUS_BASE_URL || NEBIUS_BASE_URL;

          const result = await processChatCompletion(reqBody, mode, {
            nebiusApiKey: currentApiKey,
            nebiusBaseUrl: currentBaseUrl,
            model: process.env.DEMO_MODEL || MODEL,
            offline: requestIsOffline,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: err instanceof Error ? err.message : String(err),
                type: 'server_error',
              },
            }),
          );
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

// When run directly as a script
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!IS_OFFLINE && !NEBIUS_API_KEY) {
    console.error(`\n[strazh-demo] ERROR: NEBIUS_API_KEY environment variable is required for live Nebius inference.`);
    console.error(`To run with live Nebius Token Factory:`);
    console.error(`  $env:NEBIUS_API_KEY="<your-key>"; npm run demo`);
    console.error(`To explicitly run with deterministic offline simulation (for tests/development):`);
    console.error(`  npm run demo:offline  (or: npx tsx demo/server.ts --offline)`);
    console.error(`Refusing silent simulation fallback.\n`);
    process.exit(1);
  }

  const server = createDemoServer(DEFAULT_MODE, IS_OFFLINE);
  server.listen(PORT, HOST, () => {
    if (IS_OFFLINE) {
      console.log(`\n======================================================================`);
      console.log(`[strazh-demo] *** RUNNING IN EXPLICIT OFFLINE SIMULATION MODE ***`);
      console.log(`[strazh-demo] Model completions are locally simulated for offline tests.`);
      console.log(`[strazh-demo] This is NOT live Nebius Token Factory inference.`);
      console.log(`======================================================================\n`);
    } else {
      console.log(`\n======================================================================`);
      console.log(`[strazh-demo] *** LIVE NEBIUS INFERENCE ENABLED ***`);
      console.log(`[strazh-demo] Model: ${MODEL}`);
      console.log(`[strazh-demo] Endpoint: ${NEBIUS_BASE_URL}`);
      console.log(`[strazh-demo] Bounds: Max ${MAX_OUTPUT_TOKENS_BOUND} output tokens | ${NEBIUS_REQUEST_TIMEOUT_MS / 1000}s timeout | max 1 retry`);
      console.log(`======================================================================\n`);
    }
    console.log(`[strazh-demo] Server running at http://${HOST}:${PORT}/`);
    console.log(`[strazh-demo] Default mode: ${DEFAULT_MODE}`);
    console.log(`[strazh-demo] Execution Mode: ${IS_OFFLINE ? 'OFFLINE SIMULATION' : 'LIVE NEBIUS'}`);
    console.log(`[strazh-demo] Canary token: ${SYNTHETIC_CANARY_TOKEN}`);
    console.log(`[strazh-demo] Endpoints:`);
    console.log(`  - POST /v1/chat/completions (uses ${DEFAULT_MODE} mode)`);
    console.log(`  - POST /baseline/v1/chat/completions (intentionally vulnerable baseline)`);
    console.log(`  - POST /mitigated/v1/chat/completions (application-level canary scrubber)`);
  });
}
