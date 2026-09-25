import path from "node:path";

export const EXPERIMENT_LIMITS = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high" as const,
  maxTurns: 20,
  maxRepairs: 3,
  runTimeoutMs: 10 * 60 * 1_000,
  maxRunCostUsd: 3,
  warnCostUsd: 35,
  maxTotalCostUsd: 50,
  maxOutputTokens: 8_000,
});

export const EDGE_CAMPAIGN_MAX_USD = 2;

export const DEVELOPMENT_GOAL =
  "A temperature-sensitive shipment arrives on Friday. Check whether its receiving warehouse already has compatible storage equipment. If not, order one compatible unit for delivery by the shipment's arrival.";

export function artifactsRoot(): string {
  return path.resolve(process.env.CF_ARTIFACTS_DIR ?? "artifacts");
}

export function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not configured. Offline work is complete up to the funding gate; no paid model call was made.",
    );
  }
  return key;
}
