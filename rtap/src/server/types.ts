import type { AssessResult } from '../cli/assess.js';

export type AssessmentStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ApprovedTarget {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly targetYamlRelative: string;
  readonly mode: 'offline-simulated' | 'live-nebius';
  readonly requiresApiKey: boolean;
  readonly estimatedCostUsd: string;
  readonly probesCount: number;
  readonly probeCount?: number;
  readonly budgetAttempts?: number;
  readonly timeoutSeconds?: number;
}

export interface AssessmentJob {
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly mode: 'offline-simulated' | 'live-nebius';
  status: AssessmentStatus;
  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: AssessResult;
  abortController?: AbortController;
  readonly outDir: string;
}

export interface OperatorUser {
  readonly id: string;
  readonly username: string;
  readonly role: 'OPERATOR' | 'ADMIN';
}
