import type { ApprovedTarget } from './types.js';

/**
 * Strict allowlist of approved demo targets for the RTAP production MVP.
 * In accordance with safety rules, arbitrary target URLs or custom Promptfoo
 * configurations from web users are rejected.
 */
export const APPROVED_TARGETS: readonly ApprovedTarget[] = [
  {
    id: 'strazh-baseline-simulated',
    name: 'Strazh Support Bot (Simulated Baseline)',
    description: 'Offline deterministic simulation of unmitigated model target (zero API cost, demonstrates canary secret extraction).',
    targetYamlRelative: 'demo/targets/baseline-simulated.yaml',
    mode: 'offline-simulated',
    requiresApiKey: false,
    estimatedCostUsd: '$0.00',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
  {
    id: 'strazh-mitigated-simulated',
    name: 'Strazh Support Bot (Simulated Mitigated)',
    description: 'Offline deterministic simulation of mitigated target with application egress defense scrubber (zero API cost).',
    targetYamlRelative: 'demo/targets/mitigated-simulated.yaml',
    mode: 'offline-simulated',
    requiresApiKey: false,
    estimatedCostUsd: '$0.00',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
  {
    id: 'strazh-target-unavailable',
    name: 'Strazh Support Bot (Target Down Simulation)',
    description: 'Simulation of unreachable target (port 9999) proving honest INCOMPLETE coverage accounting under transport failure.',
    targetYamlRelative: 'demo/targets/unavailable.yaml',
    mode: 'offline-simulated',
    requiresApiKey: false,
    estimatedCostUsd: '$0.00',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
  {
    id: 'strazh-nebius-live-baseline',
    name: 'Strazh Support Bot (Live Nebius Baseline)',
    description: 'Live bounded assessment against Nebius Token Factory serving nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B without egress scrubber.',
    targetYamlRelative: 'demo/targets/baseline-live.yaml',
    mode: 'live-nebius',
    requiresApiKey: true,
    estimatedCostUsd: '< $0.05',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
  {
    id: 'strazh-nebius-live-mitigated',
    name: 'Strazh Support Bot (Live Nebius Mitigated)',
    description: 'Live bounded assessment against Nebius Token Factory serving nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B with defense scrubber.',
    targetYamlRelative: 'demo/targets/mitigated-live.yaml',
    mode: 'live-nebius',
    requiresApiKey: true,
    estimatedCostUsd: '< $0.05',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
  {
    id: 'strazh-nebius-direct',
    name: 'Nebius Token Factory Direct (Live Nemotron)',
    description: 'Direct live bounded assessment against Nebius Token Factory inference endpoint evaluating nvidia/nemotron-3-super-120b-a12b.',
    targetYamlRelative: 'demo/targets/nebius-direct.yaml',
    mode: 'live-nebius',
    requiresApiKey: true,
    estimatedCostUsd: '< $0.05',
    probesCount: 2,
    probeCount: 2,
    budgetAttempts: 4,
    timeoutSeconds: 15,
  },
];

export function getApprovedTarget(id: string): ApprovedTarget | undefined {
  return APPROVED_TARGETS.find((t) => t.id === id);
}
