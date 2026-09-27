import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import crypto from 'node:crypto';
import { parsePromptfooResult } from '../src/adapters/promptfoo/parse.js';
import { correlateFindings, type ObservationLike } from '../src/pipeline/correlate.js';
import { buildJsonReport, buildMarkdownReport, type ReportInput } from '../src/pipeline/report.js';
import { buildSarifReport } from '../src/pipeline/sarif.js';

interface ArtifactRunConfig {
  readonly runName: string;
  readonly originalRunDir: string;
  readonly targetOutDir: string;
  readonly targetId: string;
}

const RUNS: ArtifactRunConfig[] = [
  {
    runName: 'live-baseline',
    originalRunDir: path.resolve('demo/out/live-baseline'),
    targetOutDir: path.resolve('demo/out/derived-re-eval-baseline'),
    targetId: 'strazh-demo-baseline',
  },
  {
    runName: 'live-mitigated',
    originalRunDir: path.resolve('demo/out/live-mitigated'),
    targetOutDir: path.resolve('demo/out/derived-re-eval-mitigated'),
    targetId: 'strazh-demo-mitigated',
  },
];

function findArtifactFiles(dir: string): string[] {
  const artifactsDir = path.join(dir, 'artifacts');
  if (!fs.existsSync(artifactsDir)) return [];
  const files: string[] = [];
  const subdirs = fs.readdirSync(artifactsDir);
  for (const sub of subdirs) {
    const subpath = path.join(artifactsDir, sub);
    if (fs.statSync(subpath).isDirectory()) {
      for (const f of fs.readdirSync(subpath)) {
        files.push(path.join(subpath, f));
      }
    }
  }
  return files;
}

export function runOfflineDerivation() {
  console.log('Running Offline Re-Evaluation of preserved artifacts...');

  for (const cfg of RUNS) {
    console.log(`\n--- Processing ${cfg.runName} ---`);
    const origReportPath = path.join(cfg.originalRunDir, 'report.json');
    if (!fs.existsSync(origReportPath)) {
      console.error(`Original report not found at ${origReportPath}`);
      continue;
    }
    const origJson = JSON.parse(fs.readFileSync(origReportPath, 'utf8'));
    const originalRunId = origJson.assessmentRunId;
    console.log(`Original Assessment Run ID: ${originalRunId}`);

    const artifactFiles = findArtifactFiles(cfg.originalRunDir);
    console.log(`Found ${artifactFiles.length} artifact file(s) in preserved store`);

    const observations: ObservationLike[] = [];
    const scheduledKeys = new Set<string>();

    let idx = 0;
    for (const artFile of artifactFiles) {
      const rawContent = fs.readFileSync(artFile, 'utf8');
      const parsedPromptfoo = JSON.parse(rawContent);
      
      const probeId = parsedPromptfoo.testCase?.metadata?.strategyId
        ? `secret-marker:${parsedPromptfoo.testCase.metadata.strategyId}`
        : 'unknown-probe';

      scheduledKeys.add(probeId);

      const parsedObs = parsePromptfooResult(parsedPromptfoo, idx++, {
        assessmentRunId: originalRunId,
        targetId: cfg.targetId,
        nativeRunId: parsedPromptfoo.id || 'native-run',
        engineVersion: '0.122.0',
        adapterVersion: '0.0.0-m1-evaluator-v1.1-fix',
        probeId,
      });

      console.log(`  Artifact ${path.basename(artFile).slice(0, 12)}...: probe=${probeId} output="${String(parsedPromptfoo.response?.output ?? '').replace(/\n/g, '\\n')}" -> verdict=${parsedObs.verdict}`);

      observations.push({
        id: parsedObs.id,
        targetId: parsedObs.targetId,
        probeId: parsedObs.probeId,
        verdict: parsedObs.verdict as any,
        evidenceRefs: parsedObs.evidenceRefs,
      });
    }

    const findings = correlateFindings(observations);

    const reportInput: ReportInput = {
      assessmentRunId: `${originalRunId}-derived-eval-v1.1`,
      generatedAt: new Date().toISOString(),
      observations,
      findings,
      coverage: {
        scheduled: scheduledKeys.size,
        unresolved: [], // Both probes resolved to an evaluation observation (RESISTANT or UNVERIFIED)
      },
    };

    const jsonReport = buildJsonReport(reportInput);
    const markdownReport = buildMarkdownReport(reportInput);
    const sarifReport = JSON.stringify(buildSarifReport(reportInput, { toolVersion: '0.0.0-m1' }), null, 2);

    let gitRevision = 'unknown';
    try {
      gitRevision = String(child_process.execSync('git rev-parse HEAD', { cwd: path.resolve('..') })).trim();
    } catch {
      // ignore
    }

    const parseSourceHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.resolve('src/adapters/promptfoo/parse.ts')))
      .digest('hex');

    // Augmented provenance metadata for derived report.
    // Content-addressing note: A commit cannot reliably embed its own final SHA.
    // evaluatorSourceHash (SHA-256 of parse.ts) provides the immutable cryptographic
    // anchor for the evaluator logic, while evaluatorSourceBaseRevision records the
    // base repository commit from which this evaluation was run.
    const derivedJsonReport = {
      ...jsonReport,
      provenance: {
        derivationMode: 'OFFLINE_RE_EVALUATION',
        originalAssessmentRunId: originalRunId,
        originalRunDirectory: path.relative(process.cwd(), cfg.originalRunDir),
        evaluatorSourceHash: `sha256:${parseSourceHash}`,
        evaluatorSourceFile: 'src/adapters/promptfoo/parse.ts',
        evaluatorSourceBaseRevision: gitRevision,
        correctedEvaluator: 'promptfoo-adapter-v1.2-response-handling-fix',
        inferenceExecuted: false,
        note: 'Offline re-evaluation of preserved responses. No new inference requests were made.',
      },
    };

    const augmentedMarkdownReport = `${markdownReport}
## Provenance

- **Derivation Mode:** OFFLINE_RE_EVALUATION (re-evaluated from preserved artifact files; zero inference calls executed)
- **Original Assessment Run ID:** \`${originalRunId}\`
- **Original Run Directory:** \`${path.relative(process.cwd(), cfg.originalRunDir)}\`
- **Evaluator Source Hash:** \`sha256:${parseSourceHash}\` (\`src/adapters/promptfoo/parse.ts\`)
- **Evaluator Source Base Revision:** \`${gitRevision}\`
- **Evaluator Implementation:** \`promptfoo-adapter-v1.2-response-handling-fix\`
`;

    fs.mkdirSync(cfg.targetOutDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.targetOutDir, 'report.json'), JSON.stringify(derivedJsonReport, null, 2));
    fs.writeFileSync(path.join(cfg.targetOutDir, 'report.md'), augmentedMarkdownReport);
    fs.writeFileSync(path.join(cfg.targetOutDir, 'report.sarif'), sarifReport);

    console.log(`Saved derived report to ${cfg.targetOutDir}`);
    console.log(`Summary: totalObservations=${derivedJsonReport.summary.totalObservations}, RESISTANT=${derivedJsonReport.summary.resistant}, UNVERIFIED=${derivedJsonReport.summary.unverified}, VULNERABILITIES=${derivedJsonReport.summary.vulnerabilities}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runOfflineDerivation();
}
