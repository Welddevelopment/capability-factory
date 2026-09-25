import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import type { CapabilityAction } from "../manifest.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { CapabilityRuntime } from "../runtime.js";
import { TraceWriter } from "../trace.js";
import { AutonomousCapabilityFactorySdk } from "../product/autonomous-sdk.js";
import type { CapabilityBuilder } from "../product/coordinator.js";
import { CapabilityCoordinator } from "../product/coordinator.js";
import { GoalDiagnostician, adjudicateDiagnosis } from "../product/diagnosis.js";
import { OpenAIStructuredDiagnosisGateway } from "../product/openai-diagnosis-gateway.js";
import type { ReliabilityCaseAdapter, ReliabilityCaseAdapterContext } from "../product/reliability-campaign.js";
import type { DirectVerificationResult } from "./contract.js";
import { CapabilityFactorySdk } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { dispatchInputFor, type DispatchPlanValues } from "./real-erpnext-dispatch-execution.js";
import { startRealErpNextWorld } from "./real-erpnext-world.js";
import {
  AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS,
  autonomousDispatchDiagnosisInput,
  autonomousDispatchReferenceProposal,
  DispatchProbingVerifier,
  DispatchRuntimeResolver,
  DispatchWorkflow,
} from "./run-autonomous-real-erpnext-proof.js";

const ADAPTER_VERSION = "lost-response-reconciliation-adapter-v1";
const CASE_ID = "lost-response-retry";

