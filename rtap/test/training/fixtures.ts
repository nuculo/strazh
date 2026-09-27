import { openInMemoryDatabase } from '../../src/db/connection.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { mulberry32, randBool, pick } from '../../src/laws/rng.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import type { HistoricalRecord } from '../../src/training/dataset-exporter.js';
import type { ObservationForFeatures } from '../../src/features/observation-compiler.js';

const VULN_CLASSES = ['prompt-injection', 'harmful-cybercrime', 'pii-leak', 'jailbreak'];
const STRATEGIES = ['base64', 'default', 'multi-turn'];

/**
 * Builds a small, deterministic, schema-real synthetic corpus: real
 * CampaignEventStore, real schema-validated events, several campaigns/targets/probes
 * with a mixed outcome distribution. Not promptfoo data — this repo has no live
 * historical corpus yet (Phase 1's own runs are the first real data it will ever
 * produce); this fixture exists to prove the Phase 2 pipeline against *something*
 * shaped like what Phase 1 actually commits.
 */
export function buildSyntheticCorpus(opts: { campaigns?: number; targetsPerCampaign?: number; probesPerTarget?: number; seed?: number } = {}) {
  const campaignsCount = opts.campaigns ?? 3;
  const targetsPerCampaign = opts.targetsPerCampaign ?? 2;
  const probesPerTarget = opts.probesPerTarget ?? 8;
  const rng = mulberry32(opts.seed ?? 1);

  const db = openInMemoryDatabase();
  const events = new CampaignEventStore(db);
  const records: HistoricalRecord[] = [];

  let day = 0;
  for (let c = 0; c < campaignsCount; c += 1) {
    const campaignId = `campaign-${c}`;
    for (let t = 0; t < targetsPerCampaign; t += 1) {
      const targetId = `campaign-${c}-target-${t}`;
      for (let p = 0; p < probesPerTarget; p += 1) {
        const vulnClass = pick(rng, VULN_CLASSES);
        const strategy = pick(rng, STRATEGIES);
        const probeId = `${vulnClass}:${strategy}`;
        day += 1;
        const occurredAt = new Date(Date.UTC(2026, 0, 1 + day)).toISOString();

        // A mildly learnable pattern: prompt-injection with base64 tends to succeed
        // more often than other combinations — gives the linear baseline something
        // real to find, without hand-tuning the test to a specific weight vector.
        const succeedProbability = vulnClass === 'prompt-injection' && strategy === 'base64' ? 0.75 : 0.2;
        const verdict = randBool(rng, succeedProbability) ? 'VULNERABLE' : randBool(rng, 0.7) ? 'RESISTANT' : 'UNVERIFIED';

        const observation: ObservationForFeatures & { id: string } = {
          id: `obs-${campaignId}-${targetId}-${p}`,
          targetId,
          probeId,
          verdict,
          provenance: { engineId: 'promptfoo', graderKind: verdict === 'UNVERIFIED' ? 'none' : 'llm-judge', configIgnored: false },
        };

        const { event } = events.append(
          eventForObservation(observation, { campaignId, assessmentRunId: `${campaignId}-run-1`, occurredAt }),
        );
        records.push({ observation, event });
      }
    }
  }

  return { db, eventStore: events, records, allEvents: events.listByCampaign.bind(events) };
}

export function allEventsAcrossCampaigns(eventStore: CampaignEventStore, campaignIds: readonly string[]) {
  return campaignIds.flatMap((id) => eventStore.listByCampaign(id));
}
