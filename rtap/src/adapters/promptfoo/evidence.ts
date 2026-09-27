import type { ArtifactStore } from '../../artifacts/store.js';
import { materializeEvidence } from '../../artifacts/materialize.js';
import type { PromptfooEvaluateResult } from './types.js';
import type { ParsedObservation } from './parse.js';

/**
 * The real bytes behind a promptfoo `ParsedObservation`'s evidence: the complete
 * native `EvaluateResult` record for this test case, exactly as promptfoo wrote
 * it. This is the only real evidence available — unlike duo-llm's `AttackCase`,
 * `PromptfooEvaluateResult` (types.ts) carries no separately-addressable
 * prompt/response text in the slice this adapter reads, so `native-report` is not
 * a fallback here, it's everything there is. Replaces `parsePromptfooResult()`'s
 * synthetic `evidenceRefs` entirely — the returned observation's refs now resolve
 * to real content via `store.get()`, not a string nothing backs.
 */
export async function materializePromptfooEvidence(store: ArtifactStore, parsed: ParsedObservation, result: PromptfooEvaluateResult): Promise<ParsedObservation> {
  const refs = await materializeEvidence(store, parsed.assessmentRunId, [{ kind: 'native-report', body: JSON.stringify(result) }]);
  return { ...parsed, evidenceRefs: refs };
}
