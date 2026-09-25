import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MODE_SCHEMA_VERSION,
  type CapabilityMode,
  type CapabilityModeDescriptor,
  type CapabilityModeEnvelope,
} from "../src/product/capability-mode-contract.js";
import {
  CapabilityModeJobService,
  CapabilityModeJobStore,
} from "../src/product/capability-mode-jobs.js";
import {
  CapabilityModeRouter,
  type CapabilityModeRunner,
} from "../src/product/capability-mode-router.js";
import { createCapabilitySidecar } from "../src/product/sidecar.js";

const token = "test-capability-mode-sidecar-token";
const digest = "a".repeat(64);

const descriptors: CapabilityModeDescriptor[] = [
  {
    capabilityMode: "constrained-http-api",
    label: "HTTP",
    driverVersion: "http-test-v1",
    maturity: "working-local-pilot-mvp",
    configured: true,
    claimBoundary: "Local HTTP pilot test boundary.",
  },
  {
    capabilityMode: "experimental-browser-actions",
    label: "Browser",
    driverVersion: "browser-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local browser experiment boundary.",
  },
  {
    capabilityMode: "experimental-file-transfer-actions",
    label: "File",
    driverVersion: "file-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local file experiment boundary.",
  },
  {
    capabilityMode: "experimental-inbox-message-actions",
    label: "Inbox",
    driverVersion: "inbox-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local inbox experiment boundary.",
  },
  {
    capabilityMode: "experimental-document-actions",
    label: "Document",
    driverVersion: "document-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local document experiment boundary.",
  },
  {
    capabilityMode: "experimental-database-actions",
    label: "Database",
    driverVersion: "database-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local reviewed-database-operation experiment boundary.",
  },
  {
    capabilityMode: "experimental-trusted-tool-actions",
    label: "Trusted tool",
    driverVersion: "trusted-tool-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local import-free WebAssembly experiment boundary.",
  },
  {
    capabilityMode: "experimental-agent-delegation-actions",
    label: "Agent delegation",
    driverVersion: "agent-delegation-test-v1",
    maturity: "experimental-local",
    configured: true,
    claimBoundary: "Local signed agent-delegation experiment boundary.",
  },
];

function envelope(mode: CapabilityMode, parentGoalId: string, tenantId = "tenant-a"): CapabilityModeEnvelope {
  const common = {
    tenantId,
    parentGoalId,
    requestId: `request-${parentGoalId}`,
    ordinaryGoal: "Complete the bounded fictional workflow and verify the external outcome.",
  };
  if (mode === "constrained-http-api") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        schemaVersion: "1.0",
        ...common,
        scopeKey: "test-scope",
        visibility: "summary",
      },
    };
  }
  if (mode === "experimental-browser-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "submit-approved-record",
        uiContractHash: digest,
        operationKey: "submit-record-1",
        input: { recordId: "record-1" },
        approvals: ["submit-approved-record"],
      },
    };
  }
  if (mode === "experimental-file-transfer-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "import-approved-order",
        contractHash: digest,
        operationKey: "import-file-1",
        inputFileAlias: "trusted-inbox",
        expectedInputSha256: digest,
        approvals: ["import-approved-order"],
      },
    };
  }
  if (mode === "experimental-inbox-message-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "convert-approved-message",
        contractHash: digest,
        operationKey: "convert-message-1",
        inputMessageAlias: "trusted-message",
        expectedMessageSha256: digest,
        approvals: ["convert-approved-message"],
      },
    };
  }
  if (mode === "experimental-database-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "write-approved-record",
        contractHash: digest,
        operationKey: "database-operation-1",
        input: { recordId: "record-1" },
        approvals: ["write-approved-record"],
      },
    };
  }
  if (mode === "experimental-trusted-tool-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "compute-approved-result",
        contractHash: digest,
        operationKey: "compute-result-1",
        toolId: "bounded-tool",
        toolVersion: "1.0.0",
        values: [20, 22],
        approvals: ["compute-approved-result"],
      },
    };
  }
  if (mode === "experimental-agent-delegation-actions") {
    return {
      schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
      capabilityMode: mode,
      request: {
        ...common,
        needKey: "delegate-approved-task",
        contractHash: digest,
        operationKey: "delegate-task-1",
        delegateId: "delegate-one",
        delegateVersion: "1_0_0",
        taskKey: "task-one",
        input: { recordId: "record-1" },
        approvals: ["delegate-approved-task"],
      },
    };
  }
  return {
    schemaVersion: CAPABILITY_MODE_SCHEMA_VERSION,
    capabilityMode: mode,
    request: {
      ...common,
      needKey: "convert-approved-document",
      contractHash: digest,
      operationKey: "convert-document-1",
      inputDocumentAlias: "trusted-document",
      expectedDocumentSha256: digest,
      approvals: ["convert-approved-document"],
    },
  };
}

