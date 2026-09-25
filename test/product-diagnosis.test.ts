import { describe, expect, it } from "vitest";
import type { AuthorityEnvelope } from "../src/product/contracts.js";
import { AutonomousCapabilityFactorySdk } from "../src/product/autonomous-sdk.js";
import {
  GoalDiagnostician,
  adjudicateDiagnosis,
  stableCapabilityNeedKey,
  type DiagnosisInput,
  type DiagnosisProposal,
} from "../src/product/diagnosis.js";

const authority: AuthorityEnvelope = {
  allowedTargetAliases: ["customer_erp"],
  allowedSecretAliases: ["erp_api_key"],
  allowedMethods: ["GET", "POST", "PUT"],
  writeAuthority: "preauthorized",
  approvedWriteActions: [],
};

function input(overrides: Partial<DiagnosisInput["state"]> = {}): DiagnosisInput {
  return {
    context: {
      tenantId: "tenant-a",
      requestId: "request-1",
      workflowKey: "ordinary-order-workflow",
      ordinaryGoal: "Make sure the required item is ordered and record the confirmed supplier reference.",
      currentStep: "The agent has inspected current order state and must decide what to do next.",
      visibility: "exceptions-only",
    },
    observations: [
      { id: "order-open", source: "external-state", summary: "The required item has not been ordered." },
      { id: "tools-listed", source: "trusted-runtime", summary: "Configured abilities have been enumerated." },
    ],
    state: {
      goalSatisfied: false,
      missingInformation: [],
      configuredSecretAliases: ["erp_api_key"],
      requiredApprovals: [],
      grantedApprovals: [],
      policyAllowsAction: true,
      availableCapabilities: [],
      candidateSystems: [
        {
          targetAlias: "customer_erp",
          summary: "The customer's configured ERP system.",
          documentationHash: "docs-sha-256",
          secretAliases: ["erp_api_key"],
          operations: [
            { name: "read_order", summary: "Read current order state.", method: "GET" },
            { name: "create_purchase_order", summary: "Create one purchase order.", method: "POST" },
            { name: "update_order", summary: "Record the confirmed supplier reference.", method: "PUT" },
            { name: "create_dispatch", summary: "Create one dispatch record.", method: "POST" },
          ],
        },
      ],
      ...overrides,
    },
    authority: structuredClone(authority),
    runtimeProfile: "case-1",
  };
}

function acquisitionProposal(
  actions = ["read_order", "create_purchase_order", "update_order"],
): DiagnosisProposal {
  return {
    decision: "acquire-capability",
    summary: "The goal requires documented ERP actions that no configured capability exposes.",
    evidenceIds: ["order-open", "tools-listed"],
    selectedCapabilityKey: null,
    contemplatedAction: {
      actionNames: actions,
      targetAliases: ["customer_erp"],
      secretAliases: ["erp_api_key"],
    },
    missingCapability: {
      key: "complete-purchase-order",
      summary: "Create the required purchase order and record its reference.",
      requiredActions: actions,
      targetAliases: ["customer_erp"],
      secretAliases: ["erp_api_key"],
    },
    requestedInputs: [],
    confidence: "high",
  };
}

