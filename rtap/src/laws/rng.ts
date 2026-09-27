/**
 * Deterministic PRNG for law trials. Not cryptographic — only needs to be a
 * reproducible source of pseudo-randomness so a failing trial can be replayed
 * exactly from (seed, trial).
 */

export type Rng = () => number;

/** mulberry32 — small, fast, good-enough statistical quality for fuzzing inputs. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a per-trial seed from a run seed and a trial index, deterministically. */
export function trialSeed(runSeed: number, trial: number): number {
  // Simple, deterministic mix — not required to be cryptographically strong,
  // only required to avoid seed collisions across trials for realistic trial counts.
  return (Math.imul(runSeed ^ 0x9e3779b9, 2654435761) + trial) >>> 0;
}

export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() called with an empty array');
  const item = items[randInt(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error('pick() indexing invariant violated');
  return item;
}

export function randBool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}
