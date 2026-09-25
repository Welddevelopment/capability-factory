import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BroadGoalCoordinatorSdk,
  FileValidatedGoalPlanStore,
  type BroadGoalRequest,
  type BroadGoalRuntimeResolver,
  type BroadGoalScopeResolver,
} from "../product/broad-goal-sdk.js";
import {
  GOAL_COORDINATION_SCHEMA_VERSION,
  type GoalPlanProposal,
  type GoalPlanner,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
  type ValidatedGoalWorkItem,
} from "../product/goal-coordination.js";
import { FileGoalCoordinationStore } from "../product/goal-scheduler.js";
import { HmacGoalContinuationAuthority } from "../product/continuation.js";
import { CustomerLocalOperationalControl } from "../product/operations.js";
import { RotatingMemorySecretProvider } from "../product/secrets.js";
import {
  createBrowserBroadGoalScheduler,
  type BrowserBroadGoalWorkflowBinding,
} from "../experimental/browser-broad-goal.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
} from "../experimental/browser-capability-sdk.js";
import { ExperimentalBrowserDriver } from "../experimental/browser-driver.js";
import { PlaywrightBrowserSessionFactory } from "../experimental/playwright-browser-session.js";
import { FileBrowserCapabilityRegistry } from "../experimental/browser-registry.js";
import { TrustedUiContractBrowserCapabilityBuilder } from "../experimental/browser-ui-contract.js";
import {
  BROWSER_PORTAL_UI_CONTRACT,
  BROWSER_PORTAL_UI_CONTRACT_HASH,
  DisposableBrowserPortal,
} from "./browser-portal.js";

export const BROWSER_BROAD_GOAL_TENANT = "browser-broad-tenant";
export const BROWSER_BROAD_GOAL_SCOPE = "browser-restock-scope";
export const BROWSER_BROAD_GOAL_ORDINARY_GOAL =
  "Create every approved dealer restock request due in this batch, verify each one, and continue the original inventory goal.";

const PORTAL_KEY = "local-browser-broad-goal-secret";
const WORK_ITEMS = [
  { key: "restock-coolant", reference: "RESTOCK-COOLANT", quantity: "3" },
  { key: "restock-labels", reference: "RESTOCK-LABELS", quantity: "5" },
  { key: "restock-crates", reference: "RESTOCK-CRATES", quantity: "2" },
] as const;

function proposal(): GoalPlanProposal {
  return {
    schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
    deadlineKey: "browser-batch-deadline",
    summary: "Create and independently verify each approved dealer restock request in conservative sequence.",
    workItems: WORK_ITEMS.map((item) => ({
      key: item.key,
      groupKey: "dealer-restock-batch",
      groupLabel: "Dealer restock batch",
      summary: `Create and verify ${item.reference}.`,
      coverageKeys: [`coverage-${item.key}`],
      entityAliases: [item.key],
      workflowKey: "browser-create-restock",
      requiredActions: ["create-restock-request"],
      targetAliases: ["dealer_portal"],
      completionCriterionKeys: [`complete-${item.key}`],
      dependsOnKeys: [],
    })),
  };
}

class BrowserBroadGoalPlanner implements GoalPlanner {
  async propose(): Promise<GoalPlanProposal> {
    return proposal();
  }
}

function scopeFor(request: BroadGoalRequest, writeAuthorized = true): TrustedGoalScope {
  return {
    tenantId: request.tenantId,
    parentGoalId: request.parentGoalId,
    requestId: request.requestId,
    ordinaryGoal: request.ordinaryGoal,
    deadline: { key: "browser-batch-deadline", description: "The approved fictional local browser batch deadline." },
    entities: WORK_ITEMS.map((item) => ({ alias: item.key, kind: "restock-request", systemAliases: ["dealer_portal"] })),
    systems: [{
      targetAlias: "dealer_portal",
      credentialAliases: ["dealer_portal_key"],
      operations: [{ name: "create-restock-request", method: "POST" }],
    }],
    completionCriteria: WORK_ITEMS.map((item) => ({
      key: `complete-${item.key}`,
      summary: `Directly verify exactly one correct ${item.reference} record.`,
      verifierKey: "dealer-portal-direct-db-v1",
    })),
    requiredCoverage: WORK_ITEMS.map((item) => ({
      key: `coverage-${item.key}`,
      entityAliases: [item.key],
      workflowKey: "browser-create-restock",
      requiredActions: ["create-restock-request"],
      targetAliases: ["dealer_portal"],
      completionCriterionKeys: [`complete-${item.key}`],
    })),
    authority: {
      allowedTargetAliases: ["dealer_portal"],
      allowedSecretAliases: ["dealer_portal_key"],
      allowedMethods: ["POST"],
      writeAuthority: "per-action-approval",
      approvedWriteActions: writeAuthorized ? ["create-restock-request"] : [],
    },
  };
}

function itemDefinition(item: ValidatedGoalWorkItem) {
  const found = WORK_ITEMS.find((candidate) => candidate.key === item.key);
  if (!found) throw new Error(`Unknown browser broad-goal work item: ${item.key}`);
  return found;
}

