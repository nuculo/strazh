import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssessmentService, ConcurrencyLimitError, TargetNotFoundError, MissingApiKeyError } from './assessment-service.js';
import { APPROVED_TARGETS } from './targets.js';
import type { OperatorUser } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRtapRoot = path.resolve(__dirname, '../..');

export interface RtapServerOptions {
  rtapRoot?: string;
  dataDir?: string;
  operatorToken?: string;
  port?: number;
  host?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sarif': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function validateOperatorToken(
  token: string | undefined,
  isProduction = process.env.NODE_ENV === 'production'
): string {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      '[rtap-server] Startup halted: OPERATOR_TOKEN environment variable is required. No default token is permitted.'
    );
  }
  const clean = token.trim();
  if (isProduction) {
    if (clean.length < 16) {
      throw new Error(
        `[rtap-server] Startup halted: In production mode, OPERATOR_TOKEN must be at least 16 characters (got ${clean.length}).`
      );
    }
    const forbiddenPatterns = ['strazh-operator-key', 'password', '12345678', 'changeme'];
    if (forbiddenPatterns.some((f) => clean.toLowerCase().includes(f))) {
      throw new Error(
        `[rtap-server] Startup halted: In production mode, known/default tokens ('${clean}') are forbidden. Please configure a unique, high-entropy secret.`
      );
    }
  }
  return clean;
}

