export enum AutonomyMode {
  AUTO = 'AUTO',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  MANUAL = 'MANUAL',
}

export function loadAutonomyMode(): AutonomyMode {
  const raw = (process.env.AUTONOMY_MODE ?? 'AUTO').toUpperCase();
  if (raw === AutonomyMode.REVIEW_REQUIRED || raw === AutonomyMode.MANUAL) return raw as AutonomyMode;
  return AutonomyMode.AUTO;
}

import { ApprovalGate } from '../tasks/Task';

/**
 * Points in the lifecycle where a human may need to step in.
 * AUTO: never pauses on its own (still stops on max-attempts).
 * REVIEW_REQUIRED: pauses before merging to the base branch.
 * MANUAL: pauses before every implementation and every merge.
 */
export function requiresHumanApproval(mode: AutonomyMode, gate: ApprovalGate): boolean {
  if (mode === AutonomyMode.MANUAL) return true;
  if (mode === AutonomyMode.REVIEW_REQUIRED) return gate === 'before_merge';
  return false;
}
