/**
 * FROZEN_INTEGRATION.md §8.4: "An adapter is admitted only if a cross-domain matrix
 * shows real specialization":
 *
 *                      financial eval   medical eval
 * financial adapter          ↑               ↓/=
 * medical adapter             ↓/=             ↑
 *
 * "Report core bytes, adapter bytes, quality gain and cross-domain degradation
 * together. No claim of a 'free adapter' is allowed."
 */
export interface CrossDomainMatrix {
  /** key: `${adapterRef}::${domain}` -> benchmark score on that domain's eval set. */
  readonly adapterScores: ReadonlyMap<string, number>;
  /** key: domain -> general-core (no adapter) score on that domain's eval set. */
  readonly baselineScores: ReadonlyMap<string, number>;
}

export function cellKey(adapterRef: string, domain: string): string {
  return `${adapterRef}::${domain}`;
}

export interface DomainGain {
  readonly domain: string;
  readonly gain: number;
}

export interface AdmissionEvaluation {
  readonly adapterRef: string;
  readonly ownDomain: string;
  readonly ownDomainGain: number;
  readonly offDomainGains: readonly DomainGain[];
  /** True iff gain is positive on *every* domain, own and off — a "free adapter" (generically better, not specialized). §8.4 forbids admitting this as a domain adapter. */
  readonly freeAdapterClaim: boolean;
  readonly admitted: boolean;
  readonly reasonCodes: string[];
}

export interface AdmissionOptions {
  readonly minOwnDomainGain: number;
  /** Off-domain gain above this is treated as "not a real specialization trade-off". */
  readonly maxOffDomainGain: number;
}

export const DEFAULT_ADMISSION_OPTIONS: AdmissionOptions = {
  minOwnDomainGain: 0.02,
  maxOffDomainGain: 0.0,
};

/**
 * Evaluates one adapter against its declared own-domain, using every other domain
 * present in the matrix as the off-diagonal check. Total: missing cells are treated
 * as "no evidence", which fails admission rather than being silently skipped —
 * an adapter cannot be admitted on a matrix with holes in it.
 */
export function evaluateAdapterAdmission(
  matrix: CrossDomainMatrix,
  adapterRef: string,
  ownDomain: string,
  options: AdmissionOptions = DEFAULT_ADMISSION_OPTIONS,
): AdmissionEvaluation {
  const reasonCodes: string[] = [];
  const domains = new Set(matrix.baselineScores.keys());
  domains.add(ownDomain);

  const gainFor = (domain: string): number | null => {
    const score = matrix.adapterScores.get(cellKey(adapterRef, domain));
    const baseline = matrix.baselineScores.get(domain);
    if (score === undefined || baseline === undefined) return null;
    return score - baseline;
  };

  const ownGain = gainFor(ownDomain);
  if (ownGain === null) {
    return {
      adapterRef,
      ownDomain,
      ownDomainGain: NaN,
      offDomainGains: [],
      freeAdapterClaim: false,
      admitted: false,
      reasonCodes: [`missing-evidence:${cellKey(adapterRef, ownDomain)}-or-baseline`],
    };
  }

  const offDomainGains: DomainGain[] = [];
  let missingOffDomainEvidence = false;
  for (const domain of domains) {
    if (domain === ownDomain) continue;
    const gain = gainFor(domain);
    if (gain === null) {
      missingOffDomainEvidence = true;
      reasonCodes.push(`missing-evidence:${cellKey(adapterRef, domain)}-or-baseline`);
      continue;
    }
    offDomainGains.push({ domain, gain });
  }

  const freeAdapterClaim = ownGain > options.minOwnDomainGain && offDomainGains.length > 0 && offDomainGains.every((g) => g.gain > options.maxOffDomainGain);
  if (freeAdapterClaim) {
    reasonCodes.push('free-adapter-claim: positive gain on every domain, not a genuine specialization trade-off');
  }

  const ownDomainPasses = ownGain > options.minOwnDomainGain;
  if (!ownDomainPasses) reasonCodes.push(`own-domain-gain-insufficient: ${ownGain} <= ${options.minOwnDomainGain}`);

  const offDomainPasses = offDomainGains.every((g) => g.gain <= options.maxOffDomainGain);
  if (!offDomainPasses) {
    for (const g of offDomainGains.filter((x) => x.gain > options.maxOffDomainGain)) {
      reasonCodes.push(`off-domain-gain-too-high:${g.domain}=${g.gain}`);
    }
  }

  const admitted = ownDomainPasses && offDomainPasses && !freeAdapterClaim && !missingOffDomainEvidence;

  return { adapterRef, ownDomain, ownDomainGain: ownGain, offDomainGains, freeAdapterClaim, admitted, reasonCodes };
}
