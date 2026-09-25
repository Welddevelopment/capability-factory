// src/experimental/openai-delegation-contract-gateway.ts
// The model's ONLY role in this family: draft the delegation contract proposal
// (what is delegated, bounds, input mapping, expected evidence) from the
// counterparty's advertised description plus the diagnosed need.
//
// Pattern copied from src/product/openai-draft-gateway.ts and
// src/experimental/openai-browser-capability-gateway.ts: one structured call via
// zodTextFormat, all-fields-required transport schema, trusted assembly afterwards.
//
// Trusted boundary (all in delegationContractFromModelOutput, below):
//   - key pinning: the enrolled public key is injected by trusted code; the model
//     never sees or supplies key material;
//   - identity/task/verifier/approval cross-checks against the pinned enrollment;
//   - contractHash computed by trusted code with computeAgentDelegateContractHash.

import { createHash } from "node:crypto";
import { z } from "zod";
// INTEGRATION-CHECK: zodTextFormat import verified against
// src/product/openai-draft-gateway.ts line 1 and
// src/experimental/openai-browser-capability-gateway.ts line 1.
import { zodTextFormat } from "openai/helpers/zod";
// INTEGRATION-CHECK: EXPERIMENT_LIMITS verified in src/config.ts line 3
// (model "gpt-5.6-sol"). Relative path assumes src/experimental/.
import { EXPERIMENT_LIMITS } from "../config.js";
// INTEGRATION-CHECK: OpenAIModelGateway.create(params) -> Response and spentUsd()
// verified in src/model-gateway.ts lines 55 and 146.
import type { OpenAIModelGateway } from "../model-gateway.js";
// INTEGRATION-CHECK: exports verified in
// src/experimental/agent-delegation-capability-sdk.ts:
//   agentDelegateContractSchema (line 10), computeAgentDelegateContractHash (156),
//   type AgentDelegateContract (23).
import {
  agentDelegateContractSchema,
  computeAgentDelegateContractHash,
  type AgentDelegateContract,
} from "./agent-delegation-capability-sdk.js";
import type { CourierServiceDescription } from "../customer-world/fictional-courier-delegate-service.js";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);

/**
 * OpenAI structured-output transport: every field required (nullable where a
 * field can be unused), matching the convention documented in
 * src/experimental/model-browser-capability-builder.ts line 37.
 */
export const delegationContractDraftSchema = z.object({
  schemaVersion: z.literal("1.0"),
  delegateId: identifier,
  delegateVersion: identifier,
  taskKey: identifier,
  allowedTaskKeys: z.array(identifier).min(1).max(4),
  approvalKey: identifier,
  preUseVerifierKey: identifier,
  outcomeVerifierKey: identifier,
  timeoutMs: z.number().int().min(100).max(10_000),
  inputMapping: z
    .array(z.object({ taskInputField: identifier, goalValueKey: identifier }).strict())
    .min(1)
    .max(8),
  delegationSummary: z.string().min(1).max(600),
  expectedEvidence: z.string().min(1).max(600),
}).strict();
export type DelegationContractDraft = z.infer<typeof delegationContractDraftSchema>;

export interface DelegationContractDraftInput {
  needKey: string;
  ordinaryGoal: string;
  serviceDescription: CourierServiceDescription;
  /** The tenant's configured keys. The model must echo these, never invent. */
  configured: {
    approvalKey: string;
    preUseVerifierKey: string;
    outcomeVerifierKey: string;
  };
  previousError?: string;
  previousDraft?: unknown;
}

export interface DelegationContractDraftGateway {
  readonly modelLabel: string;
  draft(input: DelegationContractDraftInput): Promise<unknown>;
}

const INSTRUCTIONS = `You draft the smallest bounded delegation contract for handing one task to an approved external digital service.

Rules:
- Use only the supplied service description, need, and configured keys. Do not invent services, tasks, verifiers, approvals, hosts, keys, or credentials.
- Choose exactly the one advertised task that satisfies the need; allowedTaskKeys must be the minimal subset of advertised tasks (normally just that one).
- Echo the configured approvalKey, preUseVerifierKey, and outcomeVerifierKey exactly.
- Map every required task input field to one goal value key in inputMapping; add no unused mappings.
- Set timeoutMs to a conservative bound for one loopback HTTP task.
- delegationSummary states in plain language what is delegated and what is NOT (signing, verification, approval, and retention stay with the caller).
- expectedEvidence states what proof of completion is expected (the signed receipt AND independent observation of the service's stored state).
- Never claim the task succeeded. Trusted code pins the signing key, computes the contract hash, gates approval, verifies signatures, and independently verifies the outcome.
- On a repair attempt, change only what the supplied validation error requires.
- Return only the strict structured draft.`;

