/** Small, deterministic, pure encoders shared by both feature compilers. */

const ENGINE_TRUST: Record<string, number> = {
  promptfoo: 1,
  'duo-static': 0.7,
  'duo-llm': 0.3,
};

export function engineTrust(engineId: string): number {
  return ENGINE_TRUST[engineId] ?? 0;
}

export function graderKindStrength(graderKind: string): number {
  if (graderKind === 'llm-judge') return 1;
  if (graderKind === 'deterministic-verifier') return 1;
  if (graderKind === 'defaulted-pass') return 0;
  return 0; // 'none'
}

export function verdictScore(verdict: string): number | null {
  if (verdict === 'VULNERABLE') return 1;
  if (verdict === 'RESISTANT') return 0;
  if (verdict === 'UNVERIFIED') return 0.5;
  return null; // ERROR: not a graded outcome at all
}

/** Deterministic string -> [0, 1] bucket. Not cryptographic, only needs to be stable. */
export function hashBucket(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Saturating count normalization: 0 attempts -> 0, `cap` or more -> 1. */
export function normalizeCount(count: number, cap: number): number {
  return clamp01(count / cap);
}
