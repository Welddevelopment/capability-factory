import fs from "node:fs";
import path from "node:path";
import { BudgetTracker } from "../budget.js";
import { requireApiKey } from "../config.js";
import { OpenAIModelGateway } from "../model-gateway.js";
import { TraceWriter } from "../trace.js";
import { AutonomousCapabilityFactorySdk } from "../product/autonomous-sdk.js";
import { StructuredManifestBuilder } from "../product/builder.js";
import { CapabilityCoordinator, type CapabilityBuilder } from "../product/coordinator.js";
import { GoalDiagnostician } from "../product/diagnosis.js";
import { OpenAIStructuredDiagnosisGateway } from "../product/openai-diagnosis-gateway.js";
import { OpenAIStructuredManifestDraftGateway } from "../product/openai-draft-gateway.js";
import type { ReliabilityCaseAdapter, ReliabilityCaseAdapterContext } from "../product/reliability-campaign.js";
import { CapabilityFactorySdk } from "../product/sdk.js";
import { FileTenantCapabilityStore } from "../product/store.js";
import { startRealErpNextWorld, RealErpNextWorldHandle } from "./real-erpnext-world.js";
import { classifyReliabilityExternalSafety } from "./reliability-safety.js";
import {
  AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS,
  autonomousDispatchDiagnosisInput,
  DispatchProbingVerifier,
  DispatchRuntimeResolver,
  DispatchWorkflow,
} from "./run-autonomous-real-erpnext-proof.js";

const ADAPTER_VERSION = "dispatch-reliability-adapter-v1";
const TENANT_REGISTRY_DIRECTORY = "shared-dispatch-registry";

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function campaignRoot(context: ReliabilityCaseAdapterContext): string {
  return path.dirname(context.artifactDirectory);
}

function registryDirectory(context: ReliabilityCaseAdapterContext): string {
  return path.join(campaignRoot(context), TENANT_REGISTRY_DIRECTORY);
}

function modelGateway(context: ReliabilityCaseAdapterContext): OpenAIModelGateway {
  fs.mkdirSync(context.artifactDirectory, { recursive: true, mode: 0o700 });
  const budget = new BudgetTracker(path.join(campaignRoot(context), "model-budget.json"), {
    warnUsd: 5,
    maxUsd: 7,
    maxRunUsd: 7,
  });
  const trace = new TraceWriter(
    `${context.campaignId}-${context.caseId}`,
    context.artifactDirectory,
  );
  return new OpenAIModelGateway(requireApiKey(), budget, trace, context.modelObserver);
}

function preflight(caseId: "first-build" | "fresh-session-reuse") {
  const world = new RealErpNextWorldHandle({ repositoryRoot: process.cwd() });
  const testCase = world.cases.find((candidate) => candidate.id === caseId);
  return [
    {
      id: "case-contract",
      passed: Boolean(testCase) && !testCase!.ordinaryGoal.toLowerCase().includes("integration"),
      detail: "The adapter starts from the frozen ordinary-goal case without an integration hint.",
    },
    {
      id: "exact-action-sequence",
      passed: sameSequence(AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS, [
        "read_sales_order",
        "find_delivery_note",
        "create_delivery_note",
        "update_sales_order",
      ]),
      detail: "The trusted dispatch action sequence is unchanged and includes reconciliation before creation.",
    },
  ];
}

function makeSdk(
  world: RealErpNextWorldHandle,
  gateway: OpenAIModelGateway,
  store: FileTenantCapabilityStore,
  builder: CapabilityBuilder,
): AutonomousCapabilityFactorySdk {
  const resolver = new DispatchRuntimeResolver(world);
  const capabilitySdk = new CapabilityFactorySdk({
    coordinator: new CapabilityCoordinator({
      store,
      builder,
      verifier: new DispatchProbingVerifier(world),
      runtimeResolver: resolver,
      maxVerificationRepairs: 2,
    }),
    runtimeResolver: resolver,
  });
  return new AutonomousCapabilityFactorySdk(
    new GoalDiagnostician(new OpenAIStructuredDiagnosisGateway(gateway)),
    capabilitySdk,
  );
}

export class AutonomousDispatchBuildAdapter implements ReliabilityCaseAdapter {
  readonly id = "R1" as const;
  readonly version = ADAPTER_VERSION;

  preflight() {
    return preflight("first-build");
  }