export class OpenAIDelegationContractGateway implements DelegationContractDraftGateway {
  readonly modelLabel = EXPERIMENT_LIMITS.model;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async draft(input: DelegationContractDraftInput): Promise<unknown> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      // Bounded description-to-contract translation, not open-ended planning:
      // same rationale as the low-effort setting in openai-draft-gateway.ts.
      reasoning: { effort: "low" },
      instructions: INSTRUCTIONS,
      input: JSON.stringify({
        needKey: input.needKey,
        ordinaryGoal: input.ordinaryGoal,
        serviceDescription: input.serviceDescription,
        configuredKeys: input.configured,
        previousValidationError: input.previousError ?? null,
        previousDraft: input.previousDraft ?? null,
      }),
      max_output_tokens: 4_000,
      store: true,
      text: { format: zodTextFormat(delegationContractDraftSchema, "delegation_contract_draft") },
    });
    if (response.status !== "completed") {
      throw new Error(`Model delegation draft was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return JSON.parse(response.output_text) as unknown;
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}

export interface TrustedDelegationEnrollment {
  /** Enrolled out of band by trusted code; never model-supplied. */
  publicKeyPem: string;
  serviceDescription: CourierServiceDescription;
  approvalKey: string;
  preUseVerifierKey: string;
  outcomeVerifierKey: string;
  /** Trusted clamp: a draft may tighten but never exceed this. */
  maximumTimeoutMs: number;
}

/**
 * Trusted assembly. Fails closed on any drafted identity, task, verifier,
 * approval, or bound that departs from the pinned enrollment, then computes the
 * contract hash itself. The result is a fully pinned AgentDelegateContract the
 * existing SDK enforces without modification.
 */
export function delegationContractFromModelOutput(
  raw: unknown,
  enrollment: TrustedDelegationEnrollment,
): { contract: AgentDelegateContract; draft: DelegationContractDraft } {
  const draft = delegationContractDraftSchema.parse(raw);
  const described = enrollment.serviceDescription;
  if (draft.delegateId !== described.delegateId || draft.delegateVersion !== described.version) {
    throw new Error("The drafted delegate identity does not match the enrolled service.");
  }
  const advertisedTasks = new Set(described.tasks.map((task) => task.taskKey));
  if (!advertisedTasks.has(draft.taskKey)) {
    throw new Error("The drafted task is not advertised by the enrolled service.");
  }
  for (const taskKey of draft.allowedTaskKeys) {
    if (!advertisedTasks.has(taskKey)) {
      throw new Error(`Drafted allowedTaskKeys contains an unadvertised task: ${taskKey}`);
    }
  }
  if (!draft.allowedTaskKeys.includes(draft.taskKey)) {
    throw new Error("The drafted task must be inside its own allowlist.");
  }
  if (draft.approvalKey !== enrollment.approvalKey) {
    throw new Error("The drafted approval key does not match the configured approval.");
  }
  if (draft.preUseVerifierKey !== enrollment.preUseVerifierKey) {
    throw new Error("The drafted pre-use verifier key is not the configured one.");
  }
  if (draft.outcomeVerifierKey !== enrollment.outcomeVerifierKey) {
    throw new Error("The drafted outcome verifier key is not the configured one.");
  }
  if (draft.timeoutMs > enrollment.maximumTimeoutMs) {
    throw new Error("The drafted timeout exceeds the trusted maximum.");
  }
  const advertisedFields = new Set(
    described.tasks.find((task) => task.taskKey === draft.taskKey)!.inputFields.map((field) => field.name),
  );
  const mappedFields = draft.inputMapping.map((entry) => entry.taskInputField);
  if (new Set(mappedFields).size !== mappedFields.length) {
    throw new Error("Drafted inputMapping repeats a task input field.");
  }
  for (const field of advertisedFields) {
    if (!mappedFields.includes(field)) throw new Error(`Drafted inputMapping omits required field: ${field}`);
  }
  for (const field of mappedFields) {
    if (!advertisedFields.has(field)) throw new Error(`Drafted inputMapping invents a field: ${field}`);
  }

  // INTEGRATION-CHECK: contract shape and constraints verified against
  // agentDelegateContractSchema (agent-delegation-capability-sdk.ts lines 10-22):
  // timeoutMs 10..30000, allowedTaskKeys 1..32, publicKeyPem 80..8000 chars.
  const withoutHash: Omit<AgentDelegateContract, "contractHash"> = {
    schemaVersion: "1.0",
    delegateId: draft.delegateId,
    version: draft.delegateVersion,
    publicKeyPem: enrollment.publicKeyPem,
    publicKeySha256: sha256(enrollment.publicKeyPem),
    allowedTaskKeys: [...draft.allowedTaskKeys].sort(),
    approvalKey: draft.approvalKey,
    preUseVerifierKey: draft.preUseVerifierKey,
    outcomeVerifierKey: draft.outcomeVerifierKey,
    timeoutMs: draft.timeoutMs,
  };
  const contract = agentDelegateContractSchema.parse({
    ...withoutHash,
    contractHash: computeAgentDelegateContractHash(withoutHash),
  });
  return { contract, draft };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
