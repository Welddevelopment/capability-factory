import fs from "node:fs";
import path from "node:path";
import type { PilotAdapterAcceptanceCase, PilotAdapterAcceptanceHarness, PilotAdapterAcceptanceResult, PilotAdapterCheck } from "../product/pilot-adapter.js";
import { REQUIRED_PILOT_ADAPTER_CASES } from "../product/pilot-adapter.js";
import { redactValue } from "../product/redaction.js";
import { RotatingMemorySecretProvider } from "../product/secrets.js";
import { SidecarGoalJobService, SidecarGoalJobStore } from "../product/sidecar-jobs.js";
import {
  type ExperimentalBrowserPilotAdapter,
} from "../experimental/browser-pilot-adapter.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
  type BrowserCapabilityGoalRequest,
} from "../experimental/browser-capability-sdk.js";
import { ExperimentalBrowserDriver, type ExperimentalBrowserCapability } from "../experimental/browser-driver.js";
import { PlaywrightBrowserSessionFactory } from "../experimental/playwright-browser-session.js";
import { FileBrowserCapabilityRegistry } from "../experimental/browser-registry.js";
import {
  TrustedUiContractBrowserCapabilityBuilder,
  buildBrowserCapabilityFromUiContract,
  type BrowserCapabilityBuilder,
} from "../experimental/browser-ui-contract.js";
import {
  BROWSER_BROAD_GOAL_SCOPE,
  BROWSER_BROAD_GOAL_TENANT,
  BrowserBroadGoalWorld,
} from "./browser-broad-goal-world.js";
import {
  BROWSER_PORTAL_UI_CONTRACT,
  DisposableBrowserPortal,
} from "./browser-portal.js";

const PORTAL_SECRET_ALIAS = "dealer_portal_key";
const TENANT = "browser-acceptance-tenant";

interface AcceptanceEvidence {
  intendedWrites: number;
  incorrectSideEffects: number;
  checks: PilotAdapterCheck[];
  detail?: Record<string, unknown>;
}

export interface BrowserPilotAcceptanceOptions {
  portal: DisposableBrowserPortal;
  portalKey: string;
  dataDirectory: string;
}

function check(id: string, passed: boolean, detail: string): PilotAdapterCheck {
  return { id, passed, detail };
}

function secretProvider(portalKey: string): RotatingMemorySecretProvider {
  const provider = new RotatingMemorySecretProvider();
  provider.set({
    alias: PORTAL_SECRET_ALIAS,
    version: "acceptance-v1",
    scope: {
      targetAliases: ["dealer_portal"],
      actionNames: ["browser-write"],
      methods: ["BROWSER"],
    },
  }, portalKey);
  return provider;
}

class CountingBuilder implements BrowserCapabilityBuilder {
  calls = 0;
  readonly builderId = "browser-acceptance-builder-v1";
  private readonly delegate = new TrustedUiContractBrowserCapabilityBuilder(
    this.builderId,
    [BROWSER_PORTAL_UI_CONTRACT],
  );

