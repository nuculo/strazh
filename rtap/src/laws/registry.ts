import { trialSeed } from './rng.js';
import type { Law, LawRunReport, LawTrialFailure, RegistryReport } from './types.js';

export class LawRegistry {
  private readonly laws = new Map<string, Law>();

  register(law: Law): void {
    if (this.laws.has(law.id)) {
      throw new Error(`Duplicate law id: ${law.id}`);
    }
    if (law.status === 'implemented' && !law.check) {
      throw new Error(`Law ${law.id} is marked implemented but has no check()`);
    }
    if (law.status === 'pending' && !law.pendingReason) {
      throw new Error(`Law ${law.id} is marked pending but has no pendingReason`);
    }
    if (law.status === 'implemented' && law.trials < 1) {
      throw new Error(`Law ${law.id} is implemented but declares trials < 1`);
    }
    this.laws.set(law.id, law);
  }

  get(id: string): Law | undefined {
    return this.laws.get(id);
  }

  all(): Law[] {
    return [...this.laws.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async run(id: string, seed = 1): Promise<LawRunReport> {
    const law = this.laws.get(id);
    if (!law) throw new Error(`Unknown law id: ${id}`);

    if (law.status === 'pending' || !law.check) {
      return {
        id: law.id,
        statement: law.statement,
        status: law.status,
        ...(law.pendingReason !== undefined ? { pendingReason: law.pendingReason } : {}),
        trialsRun: 0,
        held: false,
        failures: [],
        seed,
      };
    }

    const failures: LawTrialFailure[] = [];
    for (let trial = 0; trial < law.trials; trial += 1) {
      const trialSeedValue = trialSeed(seed, trial);
      const result = await law.check({ seed: trialSeedValue, trial });
      if (!result.held) {
        failures.push({
          trial,
          seed: trialSeedValue,
          detail: result.detail ?? 'law did not hold, no detail provided',
          counterexample: result.counterexample,
        });
      }
    }

    return {
      id: law.id,
      statement: law.statement,
      status: law.status,
      trialsRun: law.trials,
      held: failures.length === 0,
      failures,
      seed,
    };
  }

  async runAll(seed = 1): Promise<RegistryReport> {
    const results: LawRunReport[] = [];
    for (const law of this.all()) {
      results.push(await this.run(law.id, seed));
    }
    const implemented = results.filter((r) => r.status === 'implemented');
    return {
      total: results.length,
      implemented: implemented.length,
      pending: results.length - implemented.length,
      held: implemented.filter((r) => r.held).length,
      failed: implemented.filter((r) => !r.held).length,
      results,
    };
  }
}
