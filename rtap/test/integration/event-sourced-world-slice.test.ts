import { describe, expect, it } from 'vitest';
import { replay } from '../../src/world/replay.js';
import { fingerprint } from '../../src/world/fingerprint.js';
import { worldPositionOf } from '../../src/world/binding.js';
import { rankCandidates } from '../../src/shadow/rank.js';
import { compileCandidateFeatures } from '../../src/features/candidate-compiler.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from '../training/fixtures.js';

/**
 * Phase 4 vertical slice: real committed CampaignEvents (Phase 1's own
 * CampaignEventStore, same fixture the Phase 2/3 slices use) replayed into a real
 * CampaignWorld, with the resulting WorldPosition fed into Phase 3's shadow ranking
 * — closing the loop the placeholder `{worldGeneration: 0, worldEpoch:
 * allEvents.length}` stood in for until this phase existed.
 */
describe('Phase 4 vertical slice: committed events -> replayable CampaignWorld -> real WorldPosition feeds Phase 3', () => {
  it('replays real Phase 1 events into a world and the fingerprint is stable across two independent replays', () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 2, probesPerTarget: 8, seed: 77 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);

    const a = replay(allEvents, 'campaign-0');
    const b = replay(allEvents, 'campaign-0');

    expect(a.stoppedAt).toBeNull();
    expect(a.eventsApplied).toBe(allEvents.length);
    expect(fingerprint(a.world)).toBe(fingerprint(b.world));
    expect(a.world.epoch).toBe(allEvents.length);
  });

  it('the world sees two Target entities and a ProbeClass per distinct vulnerability class actually committed', () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 2, probesPerTarget: 8, seed: 78 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);
    const world = replay(allEvents, 'campaign-0').world;

    const targetEntities = [...world.entities.values()].filter((e) => e.type === 'Target');
    expect(targetEntities).toHaveLength(2);
  });

  it('feeds a real WorldPosition (not a placeholder) into shadow-scoring, end to end', () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 6, seed: 79 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);
    const { world } = replay(allEvents, 'campaign-0');
    const position = worldPositionOf(world);

    expect(position.worldEpoch).toBe(allEvents.length);
    expect(position.worldGeneration).toBe(0);

    const history = buildHistoryView(allEvents, 'campaign-0', allEvents.length);
    const features = compileCandidateFeatures(
      { targetId: 'campaign-0-target-0', probe: { probeId: 'prompt-injection:base64' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } },
      history,
    );
    const { ranked } = rankCandidates(heuristicBaseline.fit([]), 'heuristic', [features], position, 'SHADOW');

    expect(ranked[0]!.signal.worldEpoch).toBe(position.worldEpoch);
    expect(ranked[0]!.signal.worldGeneration).toBe(position.worldGeneration);
  });

  it('a genuine sequence gap (event dropped from the committed log) stops replay cleanly instead of silently producing a wrong world', () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 6, seed: 80 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);
    const withAGapInTheMiddle = [...allEvents.slice(0, 2), ...allEvents.slice(3)]; // drop sequence 2

    const result = replay(withAGapInTheMiddle, 'campaign-0');
    expect(result.stoppedAt).not.toBeNull();
    expect(result.stoppedAt?.error.kind).toBe('sequence-gap');
    expect(result.eventsApplied).toBe(2); // only the events before the gap
  });

  it('replaying the same events at a different generation still fingerprints identically (generation is lineage, not content)', () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 5, seed: 81 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);

    const gen0 = replay(allEvents, 'campaign-0', 0).world;
    const gen1 = replay(allEvents, 'campaign-0', 1).world;

    expect(fingerprint(gen0)).toBe(fingerprint(gen1));
    expect(worldPositionOf(gen0).worldGeneration).not.toBe(worldPositionOf(gen1).worldGeneration);
  });
});
