/**
 * Minimal slice of promptfoo's real output shape that this adapter actually reads.
 * Field names and semantics verified against promptfoo/src/types/index.ts
 * (`EvaluateResult`, `GradingResult`) — not guessed. We deliberately do not import
 * promptfoo's own types package: this ACL boundary should not compile-time couple
 * RTAP to promptfoo's internal type surface, only to the JSON shape it writes.
 */

/** One assertion's contribution to a grading result (promptfoo `GradingResult.componentResults[]`). */
export interface PromptfooComponentResult {
  readonly pass?: boolean;
  readonly assertion?: {
    /**
     * promptfoo assertion type. Deterministic verifiers are string-matchers like
     * `contains`/`not-contains`/`equals`/`regex`/`is-json`; LLM-graded rubric
     * assertions are `llm-rubric`, `model-graded-*`, or a `promptfoo:redteam:*` grader.
     */
    readonly type?: string;
    readonly value?: string | unknown;
  } | null;
}

export interface PromptfooGradingResult {
  /** true = the target resisted the attack; false = the attack succeeded. */
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
  readonly metadata?: {
    readonly pluginId?: string;
    readonly strategyId?: string;
  };
  /** Per-assertion breakdown — used to classify the grader kind (deterministic vs LLM). */
  readonly componentResults?: readonly PromptfooComponentResult[] | null;
}

export interface PromptfooEvaluateResult {
  readonly id?: string;
  readonly testCase: {
    readonly vars?: Record<string, unknown>;
    readonly metadata?: {
      readonly pluginId?: string;
      readonly strategyId?: string;
    };
  };
  readonly provider: { readonly id: string; readonly label?: string };
  readonly error?: string | null;
  readonly success: boolean;
  readonly score: number;
  readonly gradingResult?: PromptfooGradingResult | null;
  readonly response?: {
    readonly output?: unknown;
    readonly finishReason?: string | null;
    readonly tokenUsage?: unknown;
    readonly reasoning_content?: string | null;
    readonly message?: {
      readonly role?: string;
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
    } | null;
  } | null;
  /**
   * promptfoo's `ResultFailureReason` (src/types/index.ts): NONE=0, ASSERT=1,
   * ERROR=2. Critical for telling a *graded* failure (an assertion rejected the
   * output — the attack succeeded) from a *transport/provider* error, because
   * promptfoo puts the assertion message on `result.error` in BOTH cases. Optional:
   * the older hand-verified fixture predates our reading it, and absence is treated
   * conservatively.
   */
  readonly failureReason?: number | null;
}

export interface PromptfooOutputFile {
  readonly evalId?: string;
  readonly results: PromptfooEvaluateResult[];
}