describe("goal-only diagnosis adjudication", () => {
  it("opens acquisition for a documented procurement residual", () => {
    const result = adjudicateDiagnosis(input(), acquisitionProposal(), () => "2026-07-26T12:00:00.000Z");

    expect(result).toMatchObject({
      decision: "acquire-capability",
      overridden: false,
      request: {
        context: { ordinaryGoal: expect.stringContaining("required item"), blockedAt: "2026-07-26T12:00:00.000Z" },
        need: {
          key: stableCapabilityNeedKey(
            {
              documentationHash: "docs-sha-256",
              workflowKey: "ordinary-order-workflow",
              targetAliases: ["customer_erp"],
              secretAliases: ["erp_api_key"],
              orderedActions: ["read_order", "create_purchase_order", "update_order"],
              operations: [
                { name: "read_order", method: "GET", requiredCompanionActions: [] },
                { name: "create_purchase_order", method: "POST", requiredCompanionActions: [] },
                { name: "update_order", method: "PUT", requiredCompanionActions: [] },
              ],
            },
          ),
          documentationHash: "docs-sha-256",
          requiredActions: ["read_order", "create_purchase_order", "update_order"],
        },
      },
    });
  });

  it("opens acquisition for a materially different documented dispatch residual", () => {
    const proposal = acquisitionProposal(["read_order", "create_dispatch", "update_order"]);
    proposal.missingCapability = {
      ...proposal.missingCapability!,
      key: "prepare-dispatch",
      summary: "Prepare a dispatch and record it on the source order.",
    };
    proposal.contemplatedAction = {
      actionNames: ["read_order", "create_dispatch", "update_order"],
      targetAliases: ["customer_erp"],
      secretAliases: ["erp_api_key"],
    };
    const result = adjudicateDiagnosis(input(), proposal);

    expect(result).toMatchObject({
      decision: "acquire-capability",
      request: { need: { key: expect.stringMatching(/^http-capability-[a-f0-9]{20}$/), requiredActions: ["read_order", "create_dispatch", "update_order"] } },
    });
  });

  it("does not acquire when trusted state says the goal is already complete", () => {
    const result = adjudicateDiagnosis(input({ goalSatisfied: true }), acquisitionProposal());
    expect(result).toMatchObject({ decision: "goal-complete", overridden: true });
    expect("request" in result).toBe(false);
  });

  it("asks for missing business information instead of inventing a capability", () => {
    const result = adjudicateDiagnosis(input({ missingInformation: ["supplier"] }), acquisitionProposal());
    expect(result).toMatchObject({ decision: "request-information", overridden: true });
  });

  it("asks for a credential that has not been configured", () => {
    const result = adjudicateDiagnosis(input({ configuredSecretAliases: [] }), acquisitionProposal());
    expect(result).toMatchObject({ decision: "request-credential", overridden: true });
  });

  it("asks for target or method permission outside the authority envelope", () => {
    const diagnosisInput = input();
    diagnosisInput.authority.allowedMethods = ["GET"];
    const result = adjudicateDiagnosis(diagnosisInput, acquisitionProposal());
    expect(result).toMatchObject({ decision: "request-permission", overridden: true });
  });

  it("asks for required per-action approval", () => {
    const diagnosisInput = input({ requiredApprovals: ["create_purchase_order"] });
    diagnosisInput.authority.writeAuthority = "per-action-approval";
    const result = adjudicateDiagnosis(diagnosisInput, acquisitionProposal());
    expect(result).toMatchObject({ decision: "request-approval", overridden: true });
  });

  it("returns to an available configured capability before acquisition", () => {
    const result = adjudicateDiagnosis(
      input({
        availableCapabilities: [
          {
            key: "configured-erp",
            summary: "Existing ERP capability.",
            actions: ["read_order", "create_purchase_order", "update_order"],
            status: "available",
          },
        ],
      }),
      acquisitionProposal(),
    );
    expect(result).toMatchObject({ decision: "continue-current", overridden: true });
  });

  it("retries a matching ability after a transient failure", () => {
    const result = adjudicateDiagnosis(
      input({
        availableCapabilities: [
          {
            key: "configured-erp",
            summary: "Existing ERP capability.",
            actions: ["read_order", "create_purchase_order", "update_order"],
            status: "transient-failure",
          },
        ],
      }),
      acquisitionProposal(),
    );
    expect(result).toMatchObject({ decision: "retry-current", overridden: true });
  });

  it("stops when customer policy prohibits the action", () => {
    const result = adjudicateDiagnosis(input({ policyAllowsAction: false }), acquisitionProposal());
    expect(result).toMatchObject({ decision: "policy-denied", overridden: true });
  });
});

describe("diagnosis boundary", () => {
  it("can stop for a credential without falsely claiming a capability is missing", () => {
    const proposal = acquisitionProposal();
    proposal.decision = "request-credential";
    proposal.missingCapability = null;
    const result = adjudicateDiagnosis(input({ configuredSecretAliases: [] }), proposal);

    expect(result).toMatchObject({ decision: "request-credential", overridden: false });
    expect("request" in result).toBe(false);
  });

  it("rejects undocumented actions and invented evidence", () => {
    const proposal = acquisitionProposal(["delete_everything"]);
    proposal.evidenceIds.push("invented-observation");
    const result = adjudicateDiagnosis(input(), proposal);

    expect(result).toMatchObject({ decision: "insufficient-evidence" });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "evidence-references", passed: false }),
        expect.objectContaining({ id: "documented-minimum-actions", passed: false }),
      ]),
    );
  });

  it("rejects a write plan that omits a trusted reconciliation dependency", () => {
    const diagnosisInput = input();
    diagnosisInput.state.candidateSystems[0]!.operations.find(
      (operation) => operation.name === "create_purchase_order",
    )!.requiredCompanionActions = ["read_order"];
    const proposal = acquisitionProposal(["create_purchase_order", "update_order"]);
    const result = adjudicateDiagnosis(diagnosisInput, proposal);

    expect(result).toMatchObject({ decision: "insufficient-evidence" });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "required-companion-actions", passed: false }),
    );
  });

  it("passes a cloned goal-only input through the gateway and adjudicates its proposal", async () => {
    let received: DiagnosisInput | undefined;
    const diagnostician = new GoalDiagnostician(
      {
        async diagnose(value) {
          received = value;
          value.context.ordinaryGoal = "mutated inside gateway";
          return acquisitionProposal();
        },
      },
      () => "2026-07-26T12:00:00.000Z",
    );
    const original = input();
    const result = await diagnostician.diagnose(original);

    expect(received?.context).not.toHaveProperty("blockedReason");
    expect(original.context.ordinaryGoal).toContain("required item");
    expect(result.decision).toBe("acquire-capability");
  });
});

