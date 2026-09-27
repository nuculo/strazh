import { LawRegistry } from './registry.js';
import { domainSafetyLaws } from './catalog/domain-safety.laws.js';
import { plannerLaws } from './catalog/planner.laws.js';
import { frozenLaws } from './catalog/frozen.laws.js';
import { platformLaws } from './catalog/platform.laws.js';
import { featureLaws } from './catalog/features.laws.js';
import { shadowLaws } from './catalog/shadow.laws.js';
import { domainAdapterLaws } from './catalog/domain-adapters.laws.js';
import { productionProfileLaws } from './catalog/production-profile.laws.js';
import { executionSafetyLaws } from './catalog/execution-safety.laws.js';
import { campaignSignalLaws } from './catalog/campaign-signals.laws.js';
import { signingLaws } from './catalog/signing.laws.js';
import { pipelineLaws } from './catalog/pipeline.laws.js';

export { LawRegistry } from './registry.js';
export * from './types.js';

export function buildRegistry(): LawRegistry {
  const registry = new LawRegistry();
  for (const law of [
    ...domainSafetyLaws,
    ...plannerLaws,
    ...frozenLaws,
    ...platformLaws,
    ...featureLaws,
    ...shadowLaws,
    ...domainAdapterLaws,
    ...productionProfileLaws,
    ...executionSafetyLaws,
    ...campaignSignalLaws,
    ...signingLaws,
    ...pipelineLaws,
  ]) {
    registry.register(law);
  }
  return registry;
}
