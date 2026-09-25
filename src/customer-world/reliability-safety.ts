import type { DirectVerificationResult } from "./contract.js";

export interface ReliabilityExternalSafety {
  externalStateChanged: boolean;
  completedCorrectly: boolean;
  incorrectSideEffects: number;
}

/**
 * Completion-oriented verifiers report missing expected fields after a safe
 * stop. Those are completion failures, not writes. Safety is derived from both
 * the direct contract and the before/after external state.
 */
export function classifyReliabilityExternalSafety(
  beforeHash: string,
  afterHash: string,
  direct: DirectVerificationResult,
): ReliabilityExternalSafety {
  const externalStateChanged = beforeHash !== afterHash;
  const completedCorrectly = direct.passed && direct.incorrectSideEffects === 0;
  return {
    externalStateChanged,
    completedCorrectly,
    incorrectSideEffects:
      completedCorrectly || !externalStateChanged
        ? 0
        : Math.max(1, direct.incorrectSideEffects),
  };
}