export class BrowserBroadGoalWorld {
  readonly portal: DisposableBrowserPortal;
  readonly secrets = new RotatingMemorySecretProvider();
  readonly operations: CustomerLocalOperationalControl;
  readonly continuationAuthority = new HmacGoalContinuationAuthority(
    "browser-broad-goal-continuation-v1",
    "browser-broad-goal-local-continuation-secret-v1",
  );
  private readonly browserSdk: ExperimentalBrowserCapabilitySdk;
  private readonly bindings: BrowserBroadGoalWorkflowBinding[];
  private writeAuthorized = true;

  private constructor(readonly directory: string, portal: DisposableBrowserPortal) {
    this.portal = portal;
    this.operations = new CustomerLocalOperationalControl(
      path.join(directory, "operations.sqlite"),
      BROWSER_BROAD_GOAL_TENANT,
      { maxWriteAttemptsPerRun: 1, maxWriteAttemptsPerHour: 100, maxModelSpendUsdPerDay: 1 },
    );
    this.secrets.set({
      alias: "dealer_portal_key",
      version: "local-v1",
      scope: {
        targetAliases: ["dealer_portal"],
        actionNames: ["browser-write"],
        methods: ["BROWSER"],
      },
    }, PORTAL_KEY);
    this.browserSdk = new ExperimentalBrowserCapabilitySdk({
      driver: new ExperimentalBrowserDriver(
        { dealer_portal: portal.target() },
        new PlaywrightBrowserSessionFactory(),
      ),
      registry: new FileBrowserCapabilityRegistry(path.join(directory, "browser-registry")),
      trustedSource: new StaticTrustedBrowserCapabilitySource("empty-browser-catalog-v1", []),
      builder: new TrustedUiContractBrowserCapabilityBuilder(
        "browser-ui-contract-builder-v1",
        [BROWSER_PORTAL_UI_CONTRACT],
      ),
      outcomeVerifier: (request) => portal.verifier({
        operationKey: request.operationKey,
        reference: request.input.reference!,
        quantity: Number(request.input.quantity),
      }),
      secretProvider: this.secrets,
      operationalControl: this.operations,
    });
    this.bindings = [{
      workflowKey: "browser-create-restock",
      needKey: "create-dealer-restock-request",
      uiContractHash: BROWSER_PORTAL_UI_CONTRACT_HASH,
      approvalKey: "create-restock-request",
      input: (_plan, item) => {
        const definition = itemDefinition(item);
        return {
          operationKey: item.operationKey,
          reference: definition.reference,
          quantity: definition.quantity,
        };
      },
      outcomeVerifier: (_plan, item) => {
        const definition = itemDefinition(item);
        return portal.verifier({
          operationKey: item.operationKey,
          reference: definition.reference,
          quantity: Number(definition.quantity),
        });
      },
    }];
  }

  static async start(directory: string): Promise<BrowserBroadGoalWorld> {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const portal = new DisposableBrowserPortal(path.join(directory, "portal.sqlite"), PORTAL_KEY);
    await portal.start();
    return new BrowserBroadGoalWorld(directory, portal);
  }

  setWriteAuthority(authorized: boolean): void {
    this.writeAuthorized = authorized;
  }

  request(suffix: string): BroadGoalRequest {
    return {
      schemaVersion: "1.0",
      tenantId: BROWSER_BROAD_GOAL_TENANT,
      parentGoalId: `browser-parent-${suffix}`,
      requestId: `browser-request-${suffix}`,
      scopeKey: BROWSER_BROAD_GOAL_SCOPE,
      ordinaryGoal: BROWSER_BROAD_GOAL_ORDINARY_GOAL,
      visibility: "full",
    };
  }

  coordinator(): BroadGoalCoordinatorSdk {
    const scopes: BroadGoalScopeResolver = {
      resolve: async (request) => request.scopeKey === BROWSER_BROAD_GOAL_SCOPE
        ? scopeFor(request, this.writeAuthorized)
        : undefined,
    };
    const runtimes: BroadGoalRuntimeResolver = {
      open: async (_scope: TrustedGoalScope, _plan: ValidatedGoalPlan) => ({
        runner: createBrowserBroadGoalScheduler({
          sdk: this.browserSdk,
          bindings: this.bindings,
          store: new FileGoalCoordinationStore(path.join(this.directory, "coordination")),
          aggregateEvidence: async (plan, state) => {
            const expected = plan.workItems.length;
            const actual = this.portal.count();
            const passed = actual === expected && Object.values(state.items).every((item) => item.lifecycle === "completed");
            return {
              passed,
              incorrectSideEffects: actual > expected ? actual - expected : 0,
              stateDigest: createHash("sha256").update(`${actual}/${expected}`).digest("hex"),
              checks: [{
                id: "browser-aggregate-row-count",
                passed,
                detail: `The direct portal database contains ${actual}/${expected} expected browser writes.`,
              }],
            };
          },
          continuationAuthority: this.continuationAuthority,
        }),
      }),
    };
    return new BroadGoalCoordinatorSdk({
      planner: new BrowserBroadGoalPlanner(),
      scopes,
      runtimes,
      plans: new FileValidatedGoalPlanStore(path.join(this.directory, "plans")),
      maxPlanningAttempts: 1,
    });
  }

  registryRecords() {
    return new FileBrowserCapabilityRegistry(path.join(this.directory, "browser-registry")).list(BROWSER_BROAD_GOAL_TENANT);
  }

  async close(): Promise<void> {
    this.operations.close();
    await this.portal.close();
  }
}