describe("autonomous goal orchestration", () => {
  it("enters the existing capability loop only after an adjudicated acquisition decision", async () => {
    const diagnostician = new GoalDiagnostician({ async diagnose() { return acquisitionProposal(); } });
    let completedRequest: unknown;
    const sdk = new AutonomousCapabilityFactorySdk(diagnostician, {
      async completeBlockedGoal(request) {
        completedRequest = request;
        return {
          status: "completed",
          requestId: request.context.requestId,
          capabilitySource: "built",
          capabilityId: "complete-purchase-order",
          actions: [],
          outcome: {
            verifierVersion: "test",
            passed: true,
            intendedWrites: 1,
            incorrectSideEffects: 0,
            stateDigest: "state",
            checks: [],
            verifiedAt: "2026-07-26T12:00:00.000Z",
          },
          resume: { completed: true, summary: "The ordinary goal resumed and completed." },
        };
      },
    });

    const result = await sdk.completeGoal(input(), () => ({
      async execute() { return []; },
      async verifyOutcome() { throw new Error("mock completer owns execution"); },
      async resume() { throw new Error("mock completer owns resumption"); },
    }));

    expect(completedRequest).toMatchObject({ need: { key: expect.stringMatching(/^http-capability-[a-f0-9]{20}$/) } });
    expect(result).toMatchObject({ status: "completed", completionSource: "capability-loop" });
  });

  it("never invokes acquisition when a deterministic gate overrides the model", async () => {
    const diagnostician = new GoalDiagnostician({ async diagnose() { return acquisitionProposal(); } });
    let acquisitionCalls = 0;
    const sdk = new AutonomousCapabilityFactorySdk(diagnostician, {
      async completeBlockedGoal() {
        acquisitionCalls += 1;
        throw new Error("must not be called");
      },
    });

    const result = await sdk.completeGoal(input({ missingInformation: ["supplier"] }), () => {
      throw new Error("workflow must not be created");
    });

    expect(acquisitionCalls).toBe(0);
    expect(result).toMatchObject({ status: "handoff", diagnosis: { decision: "request-information" } });
  });

  it("gives equivalent ordered plans one stable registry key regardless of model naming", () => {
    const first = acquisitionProposal(["read_order", "create_purchase_order", "update_order"]);
    const second = acquisitionProposal(["read_order", "create_purchase_order", "update_order"]);
    second.missingCapability!.key = "a-completely-different-model-name";

    const left = adjudicateDiagnosis(input(), first);
    const right = adjudicateDiagnosis(input(), second);
    expect(left.decision).toBe("acquire-capability");
    expect(right.decision).toBe("acquire-capability");
    if (left.decision === "acquire-capability" && right.decision === "acquire-capability") {
      expect(left.request.need.key).toBe(right.request.need.key);
    }
  });

  it("uses different registry keys when action order may encode different workflow semantics", () => {
    const ordered = adjudicateDiagnosis(
      input(),
      acquisitionProposal(["read_order", "create_purchase_order", "update_order"]),
    );
    const reordered = adjudicateDiagnosis(
      input(),
      acquisitionProposal(["read_order", "update_order", "create_purchase_order"]),
    );

    expect(ordered.decision).toBe("acquire-capability");
    expect(reordered.decision).toBe("acquire-capability");
    if (ordered.decision === "acquire-capability" && reordered.decision === "acquire-capability") {
      expect(ordered.request.need.key).not.toBe(reordered.request.need.key);
    }
  });

  it("uses different registry keys for the same actions in different trusted workflows", () => {
    const firstInput = input();
    const secondInput = input();
    secondInput.context.workflowKey = "different-trusted-workflow";
    const first = adjudicateDiagnosis(firstInput, acquisitionProposal());
    const second = adjudicateDiagnosis(secondInput, acquisitionProposal());

    expect(first.decision).toBe("acquire-capability");
    expect(second.decision).toBe("acquire-capability");
    if (first.decision === "acquire-capability" && second.decision === "acquire-capability") {
      expect(first.request.need.key).not.toBe(second.request.need.key);
    }
  });
});
