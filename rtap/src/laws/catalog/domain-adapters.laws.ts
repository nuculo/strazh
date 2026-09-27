import { mulberry32, randInt, randBool } from '../rng.js';
import { evaluateAdapterAdmission, cellKey, type CrossDomainMatrix } from '../../domain-adapters/matrix.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { DomainAdapterRegistry } from '../../domain-adapters/registry.js';
import type { DomainAdapterMetadata } from '../../domain-adapters/metadata.js';
import type { Law } from '../types.js';

function randomMatrix(seed: number): { matrix: CrossDomainMatrix; adapterRef: string; ownDomain: string; otherDomain: string } {
  const rng = mulberry32(seed);
  const adapterRef = 'adp-1';
  const ownDomain = 'financial';
  const otherDomain = 'medical';
  const baselineOwn = 0.5 + rng() * 0.3;
  const baselineOther = 0.5 + rng() * 0.3;
  const ownGain = (rng() - 0.5) * 0.3; // roughly [-0.15, 0.15]
  const otherGain = (rng() - 0.5) * 0.3;
  const includeOffDomainEvidence = randBool(rng, 0.9);

  const adapterScores = new Map<string, number>([[cellKey(adapterRef, ownDomain), baselineOwn + ownGain]]);
  if (includeOffDomainEvidence) {
    adapterScores.set(cellKey(adapterRef, otherDomain), baselineOther + otherGain);
  }

  return {
    matrix: { adapterScores, baselineScores: new Map([[ownDomain, baselineOwn], [otherDomain, baselineOther]]) },
    adapterRef,
    ownDomain,
    otherDomain,
  };
}

// FROZEN_INTEGRATION.md §8.4 — no pre-existing law ID for this in any of the four
// documents this repo tracks; derived from the §8.4 prose itself ("no claim of a
// free adapter is allowed", "reassign_every > 0 ... must be disallowed").
export const domainAdapterLaws: Law[] = [
  {
    id: 'redteam.frozen/domain-adapter-requires-diagonal-gain',
    statement:
      "evaluateAdapterAdmission() admits an adapter iff its own-domain gain clears the threshold, every off-domain gain stays at or below the threshold, and evidence exists for every domain in the matrix — an adapter that helps every domain (a 'free adapter', §8.4) is never admitted even with a strong own-domain gain.",
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const { matrix, adapterRef, ownDomain } = randomMatrix(seed);
      const result = evaluateAdapterAdmission(matrix, adapterRef, ownDomain);

      if (result.freeAdapterClaim && result.admitted) {
        return { held: false, detail: 'A free-adapter claim was admitted', counterexample: { matrix: [...matrix.adapterScores], result } };
      }
      if (Number.isNaN(result.ownDomainGain) && result.admitted) {
        return { held: false, detail: 'Admitted despite missing own-domain evidence', counterexample: result };
      }
      const hasOffDomainCell = matrix.adapterScores.has(cellKey(adapterRef, 'medical'));
      if (!hasOffDomainCell && result.admitted) {
        return { held: false, detail: 'Admitted despite missing off-domain evidence', counterexample: result };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/overlay-adapter-forbids-reassignment',
    statement:
      "DomainAdapterRegistry.swap() rejects any adapter with reassignEvery > 0, regardless of how strong its cross-domain admission evaluation is — 'calibration with reassign_every > 0 changes core identity and must be disallowed for overlay-only adapters' (§8.4) is enforced at the one place that can mutate active-adapter state, not left to caller discipline.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const registry = new DomainAdapterRegistry(openInMemoryDatabase());
      const domain = 'financial';
      const adapterRef = 'adp-1';
      const strongAdmission = evaluateAdapterAdmission(
        { adapterScores: new Map([[cellKey(adapterRef, domain), 0.95]]), baselineScores: new Map([[domain, 0.5]]) },
        adapterRef,
        domain,
      );
      const metadata: DomainAdapterMetadata = { adapterRef, domain, parentCoreRef: 'core-1', reassignEvery: randInt(rng, 1, 10) };

      const result = registry.swap({ domain, newAdapterRef: adapterRef, timing: 'RUN_BOUNDARY' }, strongAdmission, metadata);
      if (result.allowed) {
        return { held: false, detail: 'A reassignEvery > 0 adapter was admitted', counterexample: { metadata, strongAdmission, result } };
      }
      if (registry.getActive(domain) !== null) {
        return { held: false, detail: 'Active adapter changed despite rejected swap', counterexample: registry.getActive(domain) };
      }
      return { held: true };
    },
  },
];
