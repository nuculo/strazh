import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { runAssessment, type AssessResult, AssessCancelledError } from '../cli/assess.js';
import { getApprovedTarget } from './targets.js';
import type { AssessmentJob, OperatorUser } from './types.js';

export class ConcurrencyLimitError extends Error {
  constructor(message = 'An assessment is already in progress. Global concurrency limit is 1.') {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

export class TargetNotFoundError extends Error {
  constructor(targetId: string) {
    super(`Target '${targetId}' is not an approved demo target.`);
    this.name = 'TargetNotFoundError';
  }
}

export class MissingApiKeyError extends Error {
  constructor(message = 'This target requires NEBIUS_API_KEY configured server-side.') {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

export class AssessmentService {
  private readonly rtapRoot: string;
  private readonly dataDir: string;
  private readonly jobs = new Map<string, AssessmentJob>();
  private activeJobId: string | null = null;
  private internalDemoServer: http.Server | null = null;

  constructor(rtapRoot: string, dataDir?: string) {
    this.rtapRoot = rtapRoot;
    this.dataDir = dataDir ?? process.env.RTAP_DATA_DIR ?? path.resolve(rtapRoot, 'runs');
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Resolves the Promptfoo runtime entrypoint.
   */
  public resolvePromptfooEntry(): string {
    if (process.env.PROMPTFOO_ENTRY && existsSync(process.env.PROMPTFOO_ENTRY)) {
      return process.env.PROMPTFOO_ENTRY;
    }
    const inRepo = path.resolve(this.rtapRoot, 'm0/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js');
    if (existsSync(inRepo)) return inRepo;

    const inRepoTooling = path.resolve(this.rtapRoot, '_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js');
    if (existsSync(inRepoTooling)) return inRepoTooling;

    const optTooling = '/opt/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js';
    if (existsSync(optTooling)) return optTooling;

    const tooling = path.resolve(this.rtapRoot, '../../_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js');
    if (existsSync(tooling)) return tooling;

    // Fallback: check node_modules in workspace
    const siblingTooling = path.resolve(this.rtapRoot, '../_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js');
    if (existsSync(siblingTooling)) return siblingTooling;

    return inRepo;
  }

  /**
   * Checks if demo target port 4000 is listening; if not, starts a dual-mode listener
   * capable of serving both deterministic offline simulation and live Nebius Token Factory inference.
   */
  private async ensureDemoServerListening(): Promise<void> {
    const isListening = await new Promise<boolean>((resolve) => {
      const req = http.get('http://127.0.0.1:4000/health', { timeout: 1500 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (!isListening && !this.internalDemoServer) {
      try {
        let demoModulePath = path.resolve(this.rtapRoot, 'dist/demo/server.js');
        if (!existsSync(demoModulePath)) {
          const directJs = path.resolve(this.rtapRoot, 'demo/server.js');
          if (existsSync(directJs)) demoModulePath = directJs;
          else demoModulePath = path.resolve(this.rtapRoot, 'demo/server.ts');
        }

        const demoUrl = pathToFileURL(demoModulePath).href;
        const demoModule = (await import(demoUrl)) as {
          createDemoServer: (variant: string, offline: boolean) => http.Server;
        };
        // Dual-mode server: routes /simulated/* to offline simulation, /live/* to live Nebius
        const srv = demoModule.createDemoServer('baseline', false);
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(4000, '127.0.0.1', () => resolve());
        });
        this.internalDemoServer = srv;
      } catch {
        // If port collision occurs, let standard assess error handling report it honestly
      }
    }
  }

  /**
   * Starts a bounded assessment for an approved demo target.
   * Enforces global concurrency limit of 1.
   */
  public async startAssessment(targetId: string, _operator: OperatorUser): Promise<AssessmentJob> {
    const target = getApprovedTarget(targetId);
    if (!target) {
      throw new TargetNotFoundError(targetId);
    }

    if (target.requiresApiKey && !process.env.NEBIUS_API_KEY) {
      throw new MissingApiKeyError(`Live Nebius target '${target.name}' requires NEBIUS_API_KEY in server environment.`);
    }

    if (this.activeJobId) {
      const current = this.jobs.get(this.activeJobId);
      if (current && (current.status === 'RUNNING' || current.status === 'QUEUED')) {
        throw new ConcurrencyLimitError();
      }
    }

    // Ensure demo target port 4000 is active if the target relies on the local demo application
    if (target.id !== 'strazh-target-unavailable' && target.targetYamlRelative.includes('demo/targets/')) {
      await this.ensureDemoServerListening();
    }

    const assessmentRunId = `assess-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const outDir = path.resolve(this.dataDir, assessmentRunId);
    mkdirSync(outDir, { recursive: true });

    const abortController = new AbortController();
    const job: AssessmentJob = {
      assessmentRunId,
      targetId: target.id,
      targetName: target.name,
      mode: target.mode,
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      abortController,
      outDir,
    };

    this.jobs.set(assessmentRunId, job);
    this.activeJobId = assessmentRunId;

    // Execute asynchronously to return 202 / job handle immediately
    this.executeJob(job, target.targetYamlRelative).catch((err) => {
      console.error(`[AssessmentService] Unexpected error in job ${assessmentRunId}:`, err);
    });

    return job;
  }

  private async executeJob(job: AssessmentJob, targetYamlRelative: string): Promise<void> {
    job.status = 'RUNNING';
    job.startedAt = new Date().toISOString();

    const targetPath = path.resolve(this.rtapRoot, targetYamlRelative);
    const dbPath = path.join(job.outDir, 'assessment.sqlite');
    const promptfooEntry = this.resolvePromptfooEntry();

    try {
      const result: AssessResult = await runAssessment({
        assessmentRunId: job.assessmentRunId,
        targetPath,
        outDir: job.outDir,
        promptfooEntry,
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        dbPath,
        maxRequests: 4,
        perProbeTimeoutMs: 15_000,
        signal: job.abortController?.signal,
      });

      job.result = result;
      job.status = 'SUCCEEDED';
      job.completedAt = new Date().toISOString();
    } catch (err) {
      job.completedAt = new Date().toISOString();
      if (err instanceof AssessCancelledError || job.abortController?.signal.aborted) {
        job.status = 'CANCELLED';
        job.error = 'Assessment was cancelled by operator (kill switch triggered).';
      } else {
        job.status = 'FAILED';
        job.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.activeJobId === job.assessmentRunId) {
        this.activeJobId = null;
      }
    }
  }

  /**
   * Kill switch: cancels an active assessment.
   */
  public cancelAssessment(assessmentRunId: string): boolean {
    const job = this.jobs.get(assessmentRunId);
    if (!job) return false;

    if (job.status === 'RUNNING' || job.status === 'QUEUED') {
      job.abortController?.abort();
      job.status = 'CANCELLED';
      job.completedAt = new Date().toISOString();
      job.error = 'Assessment cancelled by operator.';
      if (this.activeJobId === assessmentRunId) {
        this.activeJobId = null;
      }
      return true;
    }

    return false;
  }

  public getJob(assessmentRunId: string): AssessmentJob | undefined {
    const memJob = this.jobs.get(assessmentRunId);
    if (memJob) return memJob;

    // Check if run was persisted to disk from prior session or replacement container
    const outDir = path.resolve(this.dataDir, assessmentRunId);
    const separateReport = path.join(outDir, 'reports', 'report.json');
    const legacyReport = path.join(outDir, 'report.json');
    const reportPath = existsSync(separateReport) ? separateReport : legacyReport;

    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        const job: AssessmentJob = {
          assessmentRunId,
          targetId: report.findings?.[0]?.targetId || 'Unknown',
          targetName: 'Persisted Prior Assessment',
          mode: 'offline-simulated',
          status: 'SUCCEEDED',
          createdAt: report.generatedAt || new Date().toISOString(),
          outDir,
        };
        this.jobs.set(assessmentRunId, job);
        return job;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  public listJobs(): readonly AssessmentJob[] {
    if (existsSync(this.dataDir)) {
      try {
        const entries = readdirSync(this.dataDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('assess-')) {
            const runId = entry.name;
            if (!this.jobs.has(runId)) {
              this.getJob(runId);
            }
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  public getJobReport(assessmentRunId: string, format: 'json' | 'sarif' | 'markdown'): string | null {
    const job = this.jobs.get(assessmentRunId);
    const outDir = job ? job.outDir : path.resolve(this.dataDir, assessmentRunId);

    const fileName = format === 'json' ? 'report.json' : format === 'sarif' ? 'report.sarif' : 'report.md';
    const separatePath = path.join(outDir, 'reports', fileName);
    if (existsSync(separatePath)) {
      return readFileSync(separatePath, 'utf-8');
    }

    const legacyPath = path.join(outDir, fileName);
    if (existsSync(legacyPath)) {
      return readFileSync(legacyPath, 'utf-8');
    }

    return null;
  }

  public getActiveJob(): AssessmentJob | null {
    if (!this.activeJobId) return null;
    return this.jobs.get(this.activeJobId) ?? null;
  }

  public close(): void {
    if (this.internalDemoServer) {
      try {
        this.internalDemoServer.close();
      } catch {}
      this.internalDemoServer = null;
    }
  }
}
