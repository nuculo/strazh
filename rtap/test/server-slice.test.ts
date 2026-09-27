import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRtapServer, validateOperatorToken } from '../src/server/server.js';
import { APPROVED_TARGETS } from '../src/server/targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rtapRoot = path.resolve(__dirname, '..');

describe('RTAP Production MVP Server Slice (strazh.dev)', () => {
  let serverInstance: ReturnType<typeof createRtapServer>;
  let baseUrl: string;
  const operatorToken = 'strong-operator-secret-token-38910';

  beforeAll(async () => {
    // Start on ephemeral port with explicit strong operator token
    serverInstance = createRtapServer({
      rtapRoot,
      operatorToken,
      port: 0,
      host: '127.0.0.1',
    });
    await serverInstance.listen(0, '127.0.0.1');
    const addr = serverInstance.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await serverInstance.close();
  });

  it('validateOperatorToken enforces strong token and rejects default/missing tokens', () => {
    // Missing / empty token throws in all modes
    expect(() => validateOperatorToken(undefined)).toThrow('OPERATOR_TOKEN environment variable is required');
    expect(() => validateOperatorToken('')).toThrow('OPERATOR_TOKEN environment variable is required');
    expect(() => validateOperatorToken('   ')).toThrow('OPERATOR_TOKEN environment variable is required');

    // Production mode rejects short tokens (<16 chars)
    expect(() => validateOperatorToken('short-token', true)).toThrow('must be at least 16 characters');

    // Production mode rejects known default/weak tokens
    expect(() => validateOperatorToken('strazh-operator-key', true)).toThrow('known/default tokens');
    expect(() => validateOperatorToken('passwordpassword1', true)).toThrow();

    // Valid strong token passes in production
    expect(validateOperatorToken('xK9#vL2$mQ8*wP4!zR7@', true)).toBe('xK9#vL2$mQ8*wP4!zR7@');
  });

  it('GET /api/system/status reports primary domain strazh.dev and concurrency limit 1', async () => {
    const res = await fetch(`${baseUrl}/api/system/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.primaryDomain).toBe('strazh.dev');
    expect(body.status).toBe('online');
    expect(body.maxConcurrency).toBe(1);
  });

  it('verifies operator authentication workflow', async () => {
    // 1. Status without auth
    const unauthRes = await fetch(`${baseUrl}/api/auth/status`);
    expect(unauthRes.status).toBe(200);
    const unauthBody = await unauthRes.json();
    expect(unauthBody.authenticated).toBe(false);

    // 2. Login with bad token
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(badLoginRes.status).toBe(401);

    // 3. Login with good token
    const goodLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: operatorToken }),
    });
    expect(goodLoginRes.status).toBe(200);
    const goodLoginBody = await goodLoginRes.json();
    expect(goodLoginBody.ok).toBe(true);
    expect(goodLoginBody.user.role).toBe('OPERATOR');

    // 4. Status with Bearer token
    const authStatusRes = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(authStatusRes.status).toBe(200);
    const authStatusBody = await authStatusRes.json();
    expect(authStatusBody.authenticated).toBe(true);
    expect(authStatusBody.user.username).toBe('operator');
  });

  it('GET /api/targets lists approved targets without accepting arbitrary configurations', async () => {
    const res = await fetch(`${baseUrl}/api/targets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.targets)).toBe(true);
    expect(body.targets.length).toBe(APPROVED_TARGETS.length);

    const ids = body.targets.map((t: { id: string }) => t.id);
    expect(ids).toContain('strazh-baseline-simulated');
    expect(ids).toContain('strazh-mitigated-simulated');
    expect(ids).toContain('strazh-nebius-live-baseline');
    expect(ids).toContain('strazh-nebius-direct');

    const baseline = body.targets.find((t: { id: string }) => t.id === 'strazh-baseline-simulated');
    expect(baseline.probeCount).toBe(2);
    expect(baseline.budgetAttempts).toBe(4);
    expect(baseline.timeoutSeconds).toBe(15);
  });

  it('strictly requires authorization for starting, cancelling, reading status, and reports', async () => {
    // 1. Start requires auth
    const startRes = await fetch(`${baseUrl}/api/assessments/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: 'strazh-baseline-simulated' }),
    });
    expect(startRes.status).toBe(401);

    // 2. Cancel requires auth
    const cancelRes = await fetch(`${baseUrl}/api/assessments/assess-fake-run/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(401);

    // 3. Status inspection requires auth
    const statusRes = await fetch(`${baseUrl}/api/assessments/assess-fake-run`);
    expect(statusRes.status).toBe(401);

    // 4. Report download requires auth
    const reportRes = await fetch(`${baseUrl}/api/assessments/assess-fake-run/report`);
    expect(reportRes.status).toBe(401);

    // 5. SARIF download requires auth
    const sarifRes = await fetch(`${baseUrl}/api/assessments/assess-fake-run/sarif`);
    expect(sarifRes.status).toBe(401);
  });

  it('rejects arbitrary unapproved targets (no arbitrary user URLs/configs)', async () => {
    const res = await fetch(`${baseUrl}/api/assessments/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({ targetId: 'https://arbitrary-attacker-site.com/eval' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('is not an approved demo target');
  });

  it('rejects live Nebius targets when NEBIUS_API_KEY is missing on server', async () => {
    const origKey = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;

    try {
      const res = await fetch(`${baseUrl}/api/assessments/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${operatorToken}`,
        },
        body: JSON.stringify({ targetId: 'strazh-nebius-live-baseline' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('requires NEBIUS_API_KEY');
    } finally {
      if (origKey !== undefined) process.env.NEBIUS_API_KEY = origKey;
    }
  });

  it('enforces concurrency limit of 1 and supports kill switch', async () => {
    // Start an assessment with unavailable target (which times out cleanly or attempts connection)
    const startRes = await fetch(`${baseUrl}/api/assessments/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({ targetId: 'strazh-target-unavailable' }),
    });
    expect(startRes.status).toBe(202);
    const startData = await startRes.json();
    const runId = startData.assessmentRunId;

    // Concurrency test: starting another assessment while one is active returns 429
    const secondStartRes = await fetch(`${baseUrl}/api/assessments/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({ targetId: 'strazh-baseline-simulated' }),
    });
    expect(secondStartRes.status).toBe(429);
    const secondData = await secondStartRes.json();
    expect(secondData.error).toContain('Global concurrency limit is 1');

    // Kill switch test: cancel the active assessment
    const cancelRes = await fetch(`${baseUrl}/api/assessments/${runId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(cancelRes.status).toBe(200);

    // Wait for job status to show CANCELLED
    let cancelled = false;
    for (let i = 0; i < 20; i++) {
      const statusRes = await fetch(`${baseUrl}/api/assessments/${runId}`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      const statusData = await statusRes.json();
      if (statusData.status === 'CANCELLED') {
        cancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(cancelled).toBe(true);

    // After cancellation, a new assessment can be started (lock released)
    const afterCancelStatus = await fetch(`${baseUrl}/api/system/status`);
    const statusBody = await afterCancelStatus.json();
    expect(statusBody.activeAssessment).toBeNull();
  });

  it('executes simulated baseline target end-to-end and preserves reports across server restart', async () => {
    // Start simulated baseline run
    const startRes = await fetch(`${baseUrl}/api/assessments/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({ targetId: 'strazh-baseline-simulated' }),
    });
    expect(startRes.status).toBe(202);
    const startData = await startRes.json();
    const runId = startData.assessmentRunId;
    expect(runId).toMatch(/^assess-/);

    // Poll until completed (SUCCEEDED or FAILED) with authentication
    let finalStatus = '';
    let attempts = 0;
    while (attempts < 60) {
      const checkRes = await fetch(`${baseUrl}/api/assessments/${runId}`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(checkRes.status).toBe(200);
      const checkData = await checkRes.json();
      finalStatus = checkData.status;
      if (finalStatus === 'SUCCEEDED' || finalStatus === 'FAILED') {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }

    expect(finalStatus).toBe('SUCCEEDED');

    // Verify report.json was persisted and is served via authenticated API
    const reportRes = await fetch(`${baseUrl}/api/assessments/${runId}/report`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(reportRes.status).toBe(200);
    const reportData = await reportRes.json();
    expect(reportData.schemaVersion).toBe('1.0.0');
    expect(reportData.assessmentRunId).toBe(runId);
    expect(reportData.summary).toBeDefined();
    expect(Array.isArray(reportData.findings)).toBe(true);

    // Verify report.sarif was persisted and is served via authenticated API (also testing ?token= parameter)
    const sarifRes = await fetch(`${baseUrl}/api/assessments/${runId}/sarif?token=${encodeURIComponent(operatorToken)}`);
    expect(sarifRes.status).toBe(200);
    const sarifData = await sarifRes.json();
    expect(sarifData.version).toBe('2.1.0');
    expect(Array.isArray(sarifData.runs)).toBe(true);

    // ==========================================
    // Server Restart & Durability Verification
    // ==========================================
    // Spin up a second server instance pointing to the same rtapRoot
    const restartedServer = createRtapServer({
      rtapRoot,
      operatorToken,
      port: 0,
      host: '127.0.0.1',
    });
    await restartedServer.listen(0, '127.0.0.1');
    const restartedAddr = restartedServer.server.address() as AddressInfo;
    const restartedBaseUrl = `http://127.0.0.1:${restartedAddr.port}`;

    try {
      // 1. In-flight concurrency lock is clear upon restart
      const restartedStatusRes = await fetch(`${restartedBaseUrl}/api/system/status`);
      const restartedStatus = await restartedStatusRes.json();
      expect(restartedStatus.activeAssessment).toBeNull();

      // 2. Persisted report can still be read across restart with auth
      const postRestartReportRes = await fetch(`${restartedBaseUrl}/api/assessments/${runId}/report`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(postRestartReportRes.status).toBe(200);
      const postRestartData = await postRestartReportRes.json();
      expect(postRestartData.assessmentRunId).toBe(runId);

      // 3. Persisted SARIF can still be read across restart with auth
      const postRestartSarifRes = await fetch(`${restartedBaseUrl}/api/assessments/${runId}/sarif`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(postRestartSarifRes.status).toBe(200);

      // 4. Unauthenticated request to restarted server is still rejected
      const unauthPostRestartRes = await fetch(`${restartedBaseUrl}/api/assessments/${runId}/report`);
      expect(unauthPostRestartRes.status).toBe(401);

      // 5. Container replacement simulation: listJobs discovers persisted assessment on volume
      const listRes = await fetch(`${restartedBaseUrl}/api/assessments`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(Array.isArray(listData.jobs)).toBe(true);
      expect(listData.jobs.some((j: any) => j.assessmentRunId === runId)).toBe(true);
    } finally {
      await restartedServer.close();
    }
  }, 45000);
});