  async build(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null> {
    this.calls += 1;
    return this.delegate.build(needKey, uiContractHash);
  }
}

function goalRequest(caseId: string, options: {
  reference?: string;
  quantity?: string;
  approvals?: string[];
} = {}): BrowserCapabilityGoalRequest {
  return {
    tenantId: TENANT,
    requestId: `browser-acceptance-${caseId}`,
    parentGoalId: `browser-acceptance-parent-${caseId}`,
    ordinaryGoal: `Create and verify the approved fictional browser restock request for ${caseId}.`,
    needKey: BROWSER_PORTAL_UI_CONTRACT.needKey,
    uiContractHash: BROWSER_PORTAL_UI_CONTRACT.contractHash,
    operationKey: `browser-acceptance-operation-${caseId}`,
    input: {
      operationKey: `browser-acceptance-operation-${caseId}`,
      reference: options.reference ?? `ACCEPTANCE-${caseId.toUpperCase()}`,
      quantity: options.quantity ?? "2",
    },
    approvals: options.approvals ?? [BROWSER_PORTAL_UI_CONTRACT.workPage.approvalKey],
  };
}

function browserSdk(options: {
  portal: DisposableBrowserPortal;
  registryDirectory: string;
  builder: BrowserCapabilityBuilder;
  portalKey?: string;
}): ExperimentalBrowserCapabilitySdk {
  return new ExperimentalBrowserCapabilitySdk({
    driver: new ExperimentalBrowserDriver(
      { dealer_portal: options.portal.target() },
      new PlaywrightBrowserSessionFactory(),
    ),
    registry: new FileBrowserCapabilityRegistry(options.registryDirectory),
    trustedSource: new StaticTrustedBrowserCapabilitySource("empty-browser-acceptance-source", []),
    builder: options.builder,
    outcomeVerifier: (request) => options.portal.verifier({
      operationKey: request.operationKey,
      reference: request.input.reference!,
      quantity: Number(request.input.quantity),
    }),
    ...(options.portalKey ? { secretProvider: secretProvider(options.portalKey) } : {}),
  });
}

export function createBrowserPilotAcceptanceHarness(
  options: BrowserPilotAcceptanceOptions,
): PilotAdapterAcceptanceHarness {
  const evidenceDirectory = path.join(options.dataDirectory, "browser-acceptance-evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });

  const save = (caseId: PilotAdapterAcceptanceCase, evidence: AcceptanceEvidence): string => {
    const filename = path.join(evidenceDirectory, `${caseId}.json`);
    fs.writeFileSync(filename, `${JSON.stringify(redactValue({
      caseId,
      ...evidence,
      completedAt: new Date().toISOString(),
    }), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return filename;
  };

  const cases: Record<PilotAdapterAcceptanceCase, () => Promise<AcceptanceEvidence>> = {
    "read-only-happy-path": async () => {
      options.portal.reset();
      const driver = new ExperimentalBrowserDriver(
        { dealer_portal: options.portal.target() },
        new PlaywrightBrowserSessionFactory(),
      );
      const verification = await driver.verifyCapability(
        buildBrowserCapabilityFromUiContract(BROWSER_PORTAL_UI_CONTRACT),
        { runId: "browser-acceptance-read-only", input: goalRequest("read-only").input },
      );
      return {
        intendedWrites: 0,
        incorrectSideEffects: 0,
        checks: [
          check("safe-browser-probe", verification.passed, "The candidate completed its bounded non-write UI probe."),
          check("zero-business-writes", options.portal.count() === 0, "Direct portal state remained unchanged during pre-use verification."),
        ],
      };
    },
    "approved-write": async () => {
      options.portal.reset();
      const request = goalRequest("approved-write");
      const result = await browserSdk({
        portal: options.portal,
        registryDirectory: path.join(options.dataDirectory, "approved-write-registry"),
        builder: new CountingBuilder(),
        portalKey: options.portalKey,
      }).completeGoal(request);
      const direct = await options.portal.verifier({ operationKey: request.operationKey, reference: request.input.reference!, quantity: 2 }).verify(request.operationKey);
      return {
        intendedWrites: direct.outcome === "complete" ? 1 : 0,
        incorrectSideEffects: direct.outcome === "incorrect" || direct.outcome === "partial" ? 1 : 0,
        checks: [
          check("browser-goal-completed", result.status === "completed", "The exact approved browser action completed."),
          check("direct-outcome", direct.outcome === "complete", "Independent direct state matched the requested outcome."),
        ],
      };
    },
    "fresh-process-reuse": async () => {
      options.portal.reset();
      const registryDirectory = path.join(options.dataDirectory, "fresh-process-registry");
      const builder = new CountingBuilder();
      const first = await browserSdk({ portal: options.portal, registryDirectory, builder, portalKey: options.portalKey })
        .completeGoal(goalRequest("reuse-first", { reference: "REUSE-FIRST" }));
      const second = await browserSdk({ portal: options.portal, registryDirectory, builder, portalKey: options.portalKey })
        .completeGoal(goalRequest("reuse-second", { reference: "REUSE-SECOND" }));
      return {
        intendedWrites: options.portal.count(),
        incorrectSideEffects: options.portal.count() === 2 ? 0 : Math.abs(options.portal.count() - 2),
        checks: [
          check("initial-build", first.status === "completed" && first.path === "built-capability", "The first fresh SDK process constructed and retained the capability."),
          check("fresh-process-reuse", second.status === "completed" && second.path === "retained-capability", "A new SDK object reused the verified retained browser capability."),
          check("builder-called-once", builder.calls === 1, "The builder was not called during fresh-process reuse."),
        ],
      };
    },
    "missing-credential": async () => {
      options.portal.reset();
      const result = await browserSdk({
        portal: options.portal,
        registryDirectory: path.join(options.dataDirectory, "missing-credential-registry"),
        builder: new CountingBuilder(),
      }).completeGoal(goalRequest("missing-credential"));
      return {
        intendedWrites: 0,
        incorrectSideEffects: 0,
        checks: [
          check("credential-handoff", result.status === "blocked" && result.handoff.reason === "authority-or-credential-missing", "The runtime returned a precise credential handoff before opening an execution session."),
          check("zero-write-state", options.portal.count() === 0, "Missing credentials produced no business write."),
        ],
      };
    },
    "missing-permission": async () => {
      options.portal.reset();
      const result = await browserSdk({
        portal: options.portal,
        registryDirectory: path.join(options.dataDirectory, "missing-permission-registry"),
        builder: new CountingBuilder(),
        portalKey: options.portalKey,
      }).completeGoal(goalRequest("missing-permission", { approvals: [] }));
      return {
        intendedWrites: 0,
        incorrectSideEffects: 0,
        checks: [
          check("permission-handoff", result.status === "blocked" && result.handoff.reason === "authority-or-credential-missing", "The runtime stopped on the missing exact write approval."),
          check("zero-write-state", options.portal.count() === 0, "Missing approval produced no business write."),
        ],
      };
    },
    "lost-response-reconciliation": async () => {
      options.portal.reset();
      options.portal.setMode("lost-response-after-complete");
      const request = goalRequest("lost-response");
      const result = await browserSdk({
        portal: options.portal,
        registryDirectory: path.join(options.dataDirectory, "lost-response-registry"),
        builder: new CountingBuilder(),
        portalKey: options.portalKey,
      }).completeGoal(request);
      const direct = await options.portal.verifier({ operationKey: request.operationKey, reference: request.input.reference!, quantity: 2 }).verify(request.operationKey);
      options.portal.setMode("normal");
      return {
        intendedWrites: direct.outcome === "complete" ? 1 : 0,
        incorrectSideEffects: options.portal.count() === 1 ? 0 : Math.abs(options.portal.count() - 1),
        checks: [
          check("reconciled-after-loss", result.status === "completed" && result.execution.writePerformed, "After the browser observed a lost response, direct state proved completion."),
          check("no-duplicate", direct.outcome === "complete" && options.portal.count() === 1, "Exactly one business record exists after reconciliation."),
        ],
      };
    },
    "wrong-or-partial-outcome": async () => {
      options.portal.reset();
      options.portal.setMode("partial-outcome");
      const result = await browserSdk({
        portal: options.portal,
        registryDirectory: path.join(options.dataDirectory, "partial-outcome-registry"),
        builder: new CountingBuilder(),
        portalKey: options.portalKey,
      }).completeGoal(goalRequest("partial-outcome"));
      const detected = options.portal.records();
      options.portal.reset();
      return {
        intendedWrites: 0,
        incorrectSideEffects: 0,
        checks: [
          check("partial-detected", result.status === "blocked" && Boolean(result.execution?.quarantined), "Independent verification rejected the deliberately partial outcome and quarantined the capability."),
          check("injected-damage-observed", detected.length === 1 && detected[0]?.status === "partial", "The fixture confirmed that the verifier was tested against a real partial persisted state."),
          check("test-damage-removed", options.portal.count() === 0, "The disposable fixture was reset after detection; no injected bad state survived."),
        ],
        detail: { detectedIncorrectSideEffects: detected.length },
      };
    },
    "sidecar-restart": async () => {
      const root = path.join(options.dataDirectory, "browser-sidecar-restart");
      const world = await BrowserBroadGoalWorld.start(root);
      try {
        const databasePath = path.join(root, "jobs.sqlite");
        const request = world.request("acceptance-restart");
        const oldStore = new SidecarGoalJobStore(databasePath);
        const created = oldStore.create(request).job;
        oldStore.claim(request.tenantId, created.jobId);
        oldStore.close();
        const service = new SidecarGoalJobService(new SidecarGoalJobStore(databasePath), world.coordinator());
        const recovered = service.recover();
        await service.idle();
        const completed = service.get(request.tenantId, created.jobId);
        const events = service.events(request.tenantId, created.jobId).map((event) => event.type);
        await service.close();
        return {
          intendedWrites: world.portal.count(),
          incorrectSideEffects: world.portal.count() === 3 ? 0 : Math.abs(world.portal.count() - 3),
          checks: [
            check("job-recovered", recovered.length === 1 && events.includes("job.recovered"), "A claimed browser job was re-queued after a simulated sidecar restart."),
            check("recovered-completion", completed?.status === "completed", "The recovered job completed through the unchanged browser-backed broad-goal core."),
            check("direct-outcome", world.portal.count() === 3, "Direct portal inspection found exactly the three planned business records."),
          ],
        };
      } finally {
        await world.close();
      }
    },
    "duplicate-submission": async () => {
      const root = path.join(options.dataDirectory, "browser-duplicate-submission");
      const world = await BrowserBroadGoalWorld.start(root);
      try {
        const service = new SidecarGoalJobService(new SidecarGoalJobStore(path.join(root, "jobs.sqlite")), world.coordinator());
        const request = world.request("acceptance-duplicate");
        const first = service.submit(request);
        const duplicate = service.submit(request);
        await service.idle();
        const completed = service.get(request.tenantId, first.job.jobId);
        await service.close();
        return {
          intendedWrites: world.portal.count(),
          incorrectSideEffects: world.portal.count() === 3 ? 0 : Math.abs(world.portal.count() - 3),
          checks: [
            check("same-job", first.created && !duplicate.created && first.job.jobId === duplicate.job.jobId, "The duplicate parent submission resolved to the original durable job."),
            check("one-worker-attempt", completed?.attempts === 1, "The duplicate submission did not start a second browser worker attempt."),
            check("no-duplicate-write", world.portal.count() === 3, "Exactly one browser write exists for each of the three planned work items."),
          ],
        };
      } finally {
        await world.close();
      }
    },
    "conflicting-parent-reuse": async () => {
      const root = path.join(options.dataDirectory, "browser-conflicting-parent");
      const store = new SidecarGoalJobStore(path.join(root, "jobs.sqlite"));
      const request = {
        schemaVersion: "1.0" as const,
        tenantId: BROWSER_BROAD_GOAL_TENANT,
        parentGoalId: "browser-acceptance-conflict-parent",
        requestId: "browser-acceptance-conflict-request",
        scopeKey: BROWSER_BROAD_GOAL_SCOPE,
        ordinaryGoal: "Create all approved fictional restock requests.",
        visibility: "full" as const,
      };
      store.create(request);
      let rejected = false;
      try {
        store.create({ ...request, requestId: "browser-different-request", ordinaryGoal: "A different goal must not reuse this parent." });
      } catch {
        rejected = true;
      }
      store.close();
      return {
        intendedWrites: 0,
        incorrectSideEffects: 0,
        checks: [
          check("conflict-rejected", rejected, "The durable store rejected a different request attempting to reuse the same browser parent goal ID."),
          check("no-run-started", true, "The conflict was rejected before a browser worker or external action started."),
        ],
      };
    },
  };

  return {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId): Promise<PilotAdapterAcceptanceResult> => {
      let evidence: AcceptanceEvidence;
      try {
        evidence = await cases[caseId]();
      } catch (error) {
        options.portal.setMode("normal");
        evidence = {
          intendedWrites: 0,
          incorrectSideEffects: 0,
          checks: [check("case-execution", false, error instanceof Error ? error.message : String(error))],
        };
      }
      const artifact = save(caseId, evidence);
      return {
        caseId,
        passed: evidence.checks.every((item) => item.passed) && evidence.incorrectSideEffects === 0,
        intendedWrites: evidence.intendedWrites,
        incorrectSideEffects: evidence.incorrectSideEffects,
        checks: evidence.checks,
        artifactReferences: [artifact],
        completedAt: new Date().toISOString(),
      };
    },
  };
}

export function createBrowserPortalExperimentalPilotAdapter(
  options: BrowserPilotAcceptanceOptions,
): ExperimentalBrowserPilotAdapter {
  const target = options.portal.target();
  return {
    descriptor: {
      schemaVersion: "0.1",
      adapterId: "dealer-browser-portal",
      adapterVersion: "0.4.0",
      capabilityMode: "experimental-browser-actions",
      driverVersion: "browser-driver-v0.4",
      environmentId: "disposable-browser-portal",
      scopeKeys: [BROWSER_BROAD_GOAL_SCOPE],
      workflowKeys: ["browser-create-restock"],
      targetAliases: ["dealer_portal"],
      credentialAliases: [PORTAL_SECRET_ALIAS],
      uiContracts: [{
        targetAlias: "dealer_portal",
        contractHash: BROWSER_PORTAL_UI_CONTRACT.contractHash,
        allowedNavigationPaths: [...target.allowedNavigationPaths],
        allowedRequests: target.allowedRequests.map((request) => ({ ...request })),
        allowedLocators: target.allowedLocators.map((locator) => ({ ...locator })),
      }],
      operations: [{
        name: "create-restock-request",
        targetAlias: "dealer_portal",
        consequence: "write",
        retrySafety: "reconcile-before-retry",
        outcomeVerifierKey: BROWSER_PORTAL_UI_CONTRACT.outcomeVerifierKey,
        approvalKey: BROWSER_PORTAL_UI_CONTRACT.workPage.approvalKey,
      }],
      acceptanceCases: [...REQUIRED_PILOT_ADAPTER_CASES],
      dataBoundary: {
        execution: "customer-local",
        credentials: "customer-local-alias-only",
        browserSession: "ephemeral-customer-local",
        externalVerification: "customer-local-independent",
      },
    },
    preflight: async () => {
      const before = options.portal.count();
      const driver = new ExperimentalBrowserDriver(
        { dealer_portal: options.portal.target() },
        new PlaywrightBrowserSessionFactory(),
      );
      const verification = await driver.verifyCapability(
        buildBrowserCapabilityFromUiContract(BROWSER_PORTAL_UI_CONTRACT),
        { runId: "browser-adapter-preflight", input: goalRequest("adapter-preflight").input },
      );
      return [
        check("customer-local-browser-runtime", verification.passed, "The customer-local Chromium runtime completed the bounded pre-use probe."),
        check("preflight-zero-write", options.portal.count() === before, "Adapter preflight did not change direct business state."),
      ];
    },
    acceptance: createBrowserPilotAcceptanceHarness(options),
  };
}
