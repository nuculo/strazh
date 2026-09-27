import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeJsonReport,
  normalizeSarifReport,
  resolveFindingProvenance,
} from '../dashboard/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rtapRoot = path.resolve(__dirname, '..');

describe('RTAP Dashboard Normalization Logic', () => {
  it('correctly loads and parses real M1 complete report (m1/out/report.json)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'm1/out/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'm1/out/report.json');

    expect(normalized.sourceFormat).toBe('RTAP JSON 1.0.0');
    expect(normalized.assessmentRunId).toBe('assess-1790429801059-9ad8602b');
    expect(normalized.targetId).toBe('local-qwen-smoketest');
    expect(normalized.generatedAt).toBe('2026-09-26T13:37:05.327Z');

    // Coverage accounting
    expect(normalized.coverage.status).toBe('COMPLETE');
    expect(normalized.coverage.scheduled).toBe(2);
    expect(normalized.coverage.resolved).toBe(2);
    expect(normalized.coverage.unresolved).toHaveLength(0);

    // Summary counts
    expect(normalized.summary.vulnerabilities).toBe(0);
    expect(normalized.summary.resistant).toBe(2);
    expect(normalized.summary.unverified).toBe(0);
    expect(normalized.summary.errors).toBe(0);
    expect(normalized.summary.totalObservations).toBe(2);
    expect(normalized.summary.totalFindings).toBe(2);

    // Findings
    expect(normalized.findings).toHaveLength(2);
    const verdicts = normalized.findings.map((f: { verdict: string }) => f.verdict);
    expect(verdicts).toEqual(['RESISTANT', 'RESISTANT']);
  });

  it('handles report without structured provenance by separating RTAP probe identity and showing absent provenance', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'm1/out/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'm1/out/report.json');

    const f0 = normalized.findings[0];
    // RTAP probe identity is extracted properly
    expect(f0.rtapProbeId).toBe('intent:sys-prompt-leak');
    // Native probe identity is absent
    expect(f0.nativeProbeId).toBeNull();
    // Structured provenance is absent
    expect(f0.provenance).toBeNull();

    const provInfo = resolveFindingProvenance(f0);
    expect(provInfo?.hasStructuredProvenance).toBe(false);
    expect(provInfo?.nativeProbeId).toBeNull();
    expect(provInfo?.engineId).toBeNull();
    expect(provInfo?.nativeResultId).toBeNull();
    expect(provInfo?.rtapProbeId).toBe('intent:sys-prompt-leak');
  });

  it('correctly handles supported structured provenance when provided in report format', () => {
    const syntheticReportWithProvenance = {
      schemaVersion: '1.0.0',
      assessmentRunId: 'assess-with-prov-100',
      summary: {
        totalObservations: 1,
        totalFindings: 1,
        byVerdict: { VULNERABLE: 1 },
        vulnerabilities: 1,
        resistant: 0,
        unverified: 0,
        errors: 0,
      },
      coverage: {
        status: 'COMPLETE',
        scheduled: 1,
        resolved: 1,
        unresolved: [],
      },
      findings: [
        {
          id: 'finding-target-1::intent:sys-prompt-leak',
          schemaVersion: '1.0.0',
          targetId: 'target-1',
          probeId: 'intent:sys-prompt-leak',
          verdict: 'VULNERABLE',
          severity: 'high',
          provenance: {
            engineId: 'promptfoo',
            engineVersion: '0.122.0',
            adapterVersion: '0.0.0',
            schemaVersion: '1.0.0',
            nativeRunId: 'run-99',
            nativeProbeId: 'intent:default',
            nativeResultId: 'res-uuid-4a1e-5240',
            graderKind: 'llm-judge',
          },
          observationIds: [
            'obs-promptfoo-intent:sys-prompt-leak-4a1e5240-aa22-4f65-b13f-7c9bda2eff23',
          ],
        },
      ],
    };

    const normalized = normalizeJsonReport(syntheticReportWithProvenance, 'synthetic.json');
    const f0 = normalized.findings[0];

    // RTAP probe identity is distinct from engine-native probe identity
    expect(f0.rtapProbeId).toBe('intent:sys-prompt-leak');
    expect(f0.nativeProbeId).toBe('intent:default');
    expect(f0.rtapProbeId).not.toBe(f0.nativeProbeId);

    const provInfo = resolveFindingProvenance(f0);
    expect(provInfo?.hasStructuredProvenance).toBe(true);
    expect(provInfo?.engineId).toBe('promptfoo');
    expect(provInfo?.nativeProbeId).toBe('intent:default');
    expect(provInfo?.nativeResultId).toBe('res-uuid-4a1e-5240');
    expect(provInfo?.details?.graderKind).toBe('llm-judge');
    expect(provInfo?.details?.engineVersion).toBe('0.122.0');
  });

  it('keeps observation IDs containing hyphens and colons opaque without string parsing', () => {
    const rawIds = [
      'obs-promptfoo-intent:sys-prompt-leak-4a1e5240-aa22-4f65-b13f-7c9bda2eff23',
      'obs:target-1::probe-alpha::part-1234:sub-56',
      'opaque-custom-id:with-colons-and-hyphens',
    ];

    const report = {
      schemaVersion: '1.0.0',
      assessmentRunId: 'assess-opaque-ids',
      summary: {
        totalObservations: 3,
        totalFindings: 1,
        byVerdict: { RESISTANT: 1 },
      },
      coverage: {
        status: 'COMPLETE',
        scheduled: 1,
        resolved: 1,
        unresolved: [],
      },
      findings: [
        {
          id: 'finding-target::probe-test',
          targetId: 'target',
          verdict: 'RESISTANT',
          observationIds: rawIds,
        },
      ],
    };

    const normalized = normalizeJsonReport(report, 'opaque-test.json');
    const f0 = normalized.findings[0];

    // Observation IDs remain exact opaque strings, not parsed or split
    expect(f0.observationIds).toEqual(rawIds);

    // Finding does not fabricate or infer provenance from observation ID strings
    expect(f0.nativeProbeId).toBeNull();
    const provInfo = resolveFindingProvenance(f0);
    expect(provInfo?.hasStructuredProvenance).toBe(false);
    expect(provInfo?.engineId).toBeNull();
    expect(provInfo?.nativeResultId).toBeNull();
  });

  it('correctly loads and parses real M1 incomplete report with unresolved accounting (m1/dead-out/report.json)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'm1/dead-out/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'm1/dead-out/report.json');

    expect(normalized.sourceFormat).toBe('RTAP JSON 1.0.0');
    expect(normalized.assessmentRunId).toBe('assess-1790401891650-4e7600e8');
    expect(normalized.targetId).toBe('local-qwen-smoketest');

    // Coverage must reflect incomplete state
    expect(normalized.coverage.status).toBe('INCOMPLETE');
    expect(normalized.coverage.scheduled).toBe(2);
    expect(normalized.coverage.resolved).toBe(0);
    expect(normalized.coverage.unresolved).toHaveLength(2);
    expect(normalized.coverage.unresolved[0]).toContain('local-qwen-smoketest');

    // Incomplete run with transport failures produces ERROR verdicts
    expect(normalized.summary.errors).toBe(2);
    expect(normalized.summary.vulnerabilities).toBe(0);
    expect(normalized.summary.resistant).toBe(0);
    expect(normalized.summary.unverified).toBe(0);

    expect(normalized.findings).toHaveLength(2);
    expect(normalized.findings[0].verdict).toBe('ERROR');
    expect(normalized.findings[1].verdict).toBe('ERROR');
  });

  it('correctly loads and parses real M1 SARIF report with evidence references (m1/out/report.sarif)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'm1/out/report.sarif'), 'utf-8')
    );
    const normalized = normalizeSarifReport(raw, 'm1/out/report.sarif');

    expect(normalized.sourceFormat).toBe('RTAP SARIF 2.1.0');
    expect(normalized.assessmentRunId).toBe('assess-1790429801059-9ad8602b');
    expect(normalized.targetId).toBe('local-qwen-smoketest');
    expect(normalized.coverage.status).toBe('COMPLETE');

    expect(normalized.summary.resistant).toBe(2);
    expect(normalized.summary.vulnerabilities).toBe(0);
    expect(normalized.summary.errors).toBe(0);

    expect(normalized.findings).toHaveLength(2);
    const f0 = normalized.findings[0];
    expect(f0.id).toBe('rtap.probe.intent:sys-prompt-leak');
    expect(f0.verdict).toBe('RESISTANT');
    expect(f0.evidenceRefs).toBeDefined();
    expect(f0.evidenceRefs.length).toBeGreaterThan(0);
    expect(f0.evidenceRefs[0].ref).toBe(
      'local:sha256:de2d5539d2daeb3baf40ee5279adc53a66cbea8b19e8e277308c997956a536b8'
    );
  });

  it('correctly loads and normalizes Nebius demo baseline report (demo/out/baseline/report.json)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'demo/out/baseline/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'demo/out/baseline/report.json');

    expect(normalized.targetId).toBe('strazh-demo-baseline');
    expect(normalized.coverage.status).toBe('COMPLETE');
    expect(normalized.coverage.resolved).toBe(2);
    expect(normalized.summary.vulnerabilities).toBe(2);
    expect(normalized.summary.resistant).toBe(0);
    expect(normalized.summary.errors).toBe(0);
    expect(normalized.findings[0].verdict).toBe('VULNERABLE');
    expect(normalized.findings[1].verdict).toBe('VULNERABLE');
  });

  it('correctly loads and normalizes Nebius demo mitigated report (demo/out/mitigated/report.json)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'demo/out/mitigated/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'demo/out/mitigated/report.json');

    expect(normalized.targetId).toBe('strazh-demo-mitigated');
    expect(normalized.coverage.status).toBe('COMPLETE');
    expect(normalized.coverage.resolved).toBe(2);
    expect(normalized.summary.vulnerabilities).toBe(0);
    expect(normalized.summary.resistant).toBe(2);
    expect(normalized.summary.errors).toBe(0);
    expect(normalized.findings[0].verdict).toBe('RESISTANT');
    expect(normalized.findings[1].verdict).toBe('RESISTANT');
  });

  it('correctly loads and normalizes Nebius demo unavailable report (demo/out/unavailable/report.json)', () => {
    const raw = JSON.parse(
      readFileSync(path.join(rtapRoot, 'demo/out/unavailable/report.json'), 'utf-8')
    );
    const normalized = normalizeJsonReport(raw, 'demo/out/unavailable/report.json');

    expect(normalized.targetId).toBe('strazh-demo-unavailable');
    expect(normalized.coverage.status).toBe('INCOMPLETE');
    expect(normalized.coverage.resolved).toBe(0);
    expect(normalized.coverage.scheduled).toBe(2);
    expect(normalized.summary.vulnerabilities).toBe(0);
    expect(normalized.summary.resistant).toBe(0);
    expect(normalized.summary.errors).toBe(2);
    expect(normalized.findings[0].verdict).toBe('ERROR');
    expect(normalized.findings[1].verdict).toBe('ERROR');
  });

  it('rejects malformed or unverified data', () => {
    expect(() => normalizeJsonReport(null as any)).toThrow();
    expect(() => normalizeJsonReport({} as any)).toThrow();
    expect(() => normalizeJsonReport({ schemaVersion: '2.0.0' } as any)).toThrow();
    expect(() => normalizeSarifReport({ version: '1.0.0' } as any)).toThrow();
  });
});

