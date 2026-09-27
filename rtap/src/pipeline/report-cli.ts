#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../db/connection.js';
import { ObservationStore } from '../observations/store.js';
import { correlateFindings, type ObservationLike } from './correlate.js';
import { buildJsonReport, buildMarkdownReport, buildAssessmentReport, type ReportInput } from './report.js';
import { buildSarifReport } from './sarif.js';
import type { ArtifactRef } from '../artifacts/store.js';

/**
 * The production caller the report builders never had: it reads one assessment run's
 * committed Observations out of a real database, correlates them into Findings, and
 * renders JSON, Markdown, or SARIF to stdout or a file. SARIF is the reason this exists
 * — it is the surface RTAP publishes outward (GitHub code scanning and other tools
 * ingest it), and until now there was no way to actually produce one.
 *
 * Coverage is honest by construction. This CLI renders committed evidence; it does not
 * own the CampaignWorld that knows which scheduled probes never resolved. Absent an
 * explicit --coverage-scheduled, the report is marked UNKNOWN (SARIF:
 * executionSuccessful=false) rather than silently presented as a complete assessment —
 * the same refusal buildAssessmentReport() encodes. Pass --coverage-scheduled=N (and,
 * per outstanding probe, --coverage-unresolved=<targetProbeKey>) when the caller has
 * established coverage.
 *
 *   tsx src/pipeline/report-cli.ts --db=... --assessment-run-id=... [--format=json|markdown|sarif]
 *     [--out=path] [--coverage-scheduled=N] [--coverage-unresolved=KEY ...]
 *     [--tool-version=X] [--information-uri=URL]
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function flags(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
}

function requireFlag(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`missing required --${name}=...`);
    process.exit(1);
  }
  return value;
}

type Format = 'json' | 'markdown' | 'sarif';
const VALID_FORMATS: readonly Format[] = ['json', 'markdown', 'sarif'];

function parseEvidenceRefs(raw: unknown): readonly ArtifactRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: ArtifactRef[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as ArtifactRef).ref === 'string' && typeof (item as ArtifactRef).kind === 'string') {
      refs.push({ ref: (item as ArtifactRef).ref, kind: (item as ArtifactRef).kind });
    }
  }
  return refs;
}

function main(): void {
  const dbPath = requireFlag('db');
  const assessmentRunId = requireFlag('assessment-run-id');
  const format = (flag('format') ?? 'json') as Format;
  if (!VALID_FORMATS.includes(format)) {
    console.error(`--format must be one of ${VALID_FORMATS.join('|')}`);
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  const records = new ObservationStore(db).listByAssessmentRun(assessmentRunId);
  const observations: ObservationLike[] = records.map((r) => {
    const evidenceRefs = parseEvidenceRefs(r.evidenceRefs);
    return {
      id: r.id,
      targetId: r.targetId,
      probeId: r.probeId,
      verdict: r.verdict,
      ...(evidenceRefs ? { evidenceRefs } : {}),
    };
  });
  const findings = correlateFindings(observations);

  const scheduledRaw = flag('coverage-scheduled');
  const coverage =
    scheduledRaw === undefined
      ? undefined
      : { scheduled: Number.parseInt(scheduledRaw, 10), unresolved: flags('coverage-unresolved') };
  if (coverage && !Number.isInteger(coverage.scheduled)) {
    console.error('--coverage-scheduled must be an integer');
    process.exit(1);
  }

  const input: ReportInput = {
    assessmentRunId,
    generatedAt: new Date().toISOString(),
    observations,
    findings,
    ...(coverage ? { coverage } : {}),
  };

  let output: string;
  if (format === 'markdown') {
    output = buildMarkdownReport(input);
  } else if (format === 'sarif') {
    const toolVersion = flag('tool-version');
    const informationUri = flag('information-uri');
    output = JSON.stringify(
      buildSarifReport(input, {
        ...(toolVersion ? { toolVersion } : {}),
        ...(informationUri ? { informationUri } : {}),
      }),
      null,
      2,
    );
  } else {
    output = JSON.stringify(buildJsonReport(input), null, 2);
  }

  const outPath = flag('out');
  if (outPath) {
    writeFileSync(outPath, output);
    console.error(`wrote ${format} report for ${assessmentRunId} → ${outPath}`);
  } else {
    process.stdout.write(output + '\n');
  }

  // A non-zero exit when the run cannot honestly be called complete, so a CI step
  // that renders a report also learns the run refused — without having to re-parse it.
  const gate = buildAssessmentReport(input);
  if (!gate.ok) {
    console.error(`coverage: ${gate.reason} — ${gate.detail}`);
    process.exitCode = 2;
  }
}

main();