function runner(descriptor: CapabilityModeDescriptor, seen: CapabilityMode[]): CapabilityModeRunner {
  return {
    descriptor,
    async run(value) {
      seen.push(value.capabilityMode);
      return {
        capabilityMode: value.capabilityMode,
        status: "completed",
        parentResumed: true,
        parentCompleted: true,
        summary: `${value.capabilityMode} completed inside its separate test driver.`,
        acquisitionPath: "built-capability",
        capabilityId: `${value.capabilityMode}-capability`,
      };
    },
  };
}

describe("customer-local capability-mode boundary", () => {
  it("routes all five explicit modes durably without merging their maturity or evidence labels", async () => {
    const seen: CapabilityMode[] = [];
    const router = new CapabilityModeRouter(descriptors.map((item) => runner(item, seen)));
    const jobs = new CapabilityModeJobService(new CapabilityModeJobStore(":memory:"), router);
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: token,
      capabilityModeJobs: jobs,
    });
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/v1/capability-modes" });
      expect(unauthorized.statusCode).toBe(401);
      const registry = await app.inject({
        method: "GET",
        url: "/v1/capability-modes",
        headers: { "x-capability-sidecar-token": token },
      });
      expect(registry.statusCode).toBe(200);
      expect(registry.json()).toMatchObject({ selection: "trusted-explicit", inference: false });
      expect(registry.json().modes).toHaveLength(8);
      expect(registry.json().modes.filter((item: CapabilityModeDescriptor) => item.maturity === "working-local-pilot-mvp")).toHaveLength(1);

      for (const [index, item] of descriptors.entries()) {
        const submitted = await app.inject({
          method: "POST",
          url: "/v1/capability-mode-jobs",
          headers: { "x-capability-sidecar-token": token },
          payload: envelope(item.capabilityMode, `goal-${index}`),
        });
        expect(submitted.statusCode).toBe(202);
      }
      await jobs.idle();
      expect(seen.sort()).toEqual(descriptors.map((item) => item.capabilityMode).sort());

      const first = jobs.get("tenant-a", jobs.submit(envelope("constrained-http-api", "goal-0")).job.jobId);
      expect(first).toMatchObject({
        capabilityMode: "constrained-http-api",
        status: "completed",
        result: { parentCompleted: true, parentResumed: true },
      });
      expect(jobs.events("tenant-a", first!.jobId).map((event) => event.type)).toEqual([
        "mode-job.queued",
        "mode-job.started",
        "mode-job.finished",
      ]);
      expect(jobs.get("tenant-b", first!.jobId)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("fails closed on unknown fields, mode-payload confusion, and parent-goal mode changes", async () => {
    const router = new CapabilityModeRouter(descriptors.map((item) => runner(item, [])));
    const jobs = new CapabilityModeJobService(new CapabilityModeJobStore(":memory:"), router);
    const app = createCapabilitySidecar(undefined, { resolve: () => undefined }, {
      accessToken: token,
      capabilityModeJobs: jobs,
    });
    try {
      const browser = envelope("experimental-browser-actions", "same-parent");
      const first = await app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: browser,
      });
      expect(first.statusCode).toBe(202);

      const changedMode = await app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: envelope("experimental-document-actions", "same-parent"),
      });
      expect(changedMode.statusCode).toBe(409);
      expect(changedMode.json().error).toMatch(/different request or capability mode/);

      const confused = {
        ...browser,
        capabilityMode: "experimental-document-actions",
      };
      const confusedResponse = await app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: confused,
      });
      expect(confusedResponse.statusCode).toBe(409);

      const unknownField = {
        ...envelope("experimental-file-transfer-actions", "unknown-field"),
        routeAutomatically: true,
      };
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/capability-mode-jobs",
        headers: { "x-capability-sidecar-token": token },
        payload: unknownField,
      });
      expect(rejected.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("recovers a running job through the same immutable mode after a fresh process opens the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-mode-recovery-"));
    const databasePath = join(directory, "mode-jobs.sqlite");
    try {
      const initialStore = new CapabilityModeJobStore(databasePath);
      const created = initialStore.create(envelope("experimental-file-transfer-actions", "restart-goal"));
      initialStore.claim("tenant-a", created.job.jobId);
      initialStore.close();

      const seen: CapabilityMode[] = [];
      const recoveredStore = new CapabilityModeJobStore(databasePath);
      const service = new CapabilityModeJobService(
        recoveredStore,
        new CapabilityModeRouter(descriptors.map((item) => runner(item, seen))),
      );
      service.recover();
      await service.idle();
      expect(service.get("tenant-a", created.job.jobId)).toMatchObject({
        capabilityMode: "experimental-file-transfer-actions",
        status: "completed",
        attempts: 2,
      });
      expect(seen).toEqual(["experimental-file-transfer-actions"]);
      await service.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