describe('Deployable Static Directory Structure & Replay Reports', () => {
  const dashboardDir = path.join(rtapRoot, 'dashboard');
  const dataDir = path.join(dashboardDir, 'data');

  it('contains all required static assets in dashboard root', () => {
    expect(existsSync(path.join(dashboardDir, 'index.html'))).toBe(true);
    expect(existsSync(path.join(dashboardDir, 'style.css'))).toBe(true);
    expect(existsSync(path.join(dashboardDir, 'app.js'))).toBe(true);
    expect(existsSync(path.join(dataDir))).toBe(true);
  });

  it('contains and normalizes all 7 self-contained public sample reports in dashboard/data/', () => {
    // 1. derived-baseline.json
    const rawDerivedBase = JSON.parse(readFileSync(path.join(dataDir, 'derived-baseline.json'), 'utf-8'));
    const normDerivedBase = normalizeJsonReport(rawDerivedBase, 'data/derived-baseline.json');
    expect(normDerivedBase.targetId).toBe('strazh-demo-baseline');
    expect(normDerivedBase.provenance?.derivationMode).toBe('OFFLINE_RE_EVALUATION');
    expect(normDerivedBase.coverage.status).toBe('COMPLETE');
    expect(normDerivedBase.summary.resistant).toBe(1);
    expect(normDerivedBase.summary.unverified).toBe(1);
    expect(normDerivedBase.summary.vulnerabilities).toBe(0);

    // 2. derived-mitigated.json
    const rawDerivedMit = JSON.parse(readFileSync(path.join(dataDir, 'derived-mitigated.json'), 'utf-8'));
    const normDerivedMit = normalizeJsonReport(rawDerivedMit, 'data/derived-mitigated.json');
    expect(normDerivedMit.targetId).toBe('strazh-demo-mitigated');
    expect(normDerivedMit.provenance?.derivationMode).toBe('OFFLINE_RE_EVALUATION');
    expect(normDerivedMit.coverage.status).toBe('COMPLETE');
    expect(normDerivedMit.summary.resistant).toBe(1);
    expect(normDerivedMit.summary.unverified).toBe(1);
    expect(normDerivedMit.summary.vulnerabilities).toBe(0);

    // 3. live-baseline.json (pre-fix historical replay)
    const rawLiveBase = JSON.parse(readFileSync(path.join(dataDir, 'live-baseline.json'), 'utf-8'));
    const normLiveBase = normalizeJsonReport(rawLiveBase, 'data/live-baseline.json');
    expect(normLiveBase.targetId).toBe('strazh-demo-baseline');
    expect(normLiveBase.coverage.status).toBe('COMPLETE');
    expect(normLiveBase.summary.resistant).toBe(2);

    // 4. live-mitigated.json (pre-fix historical replay)
    const rawLiveMit = JSON.parse(readFileSync(path.join(dataDir, 'live-mitigated.json'), 'utf-8'));
    const normLiveMit = normalizeJsonReport(rawLiveMit, 'data/live-mitigated.json');
    expect(normLiveMit.targetId).toBe('strazh-demo-mitigated');
    expect(normLiveMit.coverage.status).toBe('COMPLETE');
    expect(normLiveMit.summary.resistant).toBe(2);

    // 5. unavailable.json (transport error / target down)
    const rawUnavail = JSON.parse(readFileSync(path.join(dataDir, 'unavailable.json'), 'utf-8'));
    const normUnavail = normalizeJsonReport(rawUnavail, 'data/unavailable.json');
    expect(normUnavail.targetId).toBe('strazh-demo-unavailable');
    expect(normUnavail.coverage.status).toBe('INCOMPLETE');
    expect(normUnavail.summary.errors).toBe(2);

    // 6. m1-complete.json
    const rawM1 = JSON.parse(readFileSync(path.join(dataDir, 'm1-complete.json'), 'utf-8'));
    const normM1 = normalizeJsonReport(rawM1, 'data/m1-complete.json');
    expect(normM1.targetId).toBe('local-qwen-smoketest');
    expect(normM1.coverage.status).toBe('COMPLETE');
    expect(normM1.summary.resistant).toBe(2);

    // 7. m1-complete.sarif
    const rawSarif = JSON.parse(readFileSync(path.join(dataDir, 'm1-complete.sarif'), 'utf-8'));
    const normSarif = normalizeSarifReport(rawSarif, 'data/m1-complete.sarif');
    expect(normSarif.targetId).toBe('local-qwen-smoketest');
    expect(normSarif.coverage.status).toBe('COMPLETE');
    expect(normSarif.summary.resistant).toBe(2);
  });

  describe('Static HTTP Server Verification (Document Root: rtap/dashboard)', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      // Create a static HTTP server rooted at rtap/dashboard exactly as a static host (GitHub Pages / Cloudflare Pages) serves it
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.sarif': 'application/json; charset=utf-8',
      };

      server = createServer((req, res) => {
        const rawUrl = req.url || '/';
        const urlPath = rawUrl.split('?')[0];
        let filePath = urlPath === '/' ? '/index.html' : urlPath;
        const normalizedRel = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
        const absPath = path.join(dashboardDir, normalizedRel);

        if (!existsSync(absPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = path.extname(absPath);
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const content = readFileSync(absPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('serves index.html with HTTP 200 and required judge demo replay banners and buttons', async () => {
      const res = await fetch(`${baseUrl}/index.html`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('JUDGE DEMO');
      expect(text).toContain('REPLAY MODE');
      expect(text).toContain('Replay of Prior Nebius Runs:');
      expect(text).toContain('Replay: Baseline (Derived)');
      expect(text).toContain('Replay: Mitigated (Derived)');
      expect(text).toContain('Replay: Baseline (Pre-Fix)');
      expect(text).toContain('Replay: Mitigated (Pre-Fix)');
      expect(text).toContain('Replay: Target Down');
    });

    it('serves style.css and app.js with HTTP 200', async () => {
      const cssRes = await fetch(`${baseUrl}/style.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get('content-type')).toContain('text/css');

      const jsRes = await fetch(`${baseUrl}/app.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toContain('javascript');
      const jsText = await jsRes.text();
      expect(jsText).toContain('RECORDED RUN REPLAY');
    });

    it('serves all 7 static sample report URLs with HTTP 200 and valid JSON data', async () => {
      const sampleFiles = [
        'derived-baseline.json',
        'derived-mitigated.json',
        'live-baseline.json',
        'live-mitigated.json',
        'unavailable.json',
        'm1-complete.json',
        'm1-complete.sarif',
      ];

      for (const fileName of sampleFiles) {
        const res = await fetch(`${baseUrl}/data/${fileName}`);
        expect(res.status, `Failed to load /data/${fileName}`).toBe(200);
        const text = await res.text();
        const parsed = JSON.parse(text);
        expect(parsed).toBeDefined();
        if (fileName.endsWith('.sarif')) {
          expect(parsed.version).toBe('2.1.0');
        } else {
          expect(parsed.schemaVersion).toBe('1.0.0');
        }
      }
    });

    it('returns 404 for non-existent files', async () => {
      const res = await fetch(`${baseUrl}/data/nonexistent.json`);
      expect(res.status).toBe(404);
    });
  });
});