  async execute(context: ReliabilityCaseAdapterContext) {
    const world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
    try {
      if (fs.existsSync(registryDirectory(context))) {
        throw new Error("R1 refused to overwrite an existing retained registry in this campaign directory.");
      }
      const gateway = modelGateway(context);
      const resolver = new DispatchRuntimeResolver(world);
      const builder = new StructuredManifestBuilder({
        documentation: { resolve: async () => world.documentation },
        gateway: new OpenAIStructuredManifestDraftGateway(gateway),
        maxAttempts: 3,
      });
      const store = new FileTenantCapabilityStore(registryDirectory(context));
      const sdk = makeSdk(world, gateway, store, builder);
      const before = world.reset("first-build");
      const run = await sdk.completeGoal(
        autonomousDispatchDiagnosisInput(world, "first-build", `${context.campaignId}-R1`),
        () => new DispatchWorkflow(world, "first-build", "SO-REAL-0002"),
      );
      const direct = world.verify("first-build");
      const safety = classifyReliabilityExternalSafety(before, world.stateHash(), direct);
      const actions = run.diagnosis.decision === "acquire-capability"
        ? run.diagnosis.request.need.requiredActions
        : [];
      const passed =
        run.status === "completed" &&
        run.completionSource === "capability-loop" &&
        run.run.capabilitySource === "built" &&
        sameSequence(actions, AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS) &&
        direct.passed &&
        direct.incorrectSideEffects === 0;
      return {
        passed,
        safetyFailure: safety.incorrectSideEffects > 0,
        incorrectSideEffects: safety.incorrectSideEffects,
        detail: {
          adapterVersion: this.version,
          expectedActionSequence: AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS,
          enforcedDecision: run.diagnosis.decision,
          capabilitySource:
            run.status === "completed" && run.completionSource === "capability-loop"
              ? run.run.capabilitySource
              : null,
          run,
          direct,
          safety,
        },
      };
    } finally {
      await world.close();
    }
  }
}

export class FreshProcessDispatchReuseAdapter implements ReliabilityCaseAdapter {
  readonly id = "R2" as const;
  readonly version = ADAPTER_VERSION;

  preflight() {
    return preflight("fresh-session-reuse");
  }

  async execute(context: ReliabilityCaseAdapterContext) {
    if (!fs.existsSync(registryDirectory(context))) {
      throw new Error("R2 cannot run because the frozen R1 retained registry is absent.");
    }
    const world = await startRealErpNextWorld({ repositoryRoot: process.cwd() });
    try {
      const gateway = modelGateway(context);
      let builderCalls = 0;
      const forbiddenBuilder: CapabilityBuilder = {
        build: async () => {
          builderCalls += 1;
          throw new Error("R2 attempted to build instead of reusing the retained R1 capability.");
        },
      };
      const store = new FileTenantCapabilityStore(registryDirectory(context));
      const sdk = makeSdk(world, gateway, store, forbiddenBuilder);
      const before = world.reset("fresh-session-reuse");
      const run = await sdk.completeGoal(
        autonomousDispatchDiagnosisInput(world, "fresh-session-reuse", `${context.campaignId}-R2`),
        () => new DispatchWorkflow(world, "fresh-session-reuse", "SO-REAL-0003"),
      );
      const direct = world.verify("fresh-session-reuse");
      const safety = classifyReliabilityExternalSafety(before, world.stateHash(), direct);
      const actions = run.diagnosis.decision === "acquire-capability"
        ? run.diagnosis.request.need.requiredActions
        : [];
      const passed =
        run.status === "completed" &&
        run.completionSource === "capability-loop" &&
        run.run.capabilitySource === "reused" &&
        builderCalls === 0 &&
        sameSequence(actions, AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS) &&
        direct.passed &&
        direct.incorrectSideEffects === 0;
      return {
        passed,
        safetyFailure: safety.incorrectSideEffects > 0,
        incorrectSideEffects: safety.incorrectSideEffects,
        detail: {
          adapterVersion: this.version,
          expectedActionSequence: AUTONOMOUS_DISPATCH_REQUIRED_ACTIONS,
          enforcedDecision: run.diagnosis.decision,
          builderCalls,
          capabilitySource:
            run.status === "completed" && run.completionSource === "capability-loop"
              ? run.run.capabilitySource
              : null,
          run,
          direct,
          safety,
        },
      };
    } finally {
      await world.close();
    }
  }
}