export function createRtapServer(options: RtapServerOptions = {}) {
  const rtapRoot = options.rtapRoot ?? defaultRtapRoot;
  const operatorToken = validateOperatorToken(
    options.operatorToken ?? process.env.OPERATOR_TOKEN,
    process.env.NODE_ENV === 'production'
  );
  const dashboardDir = path.join(rtapRoot, 'dashboard');
  const service = new AssessmentService(rtapRoot, options.dataDir);

  function authenticateRequest(req: http.IncomingMessage, parsedUrl?: URL): OperatorUser | null {
    const authHeader = req.headers['authorization'];
    const customHeader = req.headers['x-operator-token'];

    let providedToken = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (typeof customHeader === 'string') {
      providedToken = customHeader.trim();
    } else if (parsedUrl && parsedUrl.searchParams.has('token')) {
      providedToken = (parsedUrl.searchParams.get('token') || '').trim();
    }

    if (providedToken && providedToken === operatorToken) {
      return { id: 'op-admin', username: 'operator', role: 'OPERATOR' };
    }
    return null;
  }

  function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    // Standard Security & CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Operator-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || '127.0.0.1:3000';
    const parsedUrl = new URL(req.url ?? '/', `http://${host}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // ==========================================
    // API ROUTES
    // ==========================================

    // 1. POST /api/auth/login
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      try {
        const body = await readJsonBody<{ token?: string }>(req);
        if (body.token && body.token === operatorToken) {
          sendJson(res, 200, {
            ok: true,
            token: body.token,
            user: { username: 'operator', role: 'OPERATOR' },
          });
          return;
        }
        sendJson(res, 401, { ok: false, error: 'Invalid operator credentials' });
        return;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: (err as Error).message });
        return;
      }
    }

    // 2. GET /api/auth/status
    if (req.method === 'GET' && pathname === '/api/auth/status') {
      const user = authenticateRequest(req);
      sendJson(res, 200, {
        authenticated: Boolean(user),
        user: user ?? null,
      });
      return;
    }

    // 3. GET /api/targets
    if (req.method === 'GET' && pathname === '/api/targets') {
      const hasNebiusKey = Boolean(process.env.NEBIUS_API_KEY);
      const targetsWithAvailability = APPROVED_TARGETS.map((t) => ({
        ...t,
        available: !t.requiresApiKey || hasNebiusKey,
      }));
      sendJson(res, 200, {
        targets: targetsWithAvailability,
        serverLiveCapable: hasNebiusKey,
      });
      return;
    }

    // 4. POST /api/assessments/start (Authenticated)
    if (req.method === 'POST' && pathname === '/api/assessments/start') {
      const user = authenticateRequest(req);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required. Operator login needed.' });
        return;
      }

      try {
        const body = await readJsonBody<{ targetId?: string }>(req);
        if (!body.targetId) {
          sendJson(res, 400, { ok: false, error: 'Missing targetId in request body.' });
          return;
        }

        const job = await service.startAssessment(body.targetId, user);
        sendJson(res, 202, {
          ok: true,
          assessmentRunId: job.assessmentRunId,
          targetId: job.targetId,
          targetName: job.targetName,
          status: job.status,
          createdAt: job.createdAt,
        });
        return;
      } catch (err) {
        if (err instanceof TargetNotFoundError) {
          sendJson(res, 400, { ok: false, error: err.message });
          return;
        }
        if (err instanceof MissingApiKeyError) {
          sendJson(res, 400, { ok: false, error: err.message });
          return;
        }
        if (err instanceof ConcurrencyLimitError) {
          sendJson(res, 429, { ok: false, error: err.message });
          return;
        }
        sendJson(res, 500, { ok: false, error: (err as Error).message });
        return;
      }
    }

    // 4b. GET /api/assessments (List Assessments, Authenticated)
    if (req.method === 'GET' && (pathname === '/api/assessments' || pathname === '/api/assessments/')) {
      const user = authenticateRequest(req, parsedUrl);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required to list assessments.' });
        return;
      }
      const jobs = service.listJobs().map((j) => ({
        assessmentRunId: j.assessmentRunId,
        targetId: j.targetId,
        targetName: j.targetName,
        mode: j.mode,
        status: j.status,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        error: j.error,
      }));
      sendJson(res, 200, { ok: true, jobs });
      return;
    }

    // 5. GET /api/assessments/:id (Authenticated)
    if (req.method === 'GET' && pathname.startsWith('/api/assessments/') && !pathname.endsWith('/report') && !pathname.endsWith('/sarif') && !pathname.endsWith('/cancel')) {
      const user = authenticateRequest(req, parsedUrl);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required to inspect assessment status.' });
        return;
      }

      const runId = pathname.replace('/api/assessments/', '').trim();
      const job = service.getJob(runId);
      if (!job) {
        sendJson(res, 404, { ok: false, error: `Assessment '${runId}' not found.` });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        assessmentRunId: job.assessmentRunId,
        targetId: job.targetId,
        targetName: job.targetName,
        mode: job.mode,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        summary: job.result
          ? {
              vulnerabilities: job.result.vulnerabilities,
              resistant: job.result.resistant,
              unverified: job.result.unverified,
              errors: job.result.errors,
              totalFindings: job.result.totalFindings,
              totalObservations: job.result.totalObservations,
              coverageStatus: job.result.coverageStatus,
              scheduled: job.result.scheduled,
              resolved: job.result.resolved,
            }
          : undefined,
      });
      return;
    }

    // 6. POST /api/assessments/:id/cancel (Kill Switch, Authenticated)
    if (req.method === 'POST' && pathname.startsWith('/api/assessments/') && pathname.endsWith('/cancel')) {
      const user = authenticateRequest(req, parsedUrl);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required. Operator login needed.' });
        return;
      }

      const runId = pathname.replace('/api/assessments/', '').replace('/cancel', '').trim();
      const cancelled = service.cancelAssessment(runId);
      if (cancelled) {
        sendJson(res, 200, { ok: true, cancelled: true, message: `Assessment '${runId}' cancelled.` });
      } else {
        sendJson(res, 400, { ok: false, cancelled: false, message: `Assessment '${runId}' is not running or not found.` });
      }
      return;
    }

    // 7. GET /api/assessments/:id/report (Report JSON, Authenticated)
    if (req.method === 'GET' && pathname.startsWith('/api/assessments/') && pathname.endsWith('/report')) {
      const user = authenticateRequest(req, parsedUrl);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required to access assessment report.' });
        return;
      }

      const runId = pathname.replace('/api/assessments/', '').replace('/report', '').trim();
      const reportJson = service.getJobReport(runId, 'json');
      if (!reportJson) {
        sendJson(res, 404, { ok: false, error: `Report for assessment '${runId}' not found or not yet generated.` });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(reportJson);
      return;
    }

    // 8. GET /api/assessments/:id/sarif (Report SARIF, Authenticated)
    if (req.method === 'GET' && pathname.startsWith('/api/assessments/') && pathname.endsWith('/sarif')) {
      const user = authenticateRequest(req, parsedUrl);
      if (!user) {
        sendJson(res, 401, { ok: false, error: 'Authentication required to access assessment SARIF report.' });
        return;
      }

      const runId = pathname.replace('/api/assessments/', '').replace('/sarif', '').trim();
      const sarifJson = service.getJobReport(runId, 'sarif');
      if (!sarifJson) {
        sendJson(res, 404, { ok: false, error: `SARIF for assessment '${runId}' not found or not yet generated.` });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(sarifJson);
      return;
    }

    // 9. GET /api/system/status
    if (req.method === 'GET' && pathname === '/api/system/status') {
      sendJson(res, 200, {
        primaryDomain: 'strazh.dev',
        status: 'online',
        liveNebiusCapable: Boolean(process.env.NEBIUS_API_KEY),
        activeAssessment: service.getActiveJob()?.assessmentRunId ?? null,
        maxConcurrency: 1,
      });
      return;
    }

    // ==========================================
    // STATIC DASHBOARD FILE SERVING
    // ==========================================
    let filePath = pathname === '/' || pathname === '' ? '/index.html' : pathname;
    if (filePath.startsWith('/dashboard/')) {
      filePath = filePath.replace('/dashboard/', '/');
    }

    const normalizedRel = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const absPath = path.join(dashboardDir, normalizedRel);

    if (!absPath.startsWith(dashboardDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    fs.stat(absPath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${pathname}`);
        return;
      }

      const ext = path.extname(absPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache',
      });

      const stream = fs.createReadStream(absPath);
      stream.pipe(res);
    });
  });

  return {
    server,
    service,
    listen: (port?: number, host?: string) => {
      const p = port ?? options.port ?? parseInt(process.env.PORT || '3000', 10);
      const h = host ?? options.host ?? process.env.HOST ?? '127.0.0.1';
      return new Promise<void>((resolve) => {
        server.listen(p, h, () => resolve());
      });
    },
    close: async () => {
      service.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// Direct CLI launch
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';
  const instance = createRtapServer({ port, host });
  instance.listen().then(() => {
    console.log(`[rtap-server] Production MVP Server running at http://${host}:${port}/`);
    console.log(`[rtap-server] Primary domain: strazh.dev`);
    console.log(`[rtap-server] Dashboard URL: http://${host}:${port}/index.html`);
  });
}