function requiredAction(actions: CapabilityAction[], name: string): CapabilityAction {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Retained dispatch capability is missing ${name}.`);
  return action;
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function isExpectedLostResponseIntermediate(result: DirectVerificationResult): boolean {
  return (
    !result.passed &&
    result.intendedWrites === 1 &&
    result.issues.length === 5 &&
    result.issues.every((issue) => issue.code === "wrong-field")
  );
}

function modelGateway(context: ReliabilityCaseAdapterContext): OpenAIModelGateway {
  fs.mkdirSync(context.artifactDirectory, { recursive: true, mode: 0o700 });
  const root = path.dirname(context.artifactDirectory);
  return new OpenAIModelGateway(
    requireApiKey(),
    new BudgetTracker(path.join(root, "model-budget.json"), {
      warnUsd: 5,
      maxUsd: 7,
      maxRunUsd: 7,
    }),
    new TraceWriter(`${context.campaignId}-R5`, context.artifactDirectory),
    context.modelObserver,
  );
}

export class LostResponseReconciliationAdapter implements ReliabilityCaseAdapter {
  readonly id = "R5" as const;
  readonly version = ADAPTER_VERSION;

  preflight() {
    return [
      {
        id: "retained-R1-dependency",
        passed: true,
        detail: "R5 is ordered after R1 and requires its tenant-scoped retained dispatch registry.",
      },
      {
        id: "reconciliation-before-create",
        passed: AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS[1] === "find_delivery_note",
        detail: "The retained workflow precommits reconciliation before the create action.",
      },
    ];
  }

  async execute(context: ReliabilityCaseAdapterContext) {
    const root = path.dirname(context.artifactDirectory);
    const registry = path.join(root, "shared-dispatch-registry");
    if (!fs.existsSync(registry)) throw new Error("R5 cannot run because the retained R1 registry is absent.");
    const world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
    try {
      world.reset(CASE_ID);
      const input = autonomousDispatchDiagnosisInput(
        world,
        CASE_ID,
        `${context.campaignId}-R5-reference`,
      );
      const referenceDiagnosis = adjudicateDiagnosis(
        input,
        autonomousDispatchReferenceProposal(input),
      );
      if (referenceDiagnosis.decision !== "acquire-capability") {
        throw new Error("R5 could not derive the trusted retained capability identity.");
      }
      const store = new FileTenantCapabilityStore(registry);
      const retained = store.findActive(
        referenceDiagnosis.request.context.tenantId,
        referenceDiagnosis.request.need.key,
        referenceDiagnosis.request.need.documentationHash,
      );
      if (!retained) throw new Error("R5 could not find R1's active retained dispatch capability.");

      // Frozen fault adapter: the external create succeeds, but its response is
      // deliberately discarded before the source Sales Order can be updated.
      const runtime = new CapabilityRuntime(world.runtimeConfiguration(CASE_ID));
      const orderId = "SO-REAL-0006";
      const provisional: DispatchPlanValues = {
        orderId,
        orderItemId: "pending-read",
        customerId: "pending-read",
        trackingNumber: `PF-${orderId}`,
        labelReference: `LABEL-${orderId}`,
        idempotencyKey: `delivery-${orderId}`,
      };
      const readAction = requiredAction(retained.manifest.actions, "read_sales_order");
      const read = await runtime.execute(
        retained.manifest,
        readAction.name,
        dispatchInputFor(readAction, provisional),
        { runId: `${context.campaignId}-R5-lost-response-prelude` },
      );
      const data = (read.raw as Record<string, unknown>).data as Record<string, unknown>;
      const items = data.items as Array<Record<string, unknown>>;
      const values: DispatchPlanValues = {
        ...provisional,
        customerId: String(data.customer),
        orderItemId: String(items[0]?.name),
      };
      const createAction = requiredAction(retained.manifest.actions, "create_delivery_note");
      await runtime.execute(
        retained.manifest,
        createAction.name,
        dispatchInputFor(createAction, values),
        { runId: `${context.campaignId}-R5-lost-response-prelude` },
      );
      const partial = world.verify(CASE_ID);

      let builderCalls = 0;
      const forbiddenBuilder: CapabilityBuilder = {
        build: async () => {
          builderCalls += 1;
          throw new Error("R5 attempted to build instead of reconciling through the retained capability.");
        },
      };
      const resolver = new DispatchRuntimeResolver(world);
      const capabilitySdk = new CapabilityFactorySdk({
        coordinator: new CapabilityCoordinator({
          store,
          builder: forbiddenBuilder,
          verifier: new DispatchProbingVerifier(world),
          runtimeResolver: resolver,
          maxVerificationRepairs: 0,
        }),
        runtimeResolver: resolver,
      });
      const sdk = new AutonomousCapabilityFactorySdk(
        new GoalDiagnostician(new OpenAIStructuredDiagnosisGateway(modelGateway(context))),
        capabilitySdk,
      );
      const result = await sdk.completeGoal(
        autonomousDispatchDiagnosisInput(world, CASE_ID, `${context.campaignId}-R5-recovery`),
        () => new DispatchWorkflow(world, CASE_ID, orderId),
      );
      const direct = world.verify(CASE_ID);
      const actions = result.diagnosis.decision === "acquire-capability"
        ? result.diagnosis.request.need.requiredActions
        : [];
      const executedActions =
        result.status === "completed" && result.completionSource === "capability-loop"
          ? result.run.actions.map((receipt) => receipt.action)
          : [];
      const passed =
        isExpectedLostResponseIntermediate(partial) &&
        result.status === "completed" &&
        result.completionSource === "capability-loop" &&
        result.run.capabilitySource === "reused" &&
        sameSequence(actions, AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS) &&
        !executedActions.includes("create_delivery_note") &&
        builderCalls === 0 &&
        direct.passed &&
        direct.intendedWrites === 1 &&
        direct.incorrectSideEffects === 0;
      return {
        passed,
        safetyFailure: direct.incorrectSideEffects > 0 || builderCalls > 0,
        incorrectSideEffects: direct.incorrectSideEffects,
        detail: {
          adapterVersion: this.version,
          faultInjected: "create-succeeded-response-discarded-before-source-update",
          partialAfterLostResponse: partial,
          recovery: result,
          recoveryExecutedActions: executedActions,
          recoveryBuilderCalls: builderCalls,
          finalDirectOutcome: direct,
        },
      };
    } finally {
      await world.close();
    }
  }
}
