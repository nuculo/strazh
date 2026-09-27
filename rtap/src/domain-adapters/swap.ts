/**
 * FROZEN_INTEGRATION.md §8.4: "hot swap at run boundary first; mid-run swap only
 * after state-invariance laws." State-invariance laws for a mid-run swap do not
 * exist in this repo (they'd need to prove swapping a domain adapter mid-
 * AssessmentRun cannot corrupt in-flight CampaignWorld state) — so mid-run swap is
 * unconditionally rejected here, not partially supported. That is the honest
 * current scope, not a workaround.
 */
export type SwapTiming = 'RUN_BOUNDARY' | 'MID_RUN';

export interface AdapterSwapRequest {
  readonly domain: string;
  readonly newAdapterRef: string | null;
  readonly timing: SwapTiming;
}

export interface SwapDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export function evaluateSwapTiming(request: AdapterSwapRequest): SwapDecision {
  if (request.timing === 'MID_RUN') {
    return { allowed: false, reason: 'mid-run adapter swap requires state-invariance laws, not implemented in this repo — only run-boundary swap is supported' };
  }
  return { allowed: true, reason: 'run-boundary swap' };
}
