export * from './types.js';
export { randomBaseline } from './random-baseline.js';
export { fixedOrderBaseline } from './fixed-order-baseline.js';
export { heuristicBaseline } from './heuristic-baseline.js';
export { makeLinearRegressionBaseline, type FittedLinearModel, type LinearRegressionOptions } from './linear-regression-baseline.js';

/**
 * FROZEN_INTEGRATION.md §8.3 also names "tree/boosting baseline" and "optional small
 * MLP", and separately, the actual frozen-kan scalar model. None are implemented in
 * this TypeScript package:
 *   - tree/boosting needs either a real library dependency or a nontrivial
 *     from-scratch implementation — out of scope for this slice, pending;
 *   - the KAN comparison is frozen-kan's own training code (Rust,
 *     frozen/crates/frozen-kan) — a cross-language integration point, not
 *     reimplemented here. See FROZEN_INTEGRATION.md §12 F2's readiness note.
 * `admission-gate.ts` compares only the baselines actually implemented here and
 * says so explicitly in its result — it does not claim a comparison that didn't
 * happen.
 */
export const NOT_IMPLEMENTED_BASELINES = ['tree-boosting', 'small-mlp', 'frozen-kan'] as const;
